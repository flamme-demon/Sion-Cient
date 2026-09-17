//! System-audio capture — screen-share-audio path built outside the webview
//! so we can exclude Sion's own output from the captured stream (avoids echo
//! when the user isn't wearing headphones).
//!
//! Linux path (`linux_impl`): creates a hidden virtual sink
//! (`media.class=Audio/Sink/Internal`), links every non-Sion sink-input
//! into it via `pw-link`, then captures *its* monitor with `parec`. Sion's
//! own output stays linked only to the user's real Speaker, so it reaches
//! the hardware (the sharer still hears the call) but never enters the
//! capture stream. Same pattern as the OBS `pipewire-audio-capture`
//! plugin's "capture all except" mode. If exclusion cannot be established,
//! audio sharing is refused: capturing Sion itself would echo the call.
//!
//! Windows path (`windows_impl`): WASAPI loopback with
//! `AUDCLNT_PROCESSLOOPBACK_EXCLUDE` (Windows 10 build 20348+ / Windows 11).
//! Older builds refuse audio sharing rather than capture Sion itself.
//!
//! macOS n'est pas implémenté dans le moteur natif (l'ancien chemin
//! `getDisplayMedia({ systemAudio })` de Chromium a disparu avec la
//! suppression du moteur JS) : `system_audio_start` y renvoie une erreur et
//! le partage se fait sans son.
//!
//! Les deux plateformes produisent le même PCM (float32le mono 48 kHz,
//! trames de 20 ms) et le diffusent à un unique abonné interne via
//! `system_audio_subscribe` : `voice_engine::run_share_audio_pump` draine le
//! canal et alimente la `NativeAudioSource` de la piste `ScreenshareAudio`.

// ============================================================================
// Cross-platform public commands. Each dispatches to the appropriate
// platform module; unsupported platforms return sentinel values that the
// JS side knows to treat as "no capture available".
// ============================================================================

pub fn system_audio_start(sink_monitor: Option<String>) -> Result<(), String> {
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

/// Abonne un consommateur Rust interne aux frames PCM du système (voir
/// `subscribe_frames` des impls) : le partage d'écran natif y publie sa
/// piste `ScreenshareAudio`. `None` sur plateforme non supportée.
/// La capture doit être démarrée (`system_audio_start`) par l'appelant ;
/// le Receiver doit être drainé en continu.
pub fn system_audio_subscribe() -> Option<std::sync::mpsc::Receiver<Vec<u8>>> {
    #[cfg(target_os = "linux")]
    {
        return Some(linux_impl::subscribe_frames());
    }
    #[cfg(target_os = "windows")]
    {
        return Some(windows_impl::subscribe_frames());
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

// ============================================================================
// Shared constants — platform impls publish frames in this format so the
// WebSocket consumer on the JS side doesn't need platform awareness.
// ============================================================================

#[allow(dead_code)] // used by both platform modules
const SAMPLE_RATE: u32 = 48000;
// MONO: the system-audio track must match the (mono) mic so both negotiate the
// same Opus payload. A STEREO system-audio track collided with the mono mic on
// opus pt 111 (sprop-stereo:1 vs none) avec l'ancien chemin Chromium →
// BUNDLE codec collision (INVALID_PARAMETER) → peers heard nothing. parec
// downmixes the stereo sink monitor to mono for us.
#[allow(dead_code)]
const CHANNELS: u32 = 1;
/// 20 ms @ 48 kHz mono f32 = 960 samples × 4 bytes × 1 ch = 3840 bytes.
/// Small enough to keep WebSocket head-of-line blocking low and matches the
/// JS-side AudioWorklet render-quantum granularity (20 ms ≈ 7.5 quanta).
#[allow(dead_code)]
const FRAME_BYTES: usize = 3840;

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
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    /// Binary names used to identify Sion's own audio streams when filtering
    /// sink-inputs out of the capture. La fenêtre vit désormais dans WebKitGTK
    /// (WRY) : l'audio de la webview sort sous `WebKitWebProcess`, pas sous
    /// `sion-client`, et doit lui aussi être exclu de la capture (sons de
    /// connexion, soundboard, médias joués dans le chat).
    const SION_BINARY_NAMES: &[&str] = &[
        "sion-client",
        "WebKitWebProcess",
        "WebKitNetworkProcess",
        "WebKitGPUProcess",
    ];

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

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct PipewirePort {
        id: u32,
        node_id: u32,
        name: String,
        direction: String,
    }

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

    struct PcmSenders(Vec<std::sync::mpsc::Sender<Vec<u8>>>);

    static PCM_SENDERS: std::sync::LazyLock<Mutex<PcmSenders>> =
        std::sync::LazyLock::new(|| Mutex::new(PcmSenders(Vec::new())));

    // The live `parec` child. Held in an Arc<Mutex<…>> so the capture thread
    // can pull it to drop (kill) the process when we stop, without requiring
    // the main thread to do the cleanup synchronously.
    static CURRENT_CHILD: std::sync::LazyLock<Mutex<Option<Arc<Mutex<Option<Child>>>>>> =
        std::sync::LazyLock::new(|| Mutex::new(None));

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
                acc.push(ParsedSinkInput {
                    binary: b,
                    node_name: n,
                    object_id: id,
                });
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
        let Ok(out) = Command::new("pactl")
            .args(["list", "short", "modules"])
            .output()
        else {
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
                log::info!(
                    "[Sion][sysaudio] created virtual sink module #{id} ({VIRTUAL_SINK_NAME})"
                );
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

    /// Link two ports by numeric ID: `pw-link <out_id> <in_id>`. No-op
    /// (harmless non-zero) when the link already exists. We MUST address ports
    /// by id, not `node:port` name: `pw-link "Firefox:output_FL"` connects only
    /// ONE of several nodes sharing the name (Firefox = one node per tab), so
    /// the actually-playing tab was silently missed → capture recorded silence.
    /// Port ids are unique, so linking each enumerated port covers every tab.
    fn pw_link_ids(out_id: u32, in_id: u32) {
        let _ = Command::new("pw-link")
            .args([out_id.to_string(), in_id.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    /// Parse `pw-link -I <flag>` (`-o` outputs / `-i` inputs) into
    /// (port_id, node_name, port_name). Lines look like ` 173 Firefox:output_FL`.
    /// We split node:port at the LAST ':' since some node names contain ':'.
    fn list_ports(flag: &str) -> Vec<(u32, String, String)> {
        let out = match Command::new("pw-link").args(["-I", flag]).output() {
            Ok(o) if o.status.success() => o.stdout,
            _ => return Vec::new(),
        };
        let mut result = Vec::new();
        for line in String::from_utf8_lossy(&out).lines() {
            let line = line.trim_start();
            let Some((id_str, name)) = line.split_once(' ') else {
                continue;
            };
            let Ok(id) = id_str.trim().parse::<u32>() else {
                continue;
            };
            let name = name.trim();
            let Some(pos) = name.rfind(':') else { continue };
            result.push((id, name[..pos].to_string(), name[pos + 1..].to_string()));
        }
        result
    }

    /// `pw-cli ls Port` expose le `node.id` réel de chaque port. Ce nombre
    /// correspond à `object.id` dans les propriétés du sink-input PulseAudio.
    /// Contrairement à `node.name`, il reste unique quand plusieurs applis
    /// s'appellent toutes « Chromium » ou « Firefox ».
    fn parse_pw_cli_ports(text: &str) -> Vec<PipewirePort> {
        #[derive(Default)]
        struct Pending {
            id: Option<u32>,
            node_id: Option<u32>,
            name: Option<String>,
            direction: Option<String>,
        }

        fn quoted_value(line: &str, key: &str) -> Option<String> {
            let value = line.trim().strip_prefix(key)?.trim();
            Some(value.trim_matches('"').to_owned())
        }

        fn flush(pending: &mut Pending, result: &mut Vec<PipewirePort>) {
            if let (Some(id), Some(node_id), Some(name), Some(direction)) = (
                pending.id.take(),
                pending.node_id.take(),
                pending.name.take(),
                pending.direction.take(),
            ) {
                result.push(PipewirePort {
                    id,
                    node_id,
                    name,
                    direction,
                });
            }
            *pending = Pending::default();
        }

        let mut result = Vec::new();
        let mut pending = Pending::default();
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("id ") {
                flush(&mut pending, &mut result);
                pending.id = rest.split(',').next().and_then(|id| id.trim().parse().ok());
            } else if let Some(value) = quoted_value(trimmed, "node.id =") {
                pending.node_id = value.parse().ok();
            } else if let Some(value) = quoted_value(trimmed, "port.name =") {
                pending.name = Some(value);
            } else if let Some(value) = quoted_value(trimmed, "port.direction =") {
                pending.direction = Some(value);
            }
        }
        flush(&mut pending, &mut result);
        result
    }

    fn list_pipewire_ports() -> Vec<PipewirePort> {
        let out = match Command::new("pw-cli").args(["ls", "Port"]).output() {
            Ok(o) if o.status.success() => o.stdout,
            _ => return Vec::new(),
        };
        parse_pw_cli_ports(&String::from_utf8_lossy(&out))
    }

    /// The virtual sink's playback_FL/FR input port ids (parec captures its
    /// monitor; these are where app audio is fed in).
    fn virtual_sink_playback_ports() -> Option<(u32, u32)> {
        let (mut fl, mut fr) = (None, None);
        for (id, node, port) in list_ports("-i") {
            if node != VIRTUAL_SINK_NAME {
                continue;
            }
            match port.as_str() {
                "playback_FL" => fl = Some(id),
                "playback_FR" => fr = Some(id),
                _ => {}
            }
        }
        Some((fl?, fr?))
    }

    /// Re-scan sink-inputs each tick and link EVERY non-Sion stream's output
    /// ports into the virtual sink, by port id (so every tab of every app is
    /// captured — see `pw_link_ids`). Sink-inputs are identified via pactl
    /// (qui donne le binaire et `object.id`), puis les ports sont sélectionnés
    /// par le même `node.id` dans PipeWire. Le nom du nœud n'entre jamais dans
    /// la décision : un navigateur nommé « Chromium » ne peut donc ni faire
    /// exclure un autre flux, ni entraîner accidentellement celui de Sion.
    fn refresh_sink_input_links() {
        let inputs = list_pa_sink_inputs();
        let mut already_seen = LINKED_NODES.lock().unwrap();
        let mut wanted_node_ids: HashSet<u32> = HashSet::new();
        for input in &inputs {
            if SION_BINARY_NAMES.contains(&input.binary.as_str()) {
                continue;
            }
            if !already_seen.contains(&input.object_id) {
                log::info!(
                    "[Sion][sysaudio] capturing '{}' (binary={} object_id={}) → {VIRTUAL_SINK_NAME}",
                    input.node_name, input.binary, input.object_id
                );
                already_seen.insert(input.object_id);
            }
            wanted_node_ids.insert(input.object_id);
        }
        let live: HashSet<u32> = inputs.iter().map(|i| i.object_id).collect();
        already_seen.retain(|id| live.contains(id));
        drop(already_seen);

        if wanted_node_ids.is_empty() {
            return;
        }
        let Some((pb_fl, pb_fr)) = virtual_sink_playback_ports() else {
            return;
        };
        for port in list_pipewire_ports() {
            if port.direction != "out" || !wanted_node_ids.contains(&port.node_id) {
                continue;
            }
            if port.name.ends_with("FR") {
                pw_link_ids(port.id, pb_fr);
            } else if port.name.ends_with("FL") || port.name == "output_MONO" {
                pw_link_ids(port.id, pb_fl);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pw_cli_ports_conserve_node_id_unique() {
            let text = r#"
                id 524, type PipeWire:Interface:Port/3
                    node.id = "228"
                    port.name = "output_FL"
                    port.direction = "out"
                id 355, type PipeWire:Interface:Port/3
                    node.id = "424"
                    port.name = "output_FL"
                    port.direction = "out"
            "#;
            assert_eq!(
                parse_pw_cli_ports(text),
                vec![
                    PipewirePort {
                        id: 524,
                        node_id: 228,
                        name: "output_FL".into(),
                        direction: "out".into(),
                    },
                    PipewirePort {
                        id: 355,
                        node_id: 424,
                        name: "output_FL".into(),
                        direction: "out".into(),
                    },
                ]
            );
        }
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

    fn broadcast(buf: &[u8]) {
        let mut senders = PCM_SENDERS.lock().unwrap();
        senders.0.retain(|tx| tx.send(buf.to_vec()).is_ok());
    }

    /// Abonne un consommateur Rust interne aux frames PCM : le partage
    /// d'écran natif y publie sa piste `ScreenshareAudio` sans passer par le
    /// navigateur. Format : voir
    /// SAMPLE_RATE/CHANNELS/FRAME_BYTES (f32 48 kHz mono, 20 ms).
    /// Le Receiver DOIT être drainé en continu (`broadcast` éjecte les
    /// retardataires — canal std non borné sinon).
    pub fn subscribe_frames() -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        PCM_SENDERS.lock().unwrap().0.push(tx);
        rx
    }

    pub fn start(_sink_monitor: Option<String>) -> Result<(), String> {
        // Stop any previous capture before starting a new one. Must happen
        // BEFORE we mark the new capture as running, otherwise the old thread
        // would keep reading stdout of a killed process and spam EOF errors.
        stop_internal();

        // L'exclusion de Sion est obligatoire. Un repli vers le moniteur de
        // sortie global republierait les voix reçues et créerait un écho chez
        // tous les participants. Le front sait continuer en vidéo seule et
        // afficher l'avertissement « sans son ».
        let module_id = create_virtual_sink().ok_or_else(|| {
            "capture audio sans écho indisponible (sortie virtuelle PipeWire/PulseAudio impossible)"
                .to_string()
        })?;
        *VIRTUAL_SINK_MODULE_ID.lock().unwrap() = Some(module_id);

        // PipeWire publie les ports quelques millisecondes après pactl. Sans
        // `node.id`, on ne peut pas garantir le filtrage par application : on
        // préfère annoncer « sans son » plutôt que prétendre avoir partagé un
        // flux silencieux ou revenir à un routage ambigu par nom.
        let routing_ready = (0..20).any(|_| {
            let ready =
                virtual_sink_playback_ports().is_some() && !list_pipewire_ports().is_empty();
            if !ready {
                thread::sleep(Duration::from_millis(50));
            }
            ready
        });
        if !routing_ready {
            destroy_virtual_sink();
            return Err(
                "capture audio sans écho indisponible (ports PipeWire non identifiables)"
                    .to_string(),
            );
        }
        refresh_sink_input_links();
        spawn_link_watcher();
        let device = format!("{VIRTUAL_SINK_NAME}.monitor");
        log::info!("[Sion][sysaudio] capture starting on '{device}' via parec (Sion exclu)");

        // Bump the monitor source to 100% if it's attenuated. See the doc on
        // VOLUME_RESTORE: sometimes it ships at 8%/-66 dB and everything
        // downstream sees noise floor no matter what parec does. Skip when
        // capturing our own virtual sink — we created it at default volume
        // and nothing else can have touched it.
        // Notre sink vient d'être créé à son volume nominal.

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
                        if PCM_SENDERS.lock().unwrap().0.is_empty() {
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

        Ok(())
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
    }

    pub fn stop() {
        log::info!("[Sion][sysaudio] stop requested");
        stop_internal();
    }
}

// ============================================================================
// Windows implementation — WASAPI process-loopback with target-process-tree
// exclusion (AUDCLNT_PROCESSLOOPBACK_EXCLUDE_TARGET_PROCESS_TREE). Captures
// every other application's render output to the default endpoint while
// leaving Sion (and its WebView2 child processes, which share the parent
// PID's tree) out of the mix — same end result as the Linux virtual sink
// path, but using the native API stack instead of a graph trick.
//
// Requires Windows 10 build 20348 (Server 2022) or Windows 11 — the
// PROCESS_LOOPBACK activation type was introduced in that build. On older
// systems the capture fails and the share is published without audio
// (no webview fallback anymore).
// ============================================================================

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{CHANNELS, FRAME_BYTES, SAMPLE_RATE};
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use windows::core::{implement, Interface, Result as WResult, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
        AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
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

    static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

    struct PcmSenders(Vec<std::sync::mpsc::Sender<Vec<u8>>>);
    static PCM_SENDERS: std::sync::LazyLock<Mutex<PcmSenders>> =
        std::sync::LazyLock::new(|| Mutex::new(PcmSenders(Vec::new())));

    fn broadcast(buf: &[u8]) {
        let mut senders = PCM_SENDERS.lock().unwrap();
        senders.0.retain(|tx| tx.send(buf.to_vec()).is_ok());
    }

    /// Abonne un consommateur Rust interne (voir `linux_impl::subscribe_frames`).
    pub fn subscribe_frames() -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        PCM_SENDERS.lock().unwrap().0.push(tx);
        rx
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
            type RtlGetVersionFn = unsafe extern "system" fn(*mut OSVERSIONINFOW) -> i32;
            let ntdll = windows::Win32::System::LibraryLoader::GetModuleHandleW(windows::core::w!(
                "ntdll.dll"
            ));
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
        // process tree (les sous-process WebView2 partagent ce parent).
        let mut activation = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: GetCurrentProcessId(),
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
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
        let result_slot: Arc<Mutex<Option<WResult<IAudioClient>>>> = Arc::new(Mutex::new(None));
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

        // CRITICAL: `prop` is a windows-rs `PROPVARIANT` whose `Drop` runs
        // `PropVariantClear`. For a VT_BLOB that frees `blob.pBlobData` via
        // `CoTaskMemFree` — but our `pBlobData` points at the STACK `activation`,
        // not CoTaskMem-allocated memory. Letting `prop` drop as VT_BLOB frees a
        // stack address → heap corruption (exit code 0xC0000374), which surfaced
        // as an app crash when the screen share (and thus this capture thread)
        // stopped. The activation params have now been fully consumed by
        // ActivateAudioInterfaceAsync, so skip the destructor entirely — there
        // is no heap allocation to release.
        std::mem::forget(prop);

        let audio_client: IAudioClient =
            result_slot.lock().unwrap().take().ok_or_else(|| {
                windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)
            })??;

        // Build a WAVEFORMATEXTENSIBLE for f32 mono (CHANNELS=1) at our sample
        // rate. The audio engine remixes the endpoint to this requested format.
        // Mono matches the mic so Opus doesn't hit the pt-111 stereo/mono
        // BUNDLE collision héritée de Chromium (même raison que le chemin Linux).
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
                    if !PCM_SENDERS.lock().unwrap().0.is_empty() {
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

    pub fn start() -> Result<(), String> {
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
        Ok(())
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
}
