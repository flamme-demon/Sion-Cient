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
    }

    static PORT: AtomicU16 = AtomicU16::new(0);
    static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

    /// Module ID returned by `pactl load-module`. Held so `stop()` can
    /// `unload-module <id>` cleanly — that one call destroys both the sink
    /// and every link we added to it, no per-link cleanup needed.
    static VIRTUAL_SINK_MODULE_ID: std::sync::LazyLock<Mutex<Option<u32>>> =
        std::sync::LazyLock::new(|| Mutex::new(None));

    /// Tracks which non-Sion node names we've already linked to the virtual
    /// sink, so the polling watcher doesn't re-issue `pw-link` calls every
    /// 500 ms for nodes that are already wired up.
    static LINKED_NODES: std::sync::LazyLock<Mutex<HashSet<String>>> =
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

        let flush = |bin: &mut Option<String>,
                     node: &mut Option<String>,
                     acc: &mut Vec<ParsedSinkInput>| {
            if let (Some(b), Some(n)) = (bin.take(), node.take()) {
                acc.push(ParsedSinkInput { binary: b, node_name: n });
            } else {
                bin.take();
                node.take();
            }
        };

        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("Sink Input #") {
                flush(&mut binary, &mut node_name, &mut result);
            } else if let Some(rest) = trimmed.strip_prefix("application.process.binary = \"") {
                if let Some(end) = rest.rfind('"') {
                    binary = Some(rest[..end].to_string());
                }
            } else if let Some(rest) = trimmed.strip_prefix("node.name = \"") {
                if let Some(end) = rest.rfind('"') {
                    node_name = Some(rest[..end].to_string());
                }
            }
        }
        flush(&mut binary, &mut node_name, &mut result);
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
    /// audio source. Returns true if at least one attempt was issued.
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

    /// Read `pw-link -l` and return the set of node names that already have
    /// at least one link into our virtual sink. We need this because
    /// pw-link exits non-zero both when "port doesn't exist" and "link
    /// already exists" — there's no reliable way to tell from exit codes
    /// whether a link attempt actually succeeded. Verifying via the live
    /// graph is the only robust way to know.
    fn currently_linked_nodes() -> HashSet<String> {
        let mut result = HashSet::new();
        let Ok(out) = Command::new("pw-link").arg("-l").output() else {
            return result;
        };
        if !out.status.success() {
            return result;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        // pw-link -l format is per-block:
        //   <node>:<port>
        //     |-> <other_node>:<port>          (output node followed by its sinks)
        //     |<- <other_node>:<port>          (input node followed by its sources)
        // We're interested in blocks where the header is "<source>:<port>"
        // and one of the |-> targets is "<VIRTUAL_SINK_NAME>:playback_*".
        let target_prefix = format!("-> {VIRTUAL_SINK_NAME}:playback");
        let mut current_node: Option<String> = None;
        for raw in text.lines() {
            let trimmed = raw.trim_start();
            if !raw.starts_with(' ') && !raw.starts_with('\t') && !trimmed.starts_with('|') {
                // New block header. Extract node name (everything before ':').
                current_node = trimmed.split(':').next().map(|s| s.to_string());
                continue;
            }
            if let Some(ref node) = current_node {
                if trimmed.starts_with("|") && trimmed.contains(&target_prefix) {
                    result.insert(node.clone());
                }
            }
        }
        result
    }

    /// Re-scan sink-inputs and (re)link non-Sion nodes whose link is
    /// missing from the live PipeWire graph. Querying the graph each tick
    /// catches the case where an earlier `pw-link` invocation silently
    /// failed (race with the node's port enumeration just after spawn) —
    /// without this, `LINKED_NODES` would mark the node as "done" and
    /// never retry.
    fn refresh_sink_input_links() {
        let inputs = list_pa_sink_inputs();
        let live_links = currently_linked_nodes();
        let mut linked = LINKED_NODES.lock().unwrap();
        for input in &inputs {
            if input.binary == SION_BINARY_NAME {
                continue;
            }
            // Re-link if either (a) we never linked, or (b) we did but the
            // link is no longer present in the live graph.
            if linked.contains(&input.node_name) && live_links.contains(&input.node_name) {
                continue;
            }
            log::info!(
                "[Sion][sysaudio] linking '{}' (binary={}) → {VIRTUAL_SINK_NAME}",
                input.node_name, input.binary
            );
            link_node_to_virtual_sink(&input.node_name);
            linked.insert(input.node_name.clone());
        }
        let live: HashSet<String> = inputs.into_iter().map(|i| i.node_name).collect();
        linked.retain(|n| live.contains(n));
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
// Windows implementation — skeleton only at this point. The real WASAPI
// `AUDCLNT_PROCESSLOOPBACK_EXCLUDE` loopback lands in a subsequent commit
// along with the `windows` crate dependency; this stub lets the top-level
// command dispatch compile on Windows targets without `cfg(not(linux))`
// gymnastics in the JS wiring.
// ============================================================================

#[cfg(target_os = "windows")]
mod windows_impl {
    pub fn start() -> Result<u16, String> {
        log::warn!("[Sion][sysaudio] windows capture not yet implemented — returning error so JS falls back to Chromium systemAudio path");
        Err("windows system-audio capture not implemented yet".to_string())
    }

    pub fn stop() {
        // Nothing to tear down until start() is implemented.
    }

    pub fn ws_port() -> u16 {
        0
    }
}
