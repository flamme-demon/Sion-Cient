//! System-audio capture — screen-share-audio path that bypasses Chromium's
//! native system-audio loopback so we can exclude Sion's own voice-chat
//! output from the captured stream (avoids echo when the user isn't wearing
//! headphones).
//!
//! Linux path (`linux_impl`): creates a hidden virtual sink
//! (`media.class=Audio/Sink/Internal`), links every non-Sion sink-input
//! into it via `pw-link`, then captures *its* monitor with `parec`. Sion's
//! own output stays linked only to the user's real Speaker, so it reaches
//! the hardware (the sharer still hears the call) but never enters the
//! capture stream. Same pattern as the OBS `pipewire-audio-capture`
//! plugin's "capture all except" mode. Falls back to the default sink's
//! monitor (echo-prone) if the virtual sink can't be created — keeps the
//! feature working on hosts where pactl/pipewire-pulse is unavailable.
//!
//! Windows path (`windows_impl`): WASAPI loopback with
//! `AUDCLNT_PROCESSLOOPBACK_EXCLUDE` (Windows 10 build 20348+ / Windows 11).
//! Falls back to a plain loopback (echo-prone) on older builds, with a
//! console log only — no user-facing warning per product decision.
//!
//! macOS keeps the Chromium `systemAudio: "include"` path — its tap is
//! session-scoped and doesn't exhibit the WASAPI-loopback echo problem.
//!
//! Both platforms stream the same PCM frame format (float32le stereo 48 kHz,
//! 20 ms frames) over a local WebSocket. The JS side (`systemAudioService.ts`)
//! is platform-agnostic: it receives frames and injects them into a
//! MediaStreamTrackGenerator, then LiveKit publishes the track as
//! ScreenShareAudio alongside the video share.

// ============================================================================
// Cross-platform public commands. Each dispatches to the appropriate
// platform module; unsupported platforms return sentinel values that the
// JS side knows to treat as "no capture available".
// ============================================================================

#[tauri::command]
pub fn system_audio_start(sink_monitor: Option<String>) -> Result<u16, String> {
    #[cfg(target_os = "linux")]
    {
        log::info!("[Sion][sysaudio] system_audio_start on linux");
        linux_impl::start(sink_monitor)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = sink_monitor;
        log::info!("[Sion][sysaudio] system_audio_start on windows");
        windows_impl::start()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = sink_monitor;
        Err("system_audio: unsupported platform (Linux and Windows only)".to_string())
    }
}

#[tauri::command]
pub fn system_audio_stop() {
    #[cfg(target_os = "linux")]
    {
        log::info!("[Sion][sysaudio] system_audio_stop on linux");
        linux_impl::stop();
    }
    #[cfg(target_os = "windows")]
    {
        log::info!("[Sion][sysaudio] system_audio_stop on windows");
        windows_impl::stop();
    }
}

#[tauri::command]
pub fn system_audio_ws_port() -> u16 {
    #[cfg(target_os = "linux")]
    {
        linux_impl::ws_port()
    }
    #[cfg(target_os = "windows")]
    {
        windows_impl::ws_port()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        0
    }
}

#[tauri::command]
pub fn system_audio_list_sinks() -> Vec<(String, String)> {
    #[cfg(target_os = "linux")]
    {
        linux_impl::list_sinks()
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Windows/macOS: the concept of "which sink monitor to capture" has
        // no user-surfaced choice today — Windows captures the default
        // render endpoint, macOS doesn't use this module. An empty list
        // makes the JS side hide the picker.
        Vec::new()
    }
}

// ============================================================================
// Shared constants — platform impls publish frames in this format so the
// WebSocket consumer on the JS side doesn't need platform awareness.
// ============================================================================

#[allow(dead_code)] // used by both platform modules
const SAMPLE_RATE: u32 = 48000;
#[allow(dead_code)]
const CHANNELS: u32 = 2;
/// 20 ms @ 48 kHz stereo f32 = 960 samples × 4 bytes × 2 ch = 7680 bytes.
/// Small enough to keep WebSocket head-of-line blocking low and matches the
/// JS-side AudioWorklet render-quantum granularity (20 ms ≈ 7.5 quanta).
#[allow(dead_code)]
const FRAME_BYTES: usize = 7680;

// ============================================================================
// Linux implementation. Strategy: hidden null-sink + per-app pw-link, then
// `parec` on the null-sink's monitor. Excludes Sion from capture without
// muting it on the real output.
// ============================================================================

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::{CHANNELS, FRAME_BYTES, SAMPLE_RATE};
    use std::collections::HashSet;
    use std::io::Read;
    use std::net::TcpListener;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tungstenite::Message;

    /// Binary name used to identify Sion's own audio streams when filtering
    /// sink-inputs out of the capture. All CEF child processes (browser,
    /// renderer, GPU, utility/audio service) inherit the launcher's argv[0]
    /// via `/proc/self/exe`, so a single binary-name match catches every
    /// audio-emitting process — including the one service that actually owns
    /// the `sink-input` (`--type=utility --utility-sub-type=audio.mojom.AudioService`).
    const SION_BINARY_NAME: &str = "sion-client";

    /// Name of the hidden virtual sink we create for screen-share capture.
    /// `Audio/Sink/Internal` keeps it out of pavucontrol/KDE mixer so the
    /// user can't accidentally route an app to it. Single instance —
    /// re-create on each capture so a stale one from a previous crash
    /// doesn't survive across runs.
    const VIRTUAL_SINK_NAME: &str = "sion_capture";

    #[derive(Clone, Debug)]
    struct ParsedSinkInput {
        binary: String,
        node_name: String,
        /// PipeWire node `object.id` — unique even when several sink-inputs
        /// share the same `node.name` (Firefox creates one node per tab/
        /// content engine, all named "Firefox"; only `object.id` lets us
        /// distinguish them). Also what we pass to `pw-link` so it
        /// connects the right node when names collide.
        object_id: u32,
    }

    static PORT: AtomicU16 = AtomicU16::new(0);
    static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

    /// Module ID returned by `pactl load-module`. Held so `stop()` can
    /// `unload-module <id>` cleanly — that one call destroys both the sink
    /// and every link we added to it, no per-link cleanup needed.
    static VIRTUAL_SINK_MODULE_ID: std::sync::LazyLock<Mutex<Option<u32>>> =
        std::sync::LazyLock::new(|| Mutex::new(None));

    /// Tracks which non-Sion PipeWire nodes (by `object.id`) we've already
    /// logged a link for. The polling watcher re-issues `pw-link` every
    /// 500 ms unconditionally (pw-link is a no-op on duplicate links), but
    /// we only log on first sighting so the journal isn't flooded.
    static LINKED_NODES: std::sync::LazyLock<Mutex<HashSet<u32>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

    static LINK_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

    struct Senders(Vec<std::sync::mpsc::Sender<Vec<u8>>>);

    static WS_SENDERS: std::sync::LazyLock<Mutex<Senders>> =
        std::sync::LazyLock::new(|| Mutex::new(Senders(Vec::new())));

    // The live `parec` child. Held in an Arc<Mutex<…>> so the capture thread
    // can pull it to drop (kill) the process when we stop, without requiring
    // the main thread to do the cleanup synchronously.
    static CURRENT_CHILD: std::sync::LazyLock<Mutex<Option<Arc<Mutex<Option<Child>>>>>> =
        std::sync::LazyLock::new(|| Mutex::new(None));

    // Volume to restore when the capture stops. Some desktop audio tools (or
    // KDE's own mixer) leave the sink-monitor source attenuated — e.g. at 8 %
    // / -66 dB — which makes parec faithfully record a signal that's already
    // been silenced by the server. We detect that, bump to 100 % for the
    // duration of the share, and put the original level back on stop so the
    // user doesn't notice anything on subsequent app audio.
    static VOLUME_RESTORE: std::sync::LazyLock<Mutex<Option<(String, u32)>>> =
        std::sync::LazyLock::new(|| Mutex::new(None));

    fn get_source_volume_pct(name: &str) -> Option<u32> {
        let out = Command::new("pactl")
            .args(["get-source-volume", name])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        // "Volume: front-left: 65536 / 100% / 0.00 dB, front-right: ..."
        // Find the first "%" and grab the integer directly to its left.
        let pct_idx = s.find('%')?;
        let prefix = &s[..pct_idx];
        // Scan backwards for a contiguous run of ASCII digits.
        let digit_end = prefix
            .rfind(|c: char| c.is_ascii_digit())
            .map(|i| i + 1)?;
        let digit_start = prefix[..digit_end]
            .rfind(|c: char| !c.is_ascii_digit())
            .map(|i| i + 1)
            .unwrap_or(0);
        prefix[digit_start..digit_end].parse::<u32>().ok()
    }

    fn set_source_volume_pct(name: &str, pct: u32) -> bool {
        Command::new("pactl")
            .args(["set-source-volume", name, &format!("{pct}%")])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn boost_monitor_volume(device: &str) {
        let Some(pct) = get_source_volume_pct(device) else {
            return;
        };
        if pct >= 100 {
            return;
        }
        log::info!(
            "[Sion][sysaudio] monitor '{device}' at {pct}% — boosting to 100% for capture"
        );
        if set_source_volume_pct(device, 100) {
            *VOLUME_RESTORE.lock().unwrap() = Some((device.to_string(), pct));
        }
    }

    fn restore_monitor_volume() {
        if let Some((name, pct)) = VOLUME_RESTORE.lock().unwrap().take() {
            log::info!("[Sion][sysaudio] restoring monitor '{name}' to {pct}%");
            set_source_volume_pct(&name, pct);
        }
    }

    /// Parse `pactl list sink-inputs` text. We only need two fields per
    /// input: `application.process.binary` (to identify Sion) and
    /// `node.name` (the handle pw-link needs). JSON output of pactl exists
    /// but the format is heavily nested for sink-inputs and the existing
    /// `extract_json_field` helper isn't recursive — text parsing is just
    /// as reliable here.
    fn list_pa_sink_inputs() -> Vec<ParsedSinkInput> {
        let out = match Command::new("pactl").args(["list", "sink-inputs"]).output() {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut result = Vec::new();
        let mut binary: Option<String> = None;
        let mut node_name: Option<String> = None;
        let mut object_id: Option<u32> = None;

        let flush = |bin: &mut Option<String>,
                     node: &mut Option<String>,
                     oid: &mut Option<u32>,
                     acc: &mut Vec<ParsedSinkInput>| {
            // Need all three to identify and link a node. node.name alone
            // can collide (Firefox has one node per tab); we key the link
            // and dedup off object.id, which is unique server-side.
            if let (Some(b), Some(n), Some(id)) = (bin.take(), node.take(), oid.take()) {
                acc.push(ParsedSinkInput { binary: b, node_name: n, object_id: id });
            } else {
                bin.take();
                node.take();
                oid.take();
            }
        };

        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("Sink Input #") {
                flush(&mut binary, &mut node_name, &mut object_id, &mut result);
            } else if let Some(rest) = trimmed.strip_prefix("application.process.binary = \"") {
                if let Some(end) = rest.rfind('"') {
                    binary = Some(rest[..end].to_string());
                }
            } else if let Some(rest) = trimmed.strip_prefix("node.name = \"") {
                if let Some(end) = rest.rfind('"') {
                    node_name = Some(rest[..end].to_string());
                }
            } else if let Some(rest) = trimmed.strip_prefix("object.id = \"") {
                if let Some(end) = rest.rfind('"') {
                    object_id = rest[..end].parse::<u32>().ok();
                }
            }
        }
        flush(&mut binary, &mut node_name, &mut object_id, &mut result);
        result
    }

    /// Best-effort sanity unload of a leftover virtual sink from a previous
    /// crashed run. `pactl unload-module` accepts a module name OR id; using
    /// the name here means we don't need to track ids across processes.
    /// Silent failure is fine — most of the time there's nothing to clean.
    fn unload_existing_virtual_sink() {
        // Find module ids whose first arg contains our sink name. `pactl
        // list short modules` prints `id\tname\targs…`. We grep ourselves
        // rather than shelling out to grep.
        let Ok(out) = Command::new("pactl").args(["list", "short", "modules"]).output() else {
            return;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if !line.contains("module-null-sink") {
                continue;
            }
            if !line.contains(&format!("sink_name={VIRTUAL_SINK_NAME}")) {
                continue;
            }
            let id = line.split_whitespace().next().unwrap_or("");
            if id.is_empty() {
                continue;
            }
            log::info!("[Sion][sysaudio] unloading leftover virtual sink module #{id}");
            let _ = Command::new("pactl").args(["unload-module", id]).status();
        }
    }

    fn create_virtual_sink() -> Option<u32> {
        unload_existing_virtual_sink();
        let out = Command::new("pactl")
            .args([
                "load-module",
                "module-null-sink",
                &format!("sink_name={VIRTUAL_SINK_NAME}"),
                // We deliberately use the default `Audio/Sink` media.class
                // (no `/Internal` suffix) — the latter would hide the
                // monitor source from PulseAudio entirely, which silently
                // breaks `parec --device=sion_capture.monitor`: parec
                // can't find the source, falls back to the default mic,
                // and times out after 30 s on a muted mic. Tradeoff:
                // the sink shows up in pavucontrol — the explicit
                // `node.description` makes its purpose clear and users
                // are unlikely to route apps into it on purpose.
                // `node.always-process=true` + `suspend-timeout-seconds=0`
                // keep the node alive when no audio flows.
                "sink_properties=media.class=Audio/Sink node.always-process=true session.suspend-timeout-seconds=0 node.description=\"Sion screen-share capture\"",
                "rate=48000",
                "channels=2",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            log::warn!(
                "[Sion][sysaudio] virtual sink creation failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return None;
        }
        let id_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
        match id_str.parse::<u32>() {
            Ok(id) => {
                log::info!("[Sion][sysaudio] created virtual sink module #{id} ({VIRTUAL_SINK_NAME})");
                Some(id)
            }
            Err(_) => {
                log::warn!(
                    "[Sion][sysaudio] pactl load-module returned unparseable id: '{id_str}'"
                );
                None
            }
        }
    }

    fn destroy_virtual_sink() {
        let id_opt = VIRTUAL_SINK_MODULE_ID.lock().unwrap().take();
        if let Some(id) = id_opt {
            log::info!("[Sion][sysaudio] unloading virtual sink module #{id}");
            let _ = Command::new("pactl")
                .args(["unload-module", &id.to_string()])
                .status();
        }
        LINKED_NODES.lock().unwrap().clear();
    }

    /// Wire one node's stereo (or mono) outputs into our virtual sink.
    /// Different applications expose different port names — Chromium uses
    /// `output_FL/FR`, some pipewire-pulse clients use `monitor_FL/FR`,
    /// mono apps have `output_MONO`. We try them all; `pw-link` exits
    /// non-zero when the port doesn't exist OR the link already exists,
    /// which is fine — at least one combination will succeed for any real
    /// audio source. We address ports by `node.name`, NOT `object.id`:
    /// `pw-link` parses the part before `:` as a node *name*, so a numeric
    /// id never resolves and every link silently fails. Using the name is
    /// also correct for apps with several nodes of the same name (Firefox =
    /// one node per tab): pw-link links the matching port on *every* node
    /// sharing that name, so all tabs reach the capture sink.
    fn link_node_to_virtual_sink(node_name: &str) {
        const ATTEMPTS: &[(&str, &str)] = &[
            ("output_FL", "playback_FL"),
            ("output_FR", "playback_FR"),
            ("monitor_FL", "playback_FL"),
            ("monitor_FR", "playback_FR"),
            ("output_MONO", "playback_FL"),
            ("output_MONO", "playback_FR"),
        ];
        for (out_port, in_port) in ATTEMPTS {
            let from = format!("{node_name}:{out_port}");
            let to = format!("{VIRTUAL_SINK_NAME}:{in_port}");
            let _ = Command::new("pw-link")
                .args([&from, &to])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    /// Re-scan sink-inputs and re-issue `pw-link` for every non-Sion node
    /// each tick. `pw-link` is a no-op on duplicate links (returns
    /// non-zero, harmless), so retrying is cheap and recovers from any
    /// silent failure on first attempt (race with node port enumeration).
    /// We only log on first sighting per `object.id` to keep the journal
    /// readable — `object.id` is unique server-side, whereas `node.name`
    /// collides across multiple sink-inputs of the same app (Firefox = one
    /// node per tab, all named "Firefox"). The link itself is issued by
    /// `node.name` (see `link_node_to_virtual_sink`), which covers every
    /// node sharing that name in one call; the per-`object.id` dedup here
    /// only governs logging.
    fn refresh_sink_input_links() {
        let inputs = list_pa_sink_inputs();
        let mut already_seen = LINKED_NODES.lock().unwrap();
        for input in &inputs {
            if input.binary == SION_BINARY_NAME {
                continue;
            }
            if !already_seen.contains(&input.object_id) {
                log::info!(
                    "[Sion][sysaudio] linking '{}' (binary={} object_id={}) → {VIRTUAL_SINK_NAME}",
                    input.node_name, input.binary, input.object_id
                );
                already_seen.insert(input.object_id);
            }
            link_node_to_virtual_sink(&input.node_name);
        }
        let live: HashSet<u32> = inputs.into_iter().map(|i| i.object_id).collect();
        already_seen.retain(|id| live.contains(id));
    }

    fn spawn_link_watcher() {
        if LINK_WATCHER_RUNNING.swap(true, Ordering::AcqRel) {
            return;
        }
        thread::spawn(|| {
            while LINK_WATCHER_RUNNING.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(500));
                if !LINK_WATCHER_RUNNING.load(Ordering::Acquire) {
                    break;
                }
                refresh_sink_input_links();
            }
            log::info!("[Sion][sysaudio] link watcher exited");
        });
    }

    /// Boot the local WebSocket server. Called once — subsequent calls are
    /// no-ops. The server stays up for the process lifetime; audio flow is
    /// gated by `CAPTURE_RUNNING` so the port can be returned immediately on
    /// every `start` without re-binding.
    fn ensure_ws_server() {
        if PORT.load(Ordering::Relaxed) != 0 {
            return;
        }
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => {
                log::error!("[Sion][sysaudio] WS bind failed: {e}");
                return;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        PORT.store(port, Ordering::Relaxed);
        log::info!("[Sion][sysaudio] WS server on 127.0.0.1:{port}");

        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                // Binary frames can be large; leaving Nagle on would coalesce
                // audio frames and balloon end-to-end latency. Disable it so
                // each WS frame flushes immediately.
                let _ = stream.set_nodelay(true);
                let Ok(mut ws) = tungstenite::accept(stream) else {
                    continue;
                };

                let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
                WS_SENDERS.lock().unwrap().0.push(tx);
                log::info!("[Sion][sysaudio] WS client connected");

                thread::spawn(move || {
                    // Short read timeout so we can check the channel for
                    // outgoing frames frequently — same trick as the shortcut
                    // WS.
                    let _ = ws
                        .get_ref()
                        .set_read_timeout(Some(Duration::from_millis(20)));
                    loop {
                        // Drain anything queued for this client.
                        while let Ok(frame) = rx.try_recv() {
                            if ws.send(Message::Binary(frame.into())).is_err() {
                                return;
                            }
                        }
                        match ws.read() {
                            Ok(Message::Ping(data)) => {
                                let _ = ws.send(Message::Pong(data));
                            }
                            Ok(Message::Close(_)) => return,
                            Err(tungstenite::Error::Io(ref e))
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    || e.kind() == std::io::ErrorKind::TimedOut => {}
                            Err(_) => return,
                            _ => {}
                        }
                    }
                });
            }
        });
    }

    fn broadcast(buf: &[u8]) {
        let mut senders = WS_SENDERS.lock().unwrap();
        senders.0.retain(|tx| tx.send(buf.to_vec()).is_ok());
    }

    pub fn start(sink_monitor: Option<String>) -> Result<u16, String> {
        ensure_ws_server();

        // Stop any previous capture before starting a new one. Must happen
        // BEFORE we mark the new capture as running, otherwise the old thread
        // would keep reading stdout of a killed process and spam EOF errors.
        stop_internal();

        // Try to set up the exclude-Sion path: hidden virtual sink + per-app
        // pw-link. If anything in this chain fails (no pw-link binary,
        // module-null-sink unavailable on a host without pipewire-pulse,
        // etc.) we silently fall back to capturing the default sink monitor,
        // which still works but lets Sion's own output echo back.
        let virtual_sink_ok = match create_virtual_sink() {
            Some(id) => {
                *VIRTUAL_SINK_MODULE_ID.lock().unwrap() = Some(id);
                refresh_sink_input_links();
                spawn_link_watcher();
                true
            }
            None => false,
        };

        // Resolve target source. When the virtual sink is up, we always
        // capture *its* monitor — Sion is excluded by construction. When it
        // failed (or the caller forced a specific monitor via the picker),
        // honour the requested device, falling back to the default sink's
        // monitor as a last resort.
        let device = if virtual_sink_ok {
            format!("{VIRTUAL_SINK_NAME}.monitor")
        } else {
            match sink_monitor {
                Some(s) if !s.is_empty() => s,
                _ => default_sink_monitor().ok_or_else(|| {
                    "no default sink (pactl get-default-sink failed)".to_string()
                })?,
            }
        };
        log::info!(
            "[Sion][sysaudio] capture starting on '{device}' via parec (virtual_sink={})",
            virtual_sink_ok
        );

        // Bump the monitor source to 100% if it's attenuated. See the doc on
        // VOLUME_RESTORE: sometimes it ships at 8%/-66 dB and everything
        // downstream sees noise floor no matter what parec does. Skip when
        // capturing our own virtual sink — we created it at default volume
        // and nothing else can have touched it.
        if !virtual_sink_ok {
            boost_monitor_volume(&device);
        }

        // `--latency-msec=20` hints the Pulse/PipeWire daemon to deliver
        // 20 ms buffers, matching FRAME_BYTES. `--raw` outputs headerless
        // PCM on stdout, which is what we want to forward verbatim. We
        // briefly tried pw-record here to dodge parec's 30 s
        // `Stream error: Timeout`, but pw-record's `--target=<monitor>`
        // doesn't actually capture the monitor (it falls back to the
        // default source, which silently records nothing). Sticking with
        // parec is fine now that the sink uses media.class=Audio/Sink
        // (visible to PA) — parec finds the monitor and the watcher's
        // perpetual link refresh keeps at least one stream feeding the
        // sink as soon as any non-Sion app makes noise.
        let mut child = Command::new("parec")
            .args([
                "--device",
                &device,
                "--rate",
                &SAMPLE_RATE.to_string(),
                "--channels",
                &CHANNELS.to_string(),
                "--format",
                "float32le",
                "--latency-msec=20",
                "--raw",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("parec spawn failed: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "parec stdout missing".to_string())?;
        let stderr = child.stderr.take();

        let child_arc = Arc::new(Mutex::new(Some(child)));
        *CURRENT_CHILD.lock().unwrap() = Some(child_arc.clone());
        CAPTURE_RUNNING.store(true, Ordering::Release);

        // Drain stderr in a side thread — the recorder writes status lines
        // there. If we don't read it and the pipe fills, it blocks. Also
        // useful for diagnosing capture problems.
        if let Some(mut err) = stderr {
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let msg = String::from_utf8_lossy(&buf[..n]);
                    log::warn!("[Sion][sysaudio][rec] {}", msg.trim());
                }
            });
        }

        // Main capture loop: read FRAME_BYTES at a time from the recorder's
        // stdout and broadcast to WS clients. Reads are blocking on a full
        // frame so we emit evenly-sized chunks; the recorder produces
        // samples at real-time rate so the blocking cost is ~20 ms per
        // frame, matching our WS cadence target.
        thread::spawn(move || {
            let mut reader = stdout;
            let mut frame = vec![0u8; FRAME_BYTES];
            loop {
                if !CAPTURE_RUNNING.load(Ordering::Acquire) {
                    break;
                }
                match reader.read_exact(&mut frame) {
                    Ok(()) => {
                        if WS_SENDERS.lock().unwrap().0.is_empty() {
                            // No listeners — drop the frame rather than
                            // backing up the channels.
                            continue;
                        }
                        broadcast(&frame);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        log::info!("[Sion][sysaudio] recorder stdout EOF (capture stopped)");
                        break;
                    }
                    Err(e) => {
                        log::warn!("[Sion][sysaudio] read error: {e}");
                        break;
                    }
                }
            }
            CAPTURE_RUNNING.store(false, Ordering::Release);
            // Best-effort: reap the child if it's still alive. kill() is a
            // no-op if the process already exited.
            if let Some(c) = child_arc.lock().unwrap().as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            log::info!("[Sion][sysaudio] capture thread exited");
        });

        Ok(PORT.load(Ordering::Relaxed))
    }

    fn stop_internal() {
        // Flip the flag first so the reader thread exits its loop.
        let was_running = CAPTURE_RUNNING.swap(false, Ordering::AcqRel);
        // Also stop the link watcher independently — it may have been
        // started without a successful capture flip if a previous start()
        // raced (defensive).
        LINK_WATCHER_RUNNING.store(false, Ordering::Release);
        if !was_running {
            // Even on no-op, make sure no virtual sink leaks across runs.
            destroy_virtual_sink();
            return;
        }
        let child_holder = CURRENT_CHILD.lock().unwrap().take();
        if let Some(holder) = child_holder {
            if let Some(mut child) = holder.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        // Tear down the virtual sink — this single unload-module call
        // drops the sink and every link we attached to it in one step.
        destroy_virtual_sink();
        // Put the monitor volume back where the user had it (only set
        // when we fell back to capturing the default sink).
        restore_monitor_volume();
    }

    pub fn stop() {
        log::info!("[Sion][sysaudio] stop requested");
        stop_internal();
    }

    pub fn ws_port() -> u16 {
        PORT.load(Ordering::Relaxed)
    }

    /// Return every available sink's monitor source name + human label so the
    /// JS side can populate a "which output to share" picker. The default
    /// sink's label gets a "(par défaut)" suffix.
    pub fn list_sinks() -> Vec<(String, String)> {
        let mut result = Vec::new();
        let default = default_sink_name();
        let output = match Command::new("pactl")
            .args(["-f", "json", "list", "sinks"])
            .output()
        {
            Ok(o) => o,
            Err(_) => return result,
        };
        let json = String::from_utf8_lossy(&output.stdout);
        // Minimal parse — same style as the existing
        // list_audio_devices_pulseaudio helper in lib.rs: scan for "name"
        // and "description" per top-level object.
        for entry in json.split("\"index\":").skip(1) {
            let name = extract_json_field(entry, "\"name\":\"");
            let desc = extract_json_field(entry, "\"description\":\"");
            let Some(name) = name else { continue };
            let desc = desc.unwrap_or_else(|| name.clone());
            let monitor = format!("{name}.monitor");
            let label = if default.as_deref() == Some(name.as_str()) {
                format!("{desc} (par défaut)")
            } else {
                desc
            };
            result.push((monitor, label));
        }
        result
    }

    fn extract_json_field(s: &str, key: &str) -> Option<String> {
        let i = s.find(key)?;
        let rest = &s[i + key.len()..];
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    }

    fn default_sink_name() -> Option<String> {
        let out = Command::new("pactl")
            .arg("get-default-sink")
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    fn default_sink_monitor() -> Option<String> {
        default_sink_name().map(|s| format!("{s}.monitor"))
    }
}

// ============================================================================
// Windows implementation — WASAPI process-loopback with target-process-tree
// exclusion (AUDCLNT_PROCESSLOOPBACK_EXCLUDE_TARGET_PROCESS_TREE). Captures
// every other application's render output to the default endpoint while
// leaving Sion (and all its CEF child processes, which share the parent
// PID's tree) out of the mix — same end result as the Linux virtual sink
// path, but using the native API stack instead of a graph trick.
//
// Requires Windows 10 build 20348 (Server 2022) or Windows 11 — the
// PROCESS_LOOPBACK activation type was introduced in that build. On older
// systems we report an error and the JS side falls back to Chromium's
// native screen-share audio (which captures everything, including Sion).
// ============================================================================

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{CHANNELS, FRAME_BYTES, SAMPLE_RATE};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tungstenite::Message;

    use windows::core::{implement, Interface, Result as WResult, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
        WAVEFORMATEXTENSIBLE_0,
    };
    // WAVE_FORMAT_EXTENSIBLE moved out of Win32::Media::Audio in windows-rs 0.58
    // and KSAUDIO_SPEAKER_STEREO is no longer generated — define it locally as
    // SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT (the C macro definition).
    use windows::Win32::Media::KernelStreaming::{
        SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT, WAVE_FORMAT_EXTENSIBLE,
    };
    const KSAUDIO_SPEAKER_STEREO: u32 = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    // PROPVARIANT moved to windows::core in 0.58 (was in
    // windows::Win32::System::Com::StructuredStorage in earlier versions).
    use windows::core::PROPVARIANT;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, WaitForSingleObject, INFINITE,
    };
    use windows::Win32::System::Variant::VT_BLOB;

    /// Magic device name passed to `ActivateAudioInterfaceAsync` to request
    /// the process-loopback virtual device. Documented at
    /// learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording.
    const VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK: &str = "VAD\\Process_Loopback";

    /// Minimum Windows build number that exposes the process-loopback
    /// activation type. Earlier builds reject the activation with E_NOTIMPL.
    const MIN_BUILD_FOR_PROCESS_LOOPBACK: u32 = 20348;

    static PORT: AtomicU16 = AtomicU16::new(0);
    static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

    struct Senders(Vec<std::sync::mpsc::Sender<Vec<u8>>>);
    static WS_SENDERS: std::sync::LazyLock<Mutex<Senders>> =
        std::sync::LazyLock::new(|| Mutex::new(Senders(Vec::new())));

    fn ensure_ws_server() {
        if PORT.load(Ordering::Relaxed) != 0 {
            return;
        }
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => {
                log::error!("[Sion][sysaudio] WS bind failed: {e}");
                return;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        PORT.store(port, Ordering::Relaxed);
        log::info!("[Sion][sysaudio] WS server on 127.0.0.1:{port}");

        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_nodelay(true);
                let Ok(mut ws) = tungstenite::accept(stream) else { continue };
                let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
                WS_SENDERS.lock().unwrap().0.push(tx);
                log::info!("[Sion][sysaudio] WS client connected");

                thread::spawn(move || {
                    let _ = ws
                        .get_ref()
                        .set_read_timeout(Some(Duration::from_millis(20)));
                    loop {
                        while let Ok(frame) = rx.try_recv() {
                            if ws.send(Message::Binary(frame.into())).is_err() {
                                return;
                            }
                        }
                        match ws.read() {
                            Ok(Message::Ping(d)) => {
                                let _ = ws.send(Message::Pong(d));
                            }
                            Ok(Message::Close(_)) => return,
                            Err(tungstenite::Error::Io(ref e))
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    || e.kind() == std::io::ErrorKind::TimedOut => {}
                            Err(_) => return,
                            _ => {}
                        }
                    }
                });
            }
        });
    }

    fn broadcast(buf: &[u8]) {
        let mut senders = WS_SENDERS.lock().unwrap();
        senders.0.retain(|tx| tx.send(buf.to_vec()).is_ok());
    }

    /// Returns true if the OS exposes the AUDCLNT process-loopback API.
    fn supports_process_loopback() -> bool {
        // Use RtlGetVersion to bypass GetVersion's manifest-gated lies.
        // Implemented via a direct ntdll lookup since the `windows` crate
        // doesn't always expose RtlGetVersion in stable features.
        unsafe {
            let mut info = OSVERSIONINFOW {
                dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
                ..Default::default()
            };
            #[allow(non_snake_case)]
            type RtlGetVersionFn =
                unsafe extern "system" fn(*mut OSVERSIONINFOW) -> i32;
            let ntdll = windows::Win32::System::LibraryLoader::GetModuleHandleW(
                windows::core::w!("ntdll.dll"),
            );
            let Ok(handle) = ntdll else { return false };
            let proc = windows::Win32::System::LibraryLoader::GetProcAddress(
                handle,
                windows::core::s!("RtlGetVersion"),
            );
            let Some(addr) = proc else { return false };
            let f: RtlGetVersionFn = std::mem::transmute(addr);
            if f(&mut info as *mut _) != 0 {
                return false;
            }
            info.dwBuildNumber >= MIN_BUILD_FOR_PROCESS_LOOPBACK
        }
    }

    /// Holds the result of `ActivateAudioInterfaceAsync` and signals an event
    /// when the asynchronous activation completes. Bridges the COM async
    /// callback model to a simple wait-on-event from the caller thread.
    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler {
        event: HANDLE,
        result: Arc<Mutex<Option<WResult<IAudioClient>>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            op: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> WResult<()> {
            let outcome: WResult<IAudioClient> = unsafe {
                let mut hr = windows::core::HRESULT(0);
                let mut iface: Option<windows::core::IUnknown> = None;
                op.unwrap()
                    .GetActivateResult(&mut hr, &mut iface as *mut _)?;
                hr.ok()?;
                iface
                    .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?
                    .cast::<IAudioClient>()
            };
            *self.result.lock().unwrap() = Some(outcome);
            unsafe {
                let _ = windows::Win32::System::Threading::SetEvent(self.event);
            }
            Ok(())
        }
    }

    /// Drives the entire WASAPI capture session: COM init, async activation,
    /// stream init, and the buffer pump. Runs on its own thread; exits when
    /// CAPTURE_RUNNING flips to false. Errors are logged and cause an early
    /// return — `start()` has already returned the WS port to the JS side
    /// at that point so silent capture failure is the worst case.
    unsafe fn capture_thread() {
        if let Err(e) = capture_thread_inner() {
            log::error!("[Sion][sysaudio] WASAPI loopback capture failed: {e:?}");
        }
        CAPTURE_RUNNING.store(false, Ordering::Release);
        log::info!("[Sion][sysaudio] capture thread exited");
    }

    unsafe fn capture_thread_inner() -> WResult<()> {
        // STA vs MTA: WASAPI is content with MTA and we don't pump messages
        // here. Initializing once per thread is safe — `RPC_E_CHANGED_MODE`
        // would mean someone else on this thread already set a different
        // mode, but we own the thread.
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let _com_guard = ComGuard;

        // Activation params: target the *current* PID and exclude its whole
        // process tree (CEF children inherit the launcher PID as parent).
        let mut activation = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: GetCurrentProcessId(),
                    ProcessLoopbackMode:
                        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        // Wrap the params in a PROPVARIANT/VT_BLOB. The PROPVARIANT layout
        // here is documented in the loopback-recording sample on MSDN; we
        // build it by hand because `windows` doesn't ship a high-level
        // helper for VT_BLOB.
        let mut prop = PROPVARIANT::default();
        // PROPVARIANT is #[repr(transparent)] over windows::core::imp::PROPVARIANT
        // in 0.58, so casting &mut PROPVARIANT directly to *mut imp::PROPVARIANT
        // is sound (avoids the UB of going through as_raw()'s &T reference).
        // Field access path (Anonymous.Anonymous.vt, Anonymous.Anonymous.Anonymous.blob)
        // is unchanged from the older windows-rs PROPVARIANT_0 layout.
        let prop_inner =
            &mut *(&mut prop as *mut PROPVARIANT as *mut windows::core::imp::PROPVARIANT);
        prop_inner.Anonymous.Anonymous.vt = VT_BLOB.0;
        prop_inner.Anonymous.Anonymous.Anonymous.blob.cbSize =
            std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32;
        prop_inner.Anonymous.Anonymous.Anonymous.blob.pBlobData =
            &mut activation as *mut _ as *mut u8;

        let event_done = CreateEventW(None, false, false, None)?;
        let result_slot: Arc<Mutex<Option<WResult<IAudioClient>>>> =
            Arc::new(Mutex::new(None));
        let handler = CompletionHandler {
            event: event_done,
            result: result_slot.clone(),
        };
        let handler_iface: IActivateAudioInterfaceCompletionHandler = handler.into();

        let device_name: HSTRING = VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK.into();
        let _op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
            PCWSTR::from_raw(device_name.as_ptr()),
            &IAudioClient::IID,
            Some(&prop),
            &handler_iface,
        )?;
        WaitForSingleObject(event_done, INFINITE);
        let _ = CloseHandle(event_done);

        let audio_client: IAudioClient = result_slot
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED))??;

        // Build a WAVEFORMATEXTENSIBLE for f32 stereo at our sample rate.
        // The activation device only honours formats it can consume, but in
        // practice every modern endpoint accepts 48 kHz f32 stereo.
        let mut format = WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
                nChannels: CHANNELS as u16,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * CHANNELS * 4,
                nBlockAlign: (CHANNELS * 4) as u16,
                wBitsPerSample: 32,
                cbSize: 22,
            },
            Samples: WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: 32,
            },
            dwChannelMask: KSAUDIO_SPEAKER_STEREO,
            SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
        };

        // 20 ms buffer to align with our FRAME_BYTES (also matches Linux).
        const ONE_SECOND_100NS: i64 = 10_000_000;
        let buf_dur_100ns: i64 = ONE_SECOND_100NS / 50;

        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            buf_dur_100ns,
            0,
            &format.Format as *const _,
            None,
        )?;

        let capture_client: IAudioCaptureClient = audio_client.GetService()?;

        audio_client.Start()?;

        // Pump samples into a rolling buffer; emit FRAME_BYTES every time we
        // accumulate enough. WASAPI hands us packets aligned to the device
        // period, not to our fixed 20 ms granularity, so the rebuffer is
        // necessary to keep the WS frame size constant.
        let mut staging: Vec<u8> = Vec::with_capacity(FRAME_BYTES * 2);
        while CAPTURE_RUNNING.load(Ordering::Acquire) {
            // No event handle (activation API doesn't pair with one for
            // process-loopback in shared mode), so we poll at a sub-period
            // cadence.
            thread::sleep(Duration::from_millis(5));
            loop {
                // GetNextPacketSize signature changed in windows-rs 0.58 — it
                // now returns Result<u32> directly instead of taking a out param.
                let packet_size = match capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if packet_size == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                if capture_client
                    .GetBuffer(
                        &mut data as *mut _,
                        &mut frames as *mut _,
                        &mut flags as *mut _,
                        None,
                        None,
                    )
                    .is_err()
                {
                    break;
                }
                let byte_len = frames as usize * CHANNELS as usize * 4;
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    // Silence period — append zero-filled bytes rather than
                    // reading garbage from the (potentially undefined) data
                    // pointer.
                    staging.resize(staging.len() + byte_len, 0);
                } else if !data.is_null() && byte_len > 0 {
                    let slice = std::slice::from_raw_parts(data, byte_len);
                    staging.extend_from_slice(slice);
                }
                let _ = capture_client.ReleaseBuffer(frames);

                while staging.len() >= FRAME_BYTES {
                    let frame: Vec<u8> = staging.drain(..FRAME_BYTES).collect();
                    if !WS_SENDERS.lock().unwrap().0.is_empty() {
                        broadcast(&frame);
                    }
                }
            }
        }

        let _ = audio_client.Stop();
        Ok(())
    }

    /// RAII wrapper to call CoUninitialize on drop. Avoids leaking the COM
    /// apartment if we exit via `?`.
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub fn start() -> Result<u16, String> {
        ensure_ws_server();
        if !supports_process_loopback() {
            return Err(format!(
                "WASAPI process-loopback requires Windows build {} or newer (Server 2022 / Windows 11). Older Windows: ask the user to uncheck \"share audio\" — Sion's voice will otherwise echo back through the screen-share track.",
                MIN_BUILD_FOR_PROCESS_LOOPBACK
            ));
        }
        // Stop any previous capture before starting a new one.
        stop_internal();
        CAPTURE_RUNNING.store(true, Ordering::Release);
        thread::spawn(|| unsafe { capture_thread() });
        Ok(PORT.load(Ordering::Relaxed))
    }

    fn stop_internal() {
        CAPTURE_RUNNING.store(false, Ordering::Release);
        // The capture thread polls the flag every 5 ms, so it'll wind down
        // shortly. We don't join here to keep `stop()` synchronous-cheap;
        // the next start() also calls stop_internal first which serialises
        // against any zombie capture loop via the atomic flag.
    }

    pub fn stop() {
        log::info!("[Sion][sysaudio] stop requested");
        stop_internal();
    }

    pub fn ws_port() -> u16 {
        PORT.load(Ordering::Relaxed)
    }
}
