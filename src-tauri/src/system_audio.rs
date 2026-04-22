//! System-audio capture — Linux-only screen-share-audio path.
//!
//! xdg-desktop-portal-kde doesn't expose "include audio" on screencasts (and
//! mainline Chromium filters PulseAudio monitor sources out of
//! `enumerateDevices`), so getDisplayMedia({audio:true}) silently returns a
//! useless tab-loopback track. This module bypasses that entirely: we spawn
//! `parec` to record from a sink monitor, stream raw float32 stereo 48 kHz
//! samples over a local WebSocket, and the JS side injects them into a
//! MediaStreamAudioDestinationNode to get a real MediaStreamTrack that
//! LiveKit can publish as ScreenShareAudio.
//!
//! `parec` is shipped by the same `libpulse` package that provides `pactl`,
//! which the rest of lib.rs already calls — so no new dependency. It talks
//! to pipewire-pulse transparently on PipeWire systems.
//!
//! On Windows/macOS the commands exist but return an error — screen-share
//! audio goes through the portal/native path and doesn't need us.

// ============================================================================
// Cross-platform public commands (delegated to the Linux impl or stubbed).
// ============================================================================

#[tauri::command]
pub fn system_audio_start(sink_monitor: Option<String>) -> Result<u16, String> {
    #[cfg(target_os = "linux")]
    {
        imp::start(sink_monitor)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = sink_monitor;
        Err("system_audio: Linux-only (use the native portal elsewhere)".to_string())
    }
}

#[tauri::command]
pub fn system_audio_stop() {
    #[cfg(target_os = "linux")]
    imp::stop();
}

#[tauri::command]
pub fn system_audio_ws_port() -> u16 {
    #[cfg(target_os = "linux")]
    {
        imp::ws_port()
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}

#[tauri::command]
pub fn system_audio_list_sinks() -> Vec<(String, String)> {
    #[cfg(target_os = "linux")]
    {
        imp::list_sinks()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

// ============================================================================
// Linux implementation.
// ============================================================================

#[cfg(target_os = "linux")]
mod imp {
    use std::io::Read;
    use std::net::TcpListener;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tungstenite::Message;

    // Format the JS side expects. Must match the AudioWorklet sampleRate and
    // the MediaStreamAudioDestinationNode's channelCount.
    const SAMPLE_RATE: u32 = 48000;
    const CHANNELS: u32 = 2;
    // 20 ms @ 48 kHz stereo f32 = 960 samples × 4 bytes × 2 ch = 7680 bytes.
    // Keeps each WS frame small enough to avoid head-of-line blocking and
    // matches the AudioWorklet's 128-sample render-quantum granularity
    // reasonably well (20 ms ≈ 7.5 quanta).
    const FRAME_BYTES: usize = 7680;

    static PORT: AtomicU16 = AtomicU16::new(0);
    static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

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

        // Resolve target source. `parec --device=` accepts a source name;
        // empty string or omission means "default source" which is the mic,
        // not what we want — so when no monitor is passed we explicitly
        // resolve the default sink's monitor name.
        let device = match sink_monitor {
            Some(s) if !s.is_empty() => s,
            _ => default_sink_monitor().ok_or_else(|| {
                "no default sink (pactl get-default-sink failed)".to_string()
            })?,
        };
        log::info!("[Sion][sysaudio] capture starting on '{device}'");

        // Stop any previous capture before starting a new one. Must happen
        // BEFORE we mark the new capture as running, otherwise the old thread
        // would keep reading stdout of a killed process and spam EOF errors.
        stop_internal();

        // Bump the monitor source to 100% if it's attenuated. See the doc on
        // VOLUME_RESTORE: sometimes it ships at 8%/-66 dB and everything
        // downstream sees noise floor no matter what parec does.
        boost_monitor_volume(&device);

        // `--latency-msec=20` hints the Pulse/PipeWire daemon to deliver
        // 20 ms buffers, matching FRAME_BYTES. `--raw` outputs headerless
        // PCM on stdout, which is what we want to forward verbatim.
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

        // Drain stderr in a side thread — parec writes status lines there. If
        // we don't read it and the pipe fills, parec blocks. Also useful for
        // diagnosing capture problems.
        if let Some(mut err) = stderr {
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let msg = String::from_utf8_lossy(&buf[..n]);
                    log::warn!("[Sion][sysaudio][parec] {}", msg.trim());
                }
            });
        }

        // Main capture loop: read FRAME_BYTES at a time from parec stdout and
        // broadcast to WS clients. Reads are blocking on a full frame so we
        // emit evenly-sized chunks; parec produces samples at real-time rate
        // so the blocking cost is ~20 ms per frame, matching our WS cadence
        // target.
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
                        log::info!("[Sion][sysaudio] parec stdout EOF (capture stopped)");
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
        if !was_running {
            return;
        }
        let child_holder = CURRENT_CHILD.lock().unwrap().take();
        if let Some(holder) = child_holder {
            if let Some(mut child) = holder.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        // Put the monitor volume back where the user had it.
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
