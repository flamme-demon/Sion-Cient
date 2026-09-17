#[cfg(target_os = "linux")]
use rdev::Key;
use tauri::Emitter;
use tauri::Manager;

#[cfg(not(target_os = "android"))]
mod cursor_overlay;
#[cfg(not(target_os = "android"))]
mod native_video_surface;
#[cfg(not(target_os = "android"))]
mod pip_window;
#[cfg(target_os = "linux")]
mod portal_shortcuts;
// Repli « page blanche NVIDIA » (renderer DMA-BUF de WebKitGTK) : surveille le
// web process et relance une fois avec `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
// Public : `main.rs` y lit le marqueur avant l'init GTK.
#[cfg(target_os = "linux")]
pub mod gpu_fallback;
#[cfg(not(target_os = "android"))]
mod summarize;
#[cfg(not(target_os = "android"))]
mod system_audio;
#[cfg(not(target_os = "android"))]
mod transcribe;
#[cfg(not(target_os = "android"))]
mod tts;
#[cfg(target_os = "windows")]
mod win_shortcuts;
// Voix native (moteur Rust) : état + détecteur RMS + codecs data-channel.
// Aucun trafic SFU réel à ce stade.
mod voice_native;
// Moteur LiveKit natif (POC) : uniquement avec `--features native-voice`.
#[cfg(all(test, feature = "native-voice"))]
mod native_audio_tests;
#[cfg(feature = "native-voice")]
#[cfg(target_os = "windows")]
mod virtual_desktop;
mod media_server;
mod native_video_transport;
#[cfg(feature = "native-voice")]
mod voice_engine;
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
#[cfg(not(target_os = "android"))]
use std::net::TcpListener;
#[cfg(not(target_os = "android"))]
use std::sync::atomic::{AtomicU16, Ordering};
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(not(target_os = "android"))]
use std::thread;
use std::time::Duration;
#[cfg(not(target_os = "android"))]
use tungstenite::Message;

pub(crate) type TauriRuntime = tauri::Wry;

#[cfg(target_os = "linux")]
struct ShortcutState {
    mute_keys: Vec<Key>,
    deafen_keys: Vec<Key>,
}

#[cfg(target_os = "linux")]
type SharedShortcuts = Arc<Mutex<ShortcutState>>;

#[cfg(target_os = "linux")]
fn parse_key(s: &str) -> Option<Key> {
    match s.trim() {
        "Ctrl" => Some(Key::ControlLeft),
        "Shift" => Some(Key::ShiftLeft),
        "Alt" => Some(Key::Alt),
        "Meta" => Some(Key::MetaLeft),
        "F1" => Some(Key::F1),
        "F2" => Some(Key::F2),
        "F3" => Some(Key::F3),
        "F4" => Some(Key::F4),
        "F5" => Some(Key::F5),
        "F6" => Some(Key::F6),
        "F7" => Some(Key::F7),
        "F8" => Some(Key::F8),
        "F9" => Some(Key::F9),
        "F10" => Some(Key::F10),
        "F11" => Some(Key::F11),
        "F12" => Some(Key::F12),
        "Space" | " " => Some(Key::Space),
        "Enter" => Some(Key::Return),
        "Escape" => Some(Key::Escape),
        "Tab" => Some(Key::Tab),
        "Backspace" => Some(Key::Backspace),
        "Delete" => Some(Key::Delete),
        "Insert" => Some(Key::Insert),
        "Home" => Some(Key::Home),
        "End" => Some(Key::End),
        "PageUp" => Some(Key::PageUp),
        "PageDown" => Some(Key::PageDown),
        // W3C physical-key codes (e.code) — the UI stores combos in this form
        // since the layout-character migration ("²" on AZERTY = Backquote…).
        "ArrowUp" => Some(Key::UpArrow),
        "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow),
        "ArrowRight" => Some(Key::RightArrow),
        "Backquote" => Some(Key::BackQuote),
        "Quote" => Some(Key::Quote),
        "Backslash" => Some(Key::BackSlash),
        "IntlBackslash" => Some(Key::IntlBackslash),
        "Comma" => Some(Key::Comma),
        "Period" => Some(Key::Dot),
        "Slash" => Some(Key::Slash),
        "Semicolon" => Some(Key::SemiColon),
        "Minus" => Some(Key::Minus),
        "Equal" => Some(Key::Equal),
        "BracketLeft" => Some(Key::LeftBracket),
        "BracketRight" => Some(Key::RightBracket),
        "CapsLock" => Some(Key::CapsLock),
        "ScrollLock" => Some(Key::ScrollLock),
        "Pause" => Some(Key::Pause),
        "PrintScreen" => Some(Key::PrintScreen),
        "NumpadEnter" => Some(Key::KpReturn),
        "NumpadAdd" => Some(Key::KpPlus),
        "NumpadSubtract" => Some(Key::KpMinus),
        "NumpadMultiply" => Some(Key::KpMultiply),
        "NumpadDivide" => Some(Key::KpDivide),
        "NumpadDecimal" => Some(Key::KpDecimal),
        "Numpad0" => Some(Key::Kp0),
        "Numpad1" => Some(Key::Kp1),
        "Numpad2" => Some(Key::Kp2),
        "Numpad3" => Some(Key::Kp3),
        "Numpad4" => Some(Key::Kp4),
        "Numpad5" => Some(Key::Kp5),
        "Numpad6" => Some(Key::Kp6),
        "Numpad7" => Some(Key::Kp7),
        "Numpad8" => Some(Key::Kp8),
        "Numpad9" => Some(Key::Kp9),
        // "KeyA" / "Digit1" → recurse on the trailing letter/digit.
        s if s.len() == 4 && s.starts_with("Key") => parse_key(&s[3..]),
        s if s.len() == 6 && s.starts_with("Digit") => parse_key(&s[5..]),
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap().to_ascii_uppercase();
            match c {
                'A' => Some(Key::KeyA),
                'B' => Some(Key::KeyB),
                'C' => Some(Key::KeyC),
                'D' => Some(Key::KeyD),
                'E' => Some(Key::KeyE),
                'F' => Some(Key::KeyF),
                'G' => Some(Key::KeyG),
                'H' => Some(Key::KeyH),
                'I' => Some(Key::KeyI),
                'J' => Some(Key::KeyJ),
                'K' => Some(Key::KeyK),
                'L' => Some(Key::KeyL),
                'M' => Some(Key::KeyM),
                'N' => Some(Key::KeyN),
                'O' => Some(Key::KeyO),
                'P' => Some(Key::KeyP),
                'Q' => Some(Key::KeyQ),
                'R' => Some(Key::KeyR),
                'S' => Some(Key::KeyS),
                'T' => Some(Key::KeyT),
                'U' => Some(Key::KeyU),
                'V' => Some(Key::KeyV),
                'W' => Some(Key::KeyW),
                'X' => Some(Key::KeyX),
                'Y' => Some(Key::KeyY),
                'Z' => Some(Key::KeyZ),
                '0' => Some(Key::Num0),
                '1' => Some(Key::Num1),
                '2' => Some(Key::Num2),
                '3' => Some(Key::Num3),
                '4' => Some(Key::Num4),
                '5' => Some(Key::Num5),
                '6' => Some(Key::Num6),
                '7' => Some(Key::Num7),
                '8' => Some(Key::Num8),
                '9' => Some(Key::Num9),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn parse_shortcut(shortcut: &str) -> Vec<Key> {
    if shortcut.is_empty() {
        return vec![];
    }
    shortcut.split('+').filter_map(parse_key).collect()
}

#[cfg(target_os = "linux")]
fn keys_match(required: &[Key], pressed: &HashSet<Key>) -> bool {
    if required.is_empty() {
        return false;
    }
    required.iter().all(|k| match *k {
        Key::ControlLeft => {
            pressed.contains(&Key::ControlLeft) || pressed.contains(&Key::ControlRight)
        }
        Key::ShiftLeft => pressed.contains(&Key::ShiftLeft) || pressed.contains(&Key::ShiftRight),
        Key::Alt => pressed.contains(&Key::Alt) || pressed.contains(&Key::AltGr),
        Key::MetaLeft => pressed.contains(&Key::MetaLeft) || pressed.contains(&Key::MetaRight),
        _ => pressed.contains(k),
    })
}

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
pub(crate) struct UpdateShortcutsPayload {
    mute: String,
    deafen: String,
    #[serde(default)]
    soundboard: Vec<SoundboardShortcut>,
}

#[cfg(not(target_os = "android"))]
#[derive(Deserialize, Clone)]
struct SoundboardShortcut {
    id: String,
    combo: String,
}

#[derive(Serialize, Clone)]
struct AudioDevice {
    id: String,
    name: String,
    kind: String, // "input" or "output"
}

#[cfg(not(target_os = "android"))]
fn is_virtual_alsa_device(name: &str) -> bool {
    let virtual_prefixes = [
        "default",
        "sysdefault",
        "pipewire",
        "pulse",
        "dmix",
        "dsnoop",
        "hw:",
        "plughw:",
        "null",
        "lavrate",
        "samplerate",
        "speexrate",
        "jack",
        "oss",
        "surround",
        "upmix",
        "vdownmix",
    ];
    let lower = name.to_lowercase();
    virtual_prefixes.iter().any(|p| lower.starts_with(p))
}

#[cfg(not(target_os = "android"))]
fn prettify_alsa_name(name: &str) -> String {
    // "front:CARD=C920,DEV=0" → extract card name "C920"
    // "hdmi:CARD=HDMI,DEV=1" → "HDMI (DEV 1)"
    if let Some(card_start) = name.find("CARD=") {
        let after_card = &name[card_start + 5..];
        let card_name = after_card.split(',').next().unwrap_or(after_card);

        let dev_num = name
            .find("DEV=")
            .map(|i| &name[i + 4..])
            .and_then(|s| s.split(',').next());

        let prefix = name.split(':').next().unwrap_or("");
        let kind_label = match prefix {
            "hdmi" => "HDMI",
            "front" => "",
            _ => prefix,
        };

        let mut label = card_name.to_string();
        if !kind_label.is_empty() && kind_label != card_name {
            label = format!("{} {}", card_name, kind_label);
        }
        if let Some(dev) = dev_num {
            if dev != "0" {
                label = format!("{} ({})", label, dev);
            }
        }
        label
    } else {
        name.to_string()
    }
}

/// WebRTC's Linux PulseAudio ADM reports successful recording-device changes,
/// but PipeWire can keep the already-open `recStream` attached to its previous
/// source. Move that exact stream as the final routing step.
#[cfg(target_os = "linux")]
pub(crate) fn route_native_microphone(device_label: Option<&str>) -> Result<(), String> {
    let target = if let Some(device_label) = device_label {
        let normalized = |value: &str| {
            value
                .chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>()
        };
        let wanted = normalized(device_label);
        list_audio_devices()
            .into_iter()
            .filter(|device| device.kind == "input")
            .find(|device| {
                let candidate = normalized(&device.name);
                !candidate.is_empty()
                    && (wanted.contains(&candidate) || candidate.contains(&wanted))
            })
            .map(|device| device.id)
            .ok_or_else(|| format!("aucune source PulseAudio pour {device_label}"))?
    } else {
        get_pa_default("source").ok_or("source PulseAudio par défaut introuvable")?
    };

    let indices = find_pa_stream_indices("source-outputs", "sion-client");
    if indices.is_empty() {
        return Err("flux microphone WebRTC introuvable dans PulseAudio".into());
    }
    for index in indices {
        log::info!(
            "[Sion][voix-native] routage source-output {} vers {}",
            index,
            target
        );
        run_pactl(&["move-source-output", &index.to_string(), &target])?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn run_pactl(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("pactl")
        .args(args)
        .status()
        .map_err(|e| format!("pactl failed: {}", e))?;
    if !status.success() {
        return Err(format!("pactl {:?} exited with {}", args, status));
    }
    Ok(())
}

/// Get the current PulseAudio default source or sink name.
#[cfg(not(target_os = "android"))]
fn get_pa_default(kind: &str) -> Option<String> {
    // pactl get-default-source / get-default-sink
    let cmd = format!("get-default-{}", kind);
    let output = std::process::Command::new("pactl")
        .arg(&cmd)
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Find PulseAudio stream indices for our app by scanning JSON output.
#[cfg(not(target_os = "android"))]
fn find_pa_stream_indices(list_type: &str, binary_name: &str) -> Vec<u32> {
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", list_type])
        .output()
        .ok();
    let Some(output) = output else { return vec![] };
    let json = String::from_utf8_lossy(&output.stdout);

    // Scan for entries where application.process.binary matches
    let mut indices = Vec::new();
    let needle = format!("\"application.process.binary\":\"{}\"", binary_name);

    // Each top-level object has "index":N somewhere before the properties
    for chunk in json.split("\"index\":") {
        if chunk.contains(&needle) {
            // Extract the index number right at the start of this chunk
            let idx_str: String = chunk.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(idx) = idx_str.parse::<u32>() {
                indices.push(idx);
            }
        }
    }
    indices
}

/// Liste les périphériques audio PulseAudio (ou CPAL en secours).
#[cfg(not(target_os = "android"))]
fn list_audio_devices() -> Vec<AudioDevice> {
    // Use PulseAudio/PipeWire for device enumeration — gives proper names
    // like "HyperX Cloud Flight S" instead of ALSA's "front:CARD=S,DEV=0".
    if let Ok(pa_devices) = list_audio_devices_pulseaudio() {
        if !pa_devices.is_empty() {
            return pa_devices;
        }
    }
    // Fallback to cpal if PulseAudio isn't available
    list_audio_devices_cpal()
}

#[cfg(not(target_os = "android"))]
fn list_audio_devices_pulseaudio() -> Result<Vec<AudioDevice>, String> {
    let mut devices = Vec::new();

    // Sources (inputs)
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", "sources"])
        .output()
        .map_err(|e| e.to_string())?;
    for source in parse_pa_devices(&String::from_utf8_lossy(&output.stdout)) {
        if source.name.contains(".monitor") {
            continue;
        }
        devices.push(AudioDevice {
            id: source.name,
            name: source.description,
            kind: "input".into(),
        });
    }

    // Sinks (outputs)
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", "sinks"])
        .output()
        .map_err(|e| e.to_string())?;
    for sink in parse_pa_devices(&String::from_utf8_lossy(&output.stdout)) {
        devices.push(AudioDevice {
            id: sink.name,
            name: sink.description,
            kind: "output".into(),
        });
    }

    Ok(devices)
}

#[cfg(not(target_os = "android"))]
struct PaDevice {
    name: String,
    description: String,
}

/// Minimal JSON parsing for pactl output — extracts "name" and
/// "properties.device.description" (or falls back to "description") for each entry.
#[cfg(not(target_os = "android"))]
fn parse_pa_devices(json: &str) -> Vec<PaDevice> {
    // pactl JSON is an array of objects. We do simple string scanning to avoid
    // pulling in serde_json just for this.
    let mut results = Vec::new();
    let mut pos = 0;
    let bytes = json.as_bytes();

    while pos < bytes.len() {
        // Find next "name" field
        let name_key = "\"name\":";
        let Some(name_start) = json[pos..].find(name_key) else {
            break;
        };
        let name_start = pos + name_start + name_key.len();
        pos = name_start;

        let name = extract_json_string(&json[name_start..]).unwrap_or_default();
        // Skip nested "name" fields from ports/profiles — real sources/sinks
        // start with "alsa_" (e.g. "alsa_input.usb-...").
        if name.is_empty() || !name.starts_with("alsa_") {
            continue;
        }

        // Look for "device.description" in the properties section nearby
        // (within the next ~2000 chars to stay in the same object)
        let search_window = &json[pos..std::cmp::min(pos + 3000, json.len())];
        let desc_key = "\"device.description\":";
        let description = if let Some(desc_start) = search_window.find(desc_key) {
            extract_json_string(&search_window[desc_start + desc_key.len()..]).unwrap_or_default()
        } else {
            String::new()
        };

        // Fallback to top-level "description" if device.description is empty
        let description = if description.is_empty() || description == "(null)" {
            let desc_key2 = "\"description\":";
            if let Some(desc_start) = search_window.find(desc_key2) {
                let d = extract_json_string(&search_window[desc_start + desc_key2.len()..])
                    .unwrap_or_default();
                if d != "(null)" {
                    d
                } else {
                    name.clone()
                }
            } else {
                name.clone()
            }
        } else {
            description
        };

        results.push(PaDevice { name, description });
    }
    results
}

#[cfg(not(target_os = "android"))]
fn extract_json_string(s: &str) -> Option<String> {
    let s = s.trim_start();
    if !s.starts_with('"') {
        return None;
    }
    let s = &s[1..];
    let end = s.find('"')?;
    Some(s[..end].to_string())
}

#[cfg(not(target_os = "android"))]
fn list_audio_devices_cpal() -> Vec<AudioDevice> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let mut devices = Vec::new();
    let host = cpal::default_host();

    for device in host.devices().into_iter().flatten() {
        let raw_name = device.name().unwrap_or_default();
        if is_virtual_alsa_device(&raw_name) {
            continue;
        }
        let label = prettify_alsa_name(&raw_name);
        let is_input = device
            .supported_input_configs()
            .map(|mut c| c.next().is_some())
            .unwrap_or(false);
        let is_output = device
            .supported_output_configs()
            .map(|mut c| c.next().is_some())
            .unwrap_or(false);
        if is_input {
            devices.push(AudioDevice {
                id: raw_name.clone(),
                name: label.clone(),
                kind: "input".into(),
            });
        }
        if is_output {
            devices.push(AudioDevice {
                id: raw_name,
                name: label,
                kind: "output".into(),
            });
        }
    }
    devices
}

#[derive(Serialize, Default)]
struct LinkPreview {
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
}

/// Download an image URL and return it as a data URI to bypass COEP/CORS restrictions.
async fn image_to_data_uri(client: &reqwest::Client, image_url: &str) -> Option<String> {
    validate_preview_url(image_url).ok()?;
    use base64::Engine;
    let resp = client.get(image_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.ok()?;
    // Limit image to 2MB
    if bytes.len() > 2 * 1024 * 1024 {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", content_type, b64))
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    validate_preview_url(&url)?;
    fetch_link_preview_inner(&url).await.map_err(|e| {
        let msg = format!("[Sion] Link preview failed for {}: {}", url, e);
        log::warn!("{}", msg);
        msg
    })
}

/// Link previews are fetched by the native process, so never allow them to
/// target local/private network endpoints. This prevents a message URL from
/// turning the client into an SSRF proxy.
fn validate_preview_url(raw: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(raw).map_err(|_| "URL de prévisualisation invalide".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Seules les URLs HTTP(S) sont autorisées".into());
    }
    let host = parsed.host_str().ok_or("Hôte URL manquant")?;
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return Err("Hôte local interdit pour une prévisualisation".into());
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let private = match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_unique_local()
                    || v6.is_unicast_link_local()
            }
        };
        if private {
            return Err("Adresse réseau privée interdite pour une prévisualisation".into());
        }
    }
    Ok(())
}

async fn read_response_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|n| n > max_bytes as u64)
    {
        return Err("Réponse trop volumineuse".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("lecture réponse: {e}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Réponse trop volumineuse".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn build_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .build()
}

// Shared HTTP client — created once and reused across all link-preview fetches.
// Per-call construction was exhausting connection/TLS resources under load.
static SHARED_HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn shared_client() -> &'static reqwest::Client {
    SHARED_HTTP_CLIENT.get_or_init(|| {
        build_client().unwrap_or_else(|err| {
            log::error!("[Sion] Failed to build shared HTTP client: {}", err);
            // Fallback to a default client if the configured build fails
            reqwest::Client::new()
        })
    })
}

/// Try oEmbed for sites that block scraping (YouTube, etc.)
async fn try_oembed(client: &reqwest::Client, url: &str) -> Option<LinkPreview> {
    // Known oEmbed endpoints
    let encoded_url = urlencoding::encode(url);
    let oembed_url = if url.contains("youtube.com/") || url.contains("youtu.be/") {
        format!(
            "https://www.youtube.com/oembed?url={}&format=json",
            encoded_url
        )
    } else if url.contains("vimeo.com/") {
        format!("https://vimeo.com/api/oembed.json?url={}", encoded_url)
    } else if url.contains("twitter.com/") || url.contains("x.com/") {
        format!("https://publish.twitter.com/oembed?url={}", encoded_url)
    } else {
        return None;
    };

    let resp = client.get(&oembed_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }

    let json: serde_json::Value = resp.json().await.ok()?;
    let title = json["title"].as_str().map(|s| s.to_string());
    let author = json["author_name"].as_str().map(|s| s.to_string());
    let site_name = json["provider_name"].as_str().map(|s| s.to_string());
    let image = json["thumbnail_url"].as_str().map(|s| s.to_string());

    if title.is_none() && author.is_none() {
        return None;
    }

    // Convert image to data URI to bypass COEP/CORS
    let image_data = match image {
        Some(ref img_url) => image_to_data_uri(client, img_url).await,
        None => None,
    };

    Some(LinkPreview {
        title,
        description: author,
        image: image_data,
        site_name,
    })
}

async fn fetch_link_preview_inner(url: &str) -> Result<LinkPreview, Box<dyn std::error::Error>> {
    let client = shared_client();

    // Try oEmbed first for known sites
    if let Some(preview) = try_oembed(client, url).await {
        return Ok(preview);
    }

    let resp = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await?;
    // Redirects are also untrusted: reject a public URL that lands on a
    // local/private address before reading its body.
    validate_preview_url(resp.url().as_str()).map_err(|e| {
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidInput, e))
            as Box<dyn std::error::Error>
    })?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status).into());
    }

    let bytes = resp.bytes().await?;
    // Limit to 512KB
    let body = if bytes.len() > 512 * 1024 {
        String::from_utf8_lossy(&bytes[..512 * 1024]).into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    // Parse HTML synchronously — scraper::Html is !Send so must not live across .await
    let (title, description, image_url, site_name) = {
        let document = scraper::Html::parse_document(&body);

        let og = |tag: &str| -> Option<String> {
            for attr in &["property", "name"] {
                if let Ok(selector) =
                    scraper::Selector::parse(&format!("meta[{}=\"{}\"]", attr, tag))
                {
                    if let Some(el) = document.select(&selector).next() {
                        if let Some(content) = el.value().attr("content") {
                            let trimmed = content.trim();
                            if !trimmed.is_empty() {
                                return Some(trimmed.to_string());
                            }
                        }
                    }
                }
            }
            None
        };

        let title = og("og:title").or_else(|| {
            let sel = scraper::Selector::parse("title").ok()?;
            let text: String = document.select(&sel).next()?.text().collect();
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });

        let description = og("og:description").or_else(|| og("description"));
        let image_url = og("og:image");
        let site_name = og("og:site_name");

        (title, description, image_url, site_name)
    }; // document dropped here — safe to .await below

    // Convert image to data URI to bypass COEP/CORS
    let image = match image_url {
        Some(ref img_url) => image_to_data_uri(&client, img_url).await,
        None => None,
    };

    Ok(LinkPreview {
        title,
        description,
        image,
        site_name,
    })
}

#[cfg(test)]
mod security_tests {
    use super::{
        sanitize_download_filename, session_credentials, session_json_for_disk,
        write_private_file_atomic,
    };

    #[test]
    fn download_filename_cannot_escape_target_directory() {
        assert!(sanitize_download_filename("../secret.txt").is_err());
        assert!(sanitize_download_filename("/tmp/secret.txt").is_err());
        assert!(sanitize_download_filename("ok.txt").is_ok());
    }

    /// Le jeton ne quitte le fichier que si le coffre l'a confirmé. Sans cette
    /// règle, un build au store de test (`keyring` sans backend) faisait
    /// disparaître le jeton de `session.json` sans le stocker nulle part : la
    /// seule copie de secours d'une session partait en fumée.
    #[test]
    fn session_token_leaves_disk_only_when_the_vault_holds_it() {
        let blob =
            r#"{"sion_auth_credentials":"{\"accessToken\":\"syt_x\"}","sion_device_id":"DEV"}"#;
        assert_eq!(
            session_credentials(blob).as_deref(),
            Some(r#"{"accessToken":"syt_x"}"#)
        );

        // Coffre confirmé : le jeton sort du fichier, le reste demeure.
        let vaulted =
            serde_json::from_str::<serde_json::Value>(&session_json_for_disk(blob, true)).unwrap();
        assert!(vaulted.get("sion_auth_credentials").is_none());
        assert_eq!(
            vaulted.get("sion_device_id").and_then(|v| v.as_str()),
            Some("DEV")
        );

        // Coffre absent/non persistant : copie disque intacte, octet pour octet.
        assert_eq!(session_json_for_disk(blob, false), blob);

        // Déjà sans jeton (déconnecté) : rien à retirer, rien à casser.
        let logged_out = r#"{"sion_device_id":"DEV"}"#;
        assert!(session_credentials(logged_out).is_none());
        assert_eq!(session_json_for_disk(logged_out, true), logged_out);
        assert_eq!(session_json_for_disk(logged_out, false), logged_out);

        // Blob illisible : jamais tronqué par erreur.
        assert_eq!(session_json_for_disk("pas du json", true), "pas du json");
    }

    #[test]
    fn session_write_replaces_the_complete_file_atomically() {
        let directory = std::env::temp_dir().join(format!(
            "sion-session-atomic-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.json");

        write_private_file_atomic(&path, br#"{"generation":1}"#).unwrap();
        write_private_file_atomic(&path, br#"{"generation":2,"complete":true}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"generation":2,"complete":true}"#
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(directory);
    }

    /// Verrou de comportement : tant qu'aucun backend de coffre n'est compilé,
    /// `keyring` fournit son store de test (rien n'est persisté). La sonde doit
    /// refuser — sinon le jeton disparaît du seul fichier qui le garde.
    #[cfg(not(target_os = "android"))]
    #[test]
    fn vault_store_without_persistence_is_not_trusted() {
        use super::{secure_session_entry, secure_session_set_verified};
        let Ok(entry) = secure_session_entry() else {
            return; // aucun coffre joignable dans cet environnement
        };
        // Un vrai keystore relit ce qu'il écrit : ne pas écrire dans celui du
        // développeur pendant les tests.
        if entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .is_none()
        {
            return;
        }
        // C'est la condition d'origine de `persist_session` — elle était vraie
        // ici, donc le jeton partait du fichier sans être stocké nulle part.
        assert!(super::secure_session_set("jeton-de-test").is_ok());
        // …et c'est celle qui remplace : le store de test ne relit rien.
        assert!(!secure_session_set_verified("jeton-de-test"));
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Failed to open URL: {}", e))
}

/// Download a file to a temp directory and open it with the system default application.
#[tauri::command]
async fn open_file_default(url: String, filename: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("sion-files");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("mkdir: {e}"))?;
    let filename = sanitize_download_filename(&filename)?;
    let path = temp_dir.join(&filename);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = read_response_limited(resp, 512 * 1024 * 1024).await?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;

    open::that(&path).map_err(|e| format!("open: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Download a file and save it to the user's Downloads folder.
#[tauri::command]
async fn download_file(url: String, filename: String) -> Result<String, String> {
    let downloads = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or_else(|| "Cannot find Downloads directory".to_string())?;
    std::fs::create_dir_all(&downloads).map_err(|e| format!("mkdir: {e}"))?;

    let filename = sanitize_download_filename(&filename)?;
    // Avoid overwriting: append (1), (2), etc. if file already exists
    let base = std::path::Path::new(&filename);
    let stem = base
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = base
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut path = downloads.join(&filename);
    let mut counter = 1u32;
    while path.exists() {
        path = downloads.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = read_response_limited(resp, 512 * 1024 * 1024).await?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}

fn sanitize_download_filename(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.bytes().any(|b| b == 0 || b < 0x20)
    {
        return Err("Nom de fichier invalide".into());
    }
    if std::path::Path::new(name).is_absolute() {
        return Err("Chemin de fichier absolu interdit".into());
    }
    Ok(name.chars().take(240).collect())
}

#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("open file: {e}"))?;
    Ok(())
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() {
        p
    } else {
        p.parent().unwrap_or(p)
    };
    open::that(dir).map_err(|e| format!("open folder: {e}"))?;
    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle<TauriRuntime>) {
    app.exit(0);
}

// Persist a small session blob (auth credentials + device_id/user_id) OUTSIDE
// the webview profile. localStorage vit dans le profil WebKit/WebView2 et peut
// être purgé par une montée de version ou l'action « vider le cache ».
// app_data_dir (%APPDATA% / ~/.local/share) est un dossier séparé, donc ce
// fichier survit — la session est restaurée au démarrage sans re-login forcé
// ni nouveau device.
/// Jeton d'accès porté par le blob de session, sans rien écrire. Pur.
fn session_credentials(json: &str) -> Option<String> {
    let blob: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json).ok()?;
    let credentials = blob.get("sion_auth_credentials")?.as_str()?;
    Some(credentials.to_string())
}

/// Contenu à écrire sur disque : le jeton ne quitte le fichier que si le coffre
/// l'a **confirmé** (`vaulted`). Sinon la copie disque reste — c'est le seul
/// filet de sécurité quand le profil webview est purgé (localStorage perdu).
/// Pur, testé.
fn session_json_for_disk(json: &str, vaulted: bool) -> String {
    let Ok(mut blob) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json)
    else {
        return json.to_string();
    };
    if vaulted && blob.contains_key("sion_auth_credentials") {
        blob.remove("sion_auth_credentials");
        return serde_json::Value::Object(blob).to_string();
    }
    json.to_string()
}

/// Blob effectivement écrit sur disque (jeton confié au coffre s'il le garde).
#[cfg(not(target_os = "android"))]
fn session_json_to_persist(json: &str) -> String {
    match session_credentials(json) {
        Some(credentials) => session_json_for_disk(json, secure_session_set_verified(&credentials)),
        // Déconnexion : purger le coffre d'un jeton mort.
        None => {
            secure_session_clear();
            json.to_string()
        }
    }
}

/// Android : pas de coffre système, le fichier garde tout (comportement historique).
#[cfg(target_os = "android")]
fn session_json_to_persist(json: &str) -> String {
    json.to_string()
}

/// Écrit un fichier sensible sans jamais exposer une version partiellement
/// écrite : contenu dans un voisin temporaire, flush, puis remplacement
/// atomique sur le même système de fichiers.
fn write_private_file_atomic(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| "chemin de session sans dossier parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "nom de fichier de session invalide".to_string())?;
    let temp_id = NEXT_TEMP_ID.fetch_add(1, AtomicOrdering::Relaxed);
    let temp_path = parent.join(format!(".{file_name}.tmp-{}-{temp_id}", std::process::id()));

    let result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp_path).map_err(|e| e.to_string())?;
        file.write_all(contents).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            use windows_core::PCWSTR;

            let from = temp_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let to = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            unsafe {
                MoveFileExW(
                    PCWSTR(from.as_ptr()),
                    PCWSTR(to.as_ptr()),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            }
            .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "windows"))]
        std::fs::rename(&temp_path, path).map_err(|e| e.to_string())?;

        // Sur Unix, le fsync du dossier rend aussi le renommage durable après
        // une coupure brutale. Le mode 0600 est fixé dès create(), donc aucune
        // fenêtre de temps ne rend le jeton lisible par un autre utilisateur.
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

#[tauri::command]
fn persist_session(app: tauri::AppHandle<TauriRuntime>, json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let disk_json = session_json_to_persist(&json);
    let path = dir.join("session.json");
    write_private_file_atomic(&path, disk_json.as_bytes())
}

#[tauri::command]
fn load_session(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let raw = std::fs::read_to_string(dir.join("session.json")).unwrap_or_default();
    #[cfg(not(target_os = "android"))]
    {
        if let Ok(mut blob) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
        {
            if !blob.contains_key("sion_auth_credentials") {
                if let Ok(credentials) = secure_session_get() {
                    blob.insert(
                        "sion_auth_credentials".into(),
                        serde_json::Value::String(credentials),
                    );
                    return Ok(serde_json::Value::Object(blob).to_string());
                }
            } else if let Some(credentials) =
                blob.get("sion_auth_credentials").and_then(|v| v.as_str())
            {
                // One-time migration from the pre-keychain plaintext file.
                if secure_session_set_verified(credentials) {
                    blob.remove("sion_auth_credentials");
                    let migrated = serde_json::Value::Object(blob).to_string();
                    let path = dir.join("session.json");
                    let _ = write_private_file_atomic(&path, migrated.as_bytes());
                    return Ok(migrated);
                }
            }
        }
    }
    Ok(raw)
}

#[cfg(not(target_os = "android"))]
fn secure_session_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.sion.client", "session").map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
fn secure_session_set(credentials: &str) -> Result<(), String> {
    secure_session_entry()?
        .set_password(credentials)
        .map_err(|e| e.to_string())
}

/// Écrit le jeton dans le coffre **puis le relit**.
///
/// Indispensable : un build sans feature de keystore compile le store de test
/// de `keyring`, qui garde le secret dans l'objet `Entry` et rien d'autre. Sans
/// cette vérification, `set_password` réussit, le jeton est retiré de
/// `session.json`… et il n'existe plus nulle part au redémarrage suivant (profil
/// webview purgé = déconnexion forcée). Un coffre réel relit ce qu'il a écrit.
#[cfg(not(target_os = "android"))]
fn secure_session_set_verified(credentials: &str) -> bool {
    if secure_session_set(credentials).is_err() {
        return false;
    }
    matches!(secure_session_get(), Ok(stored) if stored == credentials)
}

#[cfg(not(target_os = "android"))]
fn secure_session_get() -> Result<String, String> {
    secure_session_entry()?
        .get_password()
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
fn secure_session_clear() {
    if let Ok(entry) = secure_session_entry() {
        let _ = entry.delete_credential();
    }
}

/// Locale du système (« fr-FR », « en-US »…). Sous WRY/WebKitGTK,
/// `navigator.language` peut rester sur en-US selon le profil ; on lit la
/// vraie locale OS côté Rust pour la détection automatique de langue.
#[tauri::command]
fn system_locale() -> String {
    sys_locale::get_locale().unwrap_or_else(|| "fr".to_string())
}

/// Native file picker for the Settings → Advanced "Parcourir" button (select an
/// ffmpeg executable). Desktop only (rfd, async via the xdg-portal/native
/// backend). Returns the absolute path, or None if cancelled.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn pick_ffmpeg_path() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Sélectionner ffmpeg")
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Native file picker for a custom voice-channel cue sound. Returns the
/// absolute path, or None if cancelled.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn pick_audio_file() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Sélectionner un son")
        .add_filter(
            "Audio",
            &["ogg", "mp3", "wav", "m4a", "oga", "opus", "flac"],
        )
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Native file picker for a panel background image. Returns the absolute
/// path, or None if cancelled. Les octets sont ensuite lus par
/// `read_dropped_file` (IPC binaire, pas de base64).
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn pick_image_file() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Sélectionner une image")
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
        )
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Read an arbitrary local file as base64. Used to load a user-picked cue
/// sound (outside the bundle) so the renderer can turn it into a blob URL —
/// la webview ne peut pas lire un `file://` arbitraire. Capped at 5 MB
/// (cue sounds are tiny; this guards against picking a huge file by mistake).
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    use base64::Engine;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("Fichier trop volumineux (max 5 Mo)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Lit un fichier déposé depuis le gestionnaire de fichiers et renvoie ses
/// octets bruts (IPC binaire, pas de base64). Tauri fournit des **chemins**
/// pour le drag & drop natif ; WebKitGTK ne laisse pas passer les fichiers
/// déposés au DOM, donc le front reconstruit un `File` à partir d'ici.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn read_dropped_file(path: String) -> Result<tauri::ipc::Response, String> {
    const MAX_BYTES: u64 = 512 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Pas un fichier".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("Fichier trop volumineux (max 512 Mo)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Image du presse-papiers lue côté natif : WebKitGTK n'expose pas les
/// images dans `ClipboardEvent.clipboardData.items` (contrairement à
/// Chromium/CEF). On renvoie les **octets d'origine** (PNG/JPEG/WebP/GIF)
/// via l'IPC binaire, sans décodage ni ré-encodage : taille réelle et
/// latence minimale. Un vecteur vide = pas d'image dans le presse-papiers.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn read_clipboard_image() -> Result<tauri::ipc::Response, String> {
    // La lecture du presse-papiers est bloquante : hors du thread UI.
    tauri::async_runtime::spawn_blocking(read_clipboard_image_blocking)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(all(not(target_os = "android"), target_os = "linux"))]
fn read_clipboard_image_blocking() -> Result<tauri::ipc::Response, String> {
    use std::io::Read;
    use wl_clipboard_rs::paste::{
        get_contents, ClipboardType, Error as PasteError, MimeType, Seat,
    };

    for mime in ["image/png", "image/jpeg", "image/webp", "image/gif"] {
        match get_contents(
            ClipboardType::Regular,
            Seat::Unspecified,
            MimeType::Specific(mime),
        ) {
            Ok((mut pipe, _actual_mime)) => {
                let mut bytes = Vec::new();
                pipe.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                if !bytes.is_empty() {
                    return Ok(tauri::ipc::Response::new(bytes));
                }
            }
            Err(PasteError::NoMimeType) | Err(PasteError::SeatNotFound) => continue,
            // Pas de backend Wayland (session X11) : repli arboard plus bas.
            Err(PasteError::MissingProtocol { .. }) => break,
            Err(PasteError::ClipboardEmpty) => return Ok(tauri::ipc::Response::new(Vec::new())),
            Err(e) => return Err(e.to_string()),
        }
    }
    read_clipboard_image_via_arboard()
}

#[cfg(all(not(target_os = "android"), not(target_os = "linux")))]
fn read_clipboard_image_blocking() -> Result<tauri::ipc::Response, String> {
    read_clipboard_image_via_arboard()
}

/// Repli : conversion RGBA → PNG (sans redimensionnement) quand le
/// presse-papiers n'expose pas d'image déjà encodée.
#[cfg(not(target_os = "android"))]
fn read_clipboard_image_via_arboard() -> Result<tauri::ipc::Response, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => {
            return Ok(tauri::ipc::Response::new(Vec::new()))
        }
        Err(e) => return Err(e.to_string()),
    };
    let rgba = image::RgbaImage::from_raw(
        image.width as u32,
        image.height as u32,
        image.bytes.into_owned(),
    )
    .ok_or_else(|| "presse-papiers: image invalide".to_string())?;
    let mut png = Vec::new();
    rgba.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("presse-papiers: encodage PNG: {e}"))?;
    Ok(tauri::ipc::Response::new(png))
}

/// Persist base64 audio bytes into `<app-data>/cues/` and return the absolute
/// path. Used for URL-imported voice-cue sounds: unlike soundboard clips (which
/// live in Matrix), cues are replayed from a local path at runtime, so a
/// yt-dlp import — whose temp file is deleted — must be saved somewhere stable.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn save_imported_audio(
    app: tauri::AppHandle<TauriRuntime>,
    data_b64: String,
    ext: String,
) -> Result<String, String> {
    use base64::Engine;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cues");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dest = dir.join(format!(
        "cue_{}.{}",
        stamp,
        if safe_ext.is_empty() {
            "webm".into()
        } else {
            safe_ext
        }
    ));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Build a `Command` that does not pop a console window on Windows. ffmpeg,
/// ffprobe, yt-dlp and tar are CLI tools; spawning them straight would flash a
/// black `cmd` window on every video conversion. CREATE_NO_WINDOW (0x0800_0000)
/// keeps them invisible. No-op on non-Windows targets (incl. Android/Linux),
/// so it is NOT cfg-gated: `transcode_video` (a caller) is compiled on Android.
pub(crate) fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    let cmd = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = cmd;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    cmd
}

/// True if `bin` runs successfully with the given version flag — used to verify
/// a resolved ffmpeg/yt-dlp path actually works.
#[cfg(not(target_os = "android"))]
pub(crate) fn bin_runs(bin: &str, version_flag: &str) -> bool {
    hidden_command(bin)
        .arg(version_flag)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Clean up old Sion transcode temp files (older than 24 hours).
fn cleanup_old_transcodes() {
    let tmp_dir = sion_media_dir();
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
    if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if (name_str.starts_with("sion_in_")
                || name_str.starts_with("sion_out_")
                || name_str.starts_with("sion_send_"))
                && entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|t| t < cutoff)
                    .unwrap_or(false)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Plafond de résolution des conversions de compatibilité : 1280 sur le grand
/// côté, ratio conservé, dimensions paires (exigées par les encodeurs YUV).
const VIDEO_SCALE_FILTER_FLAG: &str = "-vf";
const VIDEO_SCALE_FILTER: &str =
    "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

/// Dossier temporaire dédié aux médias. Isolé du `temp_dir` général pour que la
/// portée du protocole `asset` (qui laisse la webview lire ces fichiers) puisse
/// être restreinte à ce seul répertoire.
pub(crate) fn sion_media_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("sion-media");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Écrit le corps binaire de la requête dans un fichier temporaire et renvoie
/// son chemin.
///
/// Remplace l'aller-retour base64 hérité de l'époque CEF (ab3316d, 08/06), où
/// les octets d'une vidéo traversaient l'IPC encodés en texte : une vidéo de
/// 200 Mo devenait une chaîne de ~270 Mo côté processus web, plus les copies
/// intermédiaires. Ici la webview envoie un `ArrayBuffer` brut, Tauri le remet
/// tel quel, et rien n'est ré-encodé.
#[tauri::command]
fn stage_media(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("corps binaire attendu".to_string()),
    };
    let ext = request
        .headers()
        .get("x-sion-ext")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
        .filter(|v| !v.is_empty() && v.len() <= 8)
        .unwrap_or_else(|| "bin".to_string());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.len().hash(&mut hasher);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut hasher);
    let path = sion_media_dir().join(format!("sion_in_{:x}.{}", hasher.finish(), ext));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Rend le contenu d'un fichier du dossier média en binaire brut.
///
/// Le protocole `asset` avait été essayé pour éviter toute copie : la balise
/// vidéo aurait lu le fichier directement depuis le disque. Mesuré le 17/09,
/// ça ne marche pas sous WebKitGTK — `asset://localhost/...` reste illisible
/// pour le lecteur, sans la moindre erreur côté Rust (ni refus de portée, ni
/// fichier introuvable), parce que le média passe par le `webkitwebsrc` de
/// GStreamer et non par le gestionnaire de schéma de la webview.
///
/// On renvoie donc les octets, mais en binaire (`ipc::Response`), pas en
/// base64 : c'est une copie, contre les trois de l'encodage texte, et c'est
/// exactement ce que le chemin de lecture normal fait déjà pour toute vidéo.
///
/// Le chemin est canonicalisé et doit rester sous `sion_media_dir()` : une
/// commande qui rend n'importe quel fichier du disque à la webview serait une
/// primitive de lecture arbitraire.
#[tauri::command]
fn read_media(path: String) -> Result<tauri::ipc::Response, String> {
    let dir = sion_media_dir()
        .canonicalize()
        .map_err(|e| format!("dossier média: {e}"))?;
    let file = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("fichier introuvable: {e}"))?;
    if !file.starts_with(&dir) {
        return Err("chemin hors du dossier média".to_string());
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Port du serveur média local. `0` = indisponible, l'appelant retombe alors
/// sur une URL `blob:`.
#[tauri::command]
fn media_server_port() -> u16 {
    media_server::port()
}

/// Le fichier produit est-il du Matroska/WebM ? Signature EBML `1A 45 DF A3`,
/// par opposition au `ftyp` d'un MP4. Le repli VP9 écrit du WebM dans un
/// fichier nommé `.mp4` : c'est la signature qui fait foi, pas l'extension.
fn ffmpeg_a_produit_du_webm(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut tete = [0u8; 4];
    f.read_exact(&mut tete).is_ok() && tete == [0x1A, 0x45, 0xDF, 0xA3]
}

/// L'AV1 est-il lisible nativement par le moteur web ?
///
/// WebKitGTK ne décode rien lui-même : il construit sa liste de formats à
/// partir du registre GStreamer. Pour l'AV1 il lui faut `dav1ddec`, fourni par
/// `gst-plugin-dav1d` — `av1dec` de libaom, de rang inférieur, ne suffit pas.
/// Mesuré le 17/09 : sans le greffon, un WebM AV1 comme le même flux remis en
/// MP4 donnent tous deux `MEDIA_ERR_SRC_NOT_SUPPORTED` et le démultiplexeur
/// peut même partir en assertion qui tue le processus web. Greffon installé,
/// les trois variantes se lisent intégralement.
///
/// On cherche donc le fichier du greffon plutôt que d'interroger le moteur :
/// `canPlayType()` répond « oui » dès qu'un décodeur quelconque est enregistré,
/// y compris quand la lecture cale ensuite — il a menti dans les deux sens au
/// cours des essais.
#[cfg(target_os = "linux")]
fn dav1d_plugin_present() -> bool {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(paths) = std::env::var_os("GST_PLUGIN_PATH") {
        dirs.extend(std::env::split_paths(&paths));
    }
    if let Some(paths) = std::env::var_os("GST_PLUGIN_SYSTEM_PATH") {
        dirs.extend(std::env::split_paths(&paths));
    }
    for fixe in [
        "/usr/lib/gstreamer-1.0",
        "/usr/lib64/gstreamer-1.0",
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
        "/usr/local/lib/gstreamer-1.0",
    ] {
        dirs.push(std::path::PathBuf::from(fixe));
    }
    dirs.iter().any(|dir| dir.join("libgstdav1d.so").exists())
}

/// Vrai quand la lecture native de l'AV1 est sûre. Faux ailleurs : l'appelant
/// convertit alors, comme avant.
#[tauri::command]
fn av1_playable_natively() -> bool {
    #[cfg(target_os = "linux")]
    {
        let present = dav1d_plugin_present();
        log::info!(
            "[Sion][vidéo] AV1 natif : {}",
            if present { "oui (dav1ddec présent)" } else { "non (gst-plugin-dav1d absent)" }
        );
        present
    }
    // WebView2 et WKWebView embarquent leur propre décodeur AV1.
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Dimensions et durée lues dans la sortie de `ffmpeg -i`.
///
/// `ffprobe` serait plus propre, mais le téléchargement intégré n'installe que
/// `ffmpeg` : dépendre de `ffprobe` ferait échouer la préparation exactement
/// chez les utilisateurs pour qui le bouton d'installation a été écrit.
fn probe_video(ffmpeg_bin: &str, path: &std::path::Path) -> Option<(u32, u32, f64)> {
    let out = hidden_command(ffmpeg_bin).arg("-i").arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    let mut dims = None;
    let mut duration = None;
    for line in text.lines() {
        if duration.is_none() {
            if let Some(rest) = line.trim().strip_prefix("Duration: ") {
                let stamp = rest.split(',').next().unwrap_or("");
                let mut parts = stamp.split(':');
                if let (Some(h), Some(m), Some(sec)) = (parts.next(), parts.next(), parts.next()) {
                    if let (Ok(h), Ok(m), Ok(sec)) =
                        (h.trim().parse::<f64>(), m.parse::<f64>(), sec.parse::<f64>())
                    {
                        duration = Some(h * 3600.0 + m * 60.0 + sec);
                    }
                }
            }
        }
        if dims.is_none() && line.contains("Stream #") && line.contains("Video:") {
            // « …, 1920x1080 [SAR 1:1 DAR 16:9], … » — le premier jeton WxH.
            for token in line.split(|c: char| c == ' ' || c == ',') {
                let token = token.trim();
                let Some((w, h)) = token.split_once('x') else {
                    continue;
                };
                if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                    if w > 0 && h > 0 {
                        dims = Some((w, h));
                        break;
                    }
                }
            }
        }
    }
    let (w, h) = dims?;
    Some((w, h, duration.unwrap_or(0.0)))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedVideo {
    path: String,
    mimetype: String,
    width: u32,
    height: u32,
    duration_ms: u64,
    transcoded: bool,
}

/// Normalise une vidéo AVANT téléversement : WebM VP9 + Opus, plus ses
/// dimensions et sa durée.
///
/// Auparavant le fichier partait tel quel et CHAQUE destinataire le convertissait
/// chez lui — cinq destinataires, cinq encodages `libvpx-vp9` de plusieurs
/// minutes, et rien du tout pour qui n'avait pas ffmpeg. L'expéditeur paie une
/// fois ; l'import par URL le faisait déjà (`recodeWebm`), le glisser-déposer
/// non.
///
/// `already_compatible` évite le ré-encodage quand la source est déjà du WebM
/// VP8/VP9 : l'appelant l'a sondée sans décoder (`detectWebmVideoCodec`).
#[tauri::command]
async fn prepare_video_for_send(
    app: tauri::AppHandle<TauriRuntime>,
    input_path: String,
    ffmpeg_path: Option<String>,
    already_compatible: bool,
) -> Result<PreparedVideo, String> {
    #[cfg(not(target_os = "android"))]
    let managed = managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    #[cfg(target_os = "android")]
    let managed: Option<String> = None;
    let ffmpeg_bin = resolve_ffmpeg(ffmpeg_path.as_deref(), managed.as_deref());
    let input = std::path::PathBuf::from(&input_path);
    if !input.exists() {
        return Err("fichier source introuvable".to_string());
    }

    if already_compatible {
        let (width, height, secs) = probe_video(&ffmpeg_bin, &input).unwrap_or((0, 0, 0.0));
        return Ok(PreparedVideo {
            path: input_path,
            mimetype: "video/webm".to_string(),
            width,
            height,
            duration_ms: (secs * 1000.0) as u64,
            transcoded: false,
        });
    }

    let output = sion_media_dir().join(format!(
        "sion_send_{}.mp4",
        input
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "video".to_string())
    ));
    let duration_secs = probe_video(&ffmpeg_bin, &input)
        .map(|(_, _, d)| d)
        .unwrap_or(0.0);
    let input_arg = input.to_string_lossy().into_owned();
    let output_arg = output.to_string_lossy().into_owned();
    // AV1, CRF 32, preset 6. Mesuré le 17/09 sur une vidéo de 23,5 s en
    // 1080x1920 : 12 s d'encodage pour 71 % du poids du même contenu en H.264.
    // Le preset 8 encode deux fois plus vite mais rend un fichier plus gros, le
    // preset 4 est deux fois plus lent ET plus gros ici — 6 est le point
    // d'équilibre. Conteneur MP4 et audio AAC : la combinaison la plus
    // largement lisible, de Chromium à WebKit en passant par les mobiles.
    //
    // `libsvtav1` d'abord, `libaom-av1` ensuite (beaucoup plus lent mais
    // toujours présent), puis VP9 en dernier recours si aucun encodeur AV1
    // n'est compilé dans le ffmpeg de la machine.
    // `-progress pipe:1` : `run_ffmpeg_encode` lit la progression sur stdout et
    // l'émet en `video-import-progress`, comme l'import par URL.
    let candidats: [Vec<&str>; 3] = [
        vec![
            "-y", "-i", &input_arg, "-c:v", "libsvtav1", "-crf", "32",
            "-preset", "6", "-g", "240", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            "-progress", "pipe:1", &output_arg,
        ],
        vec![
            "-y", "-i", &input_arg, "-c:v", "libaom-av1", "-crf", "32",
            "-b:v", "0", "-cpu-used", "6", "-row-mt", "1", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            "-progress", "pipe:1", &output_arg,
        ],
        vec![
            "-y", "-i", &input_arg, "-c:v", "libvpx-vp9", "-crf", "33",
            "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
            "-c:a", "libopus", "-b:a", "128k", "-f", "webm",
            "-progress", "pipe:1", &output_arg,
        ],
    ];
    let mut derniere = String::new();
    let mut encode = false;
    for args in &candidats {
        match run_ffmpeg_encode(&app, &ffmpeg_bin, args, duration_secs) {
            Ok(()) => {
                encode = true;
                break;
            }
            Err(err) => {
                log::warn!(
                    "[Sion][vidéo] encodeur {} indisponible, essai suivant",
                    args.get(4).copied().unwrap_or("?")
                );
                derniere = err;
            }
        }
    }
    if !encode {
        return Err(derniere);
    }
    let _ = std::fs::remove_file(&input);
    let (width, height, secs) = probe_video(&ffmpeg_bin, &output).unwrap_or((0, 0, duration_secs));
    // Le dernier candidat de la liste produit du WebM : le type déclaré suit
    // ce que ffmpeg a réellement écrit, pas ce qu'on espérait.
    let mimetype = if ffmpeg_a_produit_du_webm(&output) {
        "video/webm"
    } else {
        "video/mp4"
    };
    Ok(PreparedVideo {
        path: output.to_string_lossy().into_owned(),
        mimetype: mimetype.to_string(),
        width,
        height,
        duration_ms: (secs * 1000.0) as u64,
        transcoded: true,
    })
}

/// Convertit une vidéo en WebM (VP9 + Opus) et renvoie le **chemin** du fichier
/// produit, que la webview lit ensuite par le protocole `asset`.
///
/// Renvoyait autrefois du base64 : les octets traversaient l'IPC en texte dans
/// les deux sens (ab3316d, époque CEF). Un chemin suffit et ne copie rien.
#[tauri::command]
async fn transcode_video(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    ffmpeg_path: Option<String>,
    input_path: Option<String>,
    codec: Option<String>,
) -> Result<String, String> {
    // VP9 par défaut (meilleure compression). VP8 est le repli demandé quand le
    // lecteur a échoué à décoder : mesuré le 17/09 sous WebKitGTK, un VP9
    // 1080x1920 donne `MEDIA_ERR_DECODE` dès la première image alors que
    // `ffmpeg` et `gst-launch` le décodent en logiciel sans broncher — le
    // décodage matériel décroche. VP8 est le codec le plus universellement
    // décodable de cette pile.
    let vp8 = codec.as_deref() == Some("vp8");
    // Resolve the ffmpeg binary: user-configured path (Settings → Advanced) →
    // app-managed download → common install locations → `ffmpeg` on PATH. Lets
    // the transcode work out-of-box when ffmpeg is installed but not on PATH
    // (common on Windows) or after the in-app "Installer ffmpeg" button.
    #[cfg(not(target_os = "android"))]
    let managed = managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    #[cfg(target_os = "android")]
    let managed: Option<String> = None;
    let _ = &app;
    let ffmpeg_bin = resolve_ffmpeg(ffmpeg_path.as_deref(), managed.as_deref());

    // Clean up old temp files on each transcode call
    cleanup_old_transcodes();

    // Hash URL for temp file naming
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = hasher.finish();
    let tmp_dir = sion_media_dir();
    let output_path = tmp_dir.join(format!(
        "sion_out_{:x}{}.webm",
        hash,
        if vp8 { "_vp8" } else { "" }
    ));

    // Conversion déjà faite : on rend le même chemin, la webview le relira.
    if output_path.exists() {
        return Ok(output_path.to_string_lossy().into_owned());
    }

    // Obtain the source bytes. Prefer the bytes the renderer already resolved
    // (it has handled E2EE decryption + Matrix media auth) and passed in as
    // base64 — re-downloading the URL here would have NO access token and NO
    // decryption, so it fails on authenticated-media servers (401) and on
    // encrypted channels (we'd fetch ciphertext that ffmpeg can't decode).
    // Fall back to downloading the URL only when no bytes were provided.
    let input_path = match input_path.filter(|s| !s.is_empty()) {
        Some(staged) => std::path::PathBuf::from(staged),
        None => {
            let downloaded = tmp_dir.join(format!("sion_in_{:x}.bin", hash));
            let client = build_client().map_err(|e| e.to_string())?;
            let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            std::fs::write(&downloaded, &bytes).map_err(|e| e.to_string())?;
            downloaded
        }
    };

    // Transcode with ffmpeg (fast preset)
    let output = hidden_command(&ffmpeg_bin)
        .args(["-y", "-i"])
        .arg(&input_path)
        // Plafond de résolution : 1280 sur le grand côté, ratio conservé,
        // dimensions paires. Mesuré le 17/09 — deux conversions identiques en
        // tout point (VP9 profil 0, yuv420p, bt709, 30 fps, ~1200 kb/s) se
        // comportent différemment sous WebKitGTK selon leur seule taille : le
        // 720x1280 se lit, le 1080x1920 donne `MEDIA_ERR_DECODE` dès la
        // première image. Le décodeur décroche au-delà d'une certaine
        // résolution, pas sur le codec. Le plafond réduit au passage le poids
        // et le temps d'encodage.
        .args(if vp8 {
            // VP8 n'a pas de mode qualité constante utilisable seul : `-crf`
            // demande un plafond de débit pour être pris en compte.
            [
                "-c:v", "libvpx", "-crf", "12", "-b:v", "2M", "-deadline",
                "realtime", "-cpu-used", "8", "-c:a", "libopus", "-b:a", "96k",
                VIDEO_SCALE_FILTER_FLAG, VIDEO_SCALE_FILTER, "-f", "webm",
            ]
        } else {
            [
                "-c:v", "libvpx-vp9", "-crf", "35", "-b:v", "0", "-deadline",
                "realtime", "-cpu-used", "8", "-c:a", "libopus", "-b:a", "96k",
                VIDEO_SCALE_FILTER_FLAG, VIDEO_SCALE_FILTER, "-f", "webm",
            ]
        })
        .arg(&output_path)
        .output()
        .map_err(|e| format!("ffmpeg not found: {}", e))?;

    let _ = std::fs::remove_file(&input_path);

    if !output.status.success() {
        let _ = std::fs::remove_file(&output_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg error: {}", stderr));
    }

    Ok(output_path.to_string_lossy().into_owned())
}

/// Path where the in-app "Installer ffmpeg" button stores the downloaded
/// binary: `<app-data>/bin/ffmpeg[.exe]`. Survit aux mises à jour de
/// l'application (app-data est hors du profil webview). None if the app-data
/// dir can't be resolved.
#[cfg(not(target_os = "android"))]
fn managed_ffmpeg_path(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    Some(dir.join("bin").join(name))
}

/// Resolve which ffmpeg binary to invoke: a user-configured path wins; then the
/// app-managed download (`<app-data>/bin/ffmpeg`); otherwise probe common
/// install locations (so it works without PATH, the usual Windows case);
/// finally fall back to bare `ffmpeg` (PATH lookup).
fn resolve_ffmpeg(configured: Option<&str>, managed: Option<&str>) -> String {
    if let Some(p) = configured {
        let p = p.trim();
        if !p.is_empty() {
            return p.to_string();
        }
    }
    if let Some(p) = managed {
        if !p.is_empty() && std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    // Next to the app executable (portable install, or an ffmpeg dropped into
    // the Windows install dir by the NSIS option).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(target_os = "windows") {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            };
            let sibling = dir.join(name);
            if sibling.exists() {
                return sibling.to_string_lossy().into_owned();
            }
        }
    }
    #[cfg(target_os = "windows")]
    let candidates: Vec<String> = {
        let mut c = vec![
            r"C:\ffmpeg\bin\ffmpeg.exe".to_string(),
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe".to_string(),
            r"C:\ProgramData\chocolatey\bin\ffmpeg.exe".to_string(),
        ];
        if let Ok(home) = std::env::var("USERPROFILE") {
            c.push(format!(r"{home}\scoop\shims\ffmpeg.exe"));
        }
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            c.push(format!(r"{la}\Microsoft\WinGet\Links\ffmpeg.exe"));
        }
        c
    };
    #[cfg(not(target_os = "windows"))]
    let candidates: Vec<String> = vec![
        "/usr/bin/ffmpeg".to_string(),
        "/usr/local/bin/ffmpeg".to_string(),
        "/opt/homebrew/bin/ffmpeg".to_string(),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    "ffmpeg".to_string()
}

/// Report the ffmpeg the app would use (resolved path), verifying it actually
/// runs (`-version`). Returns None if ffmpeg can't be found/run. Used by
/// Settings → Advanced to show whether the transcode fallback is available.
#[cfg(not(target_os = "android"))]
/// Détection ffmpeg. `async` : `bin_runs` lance un sous-processus — en
/// synchrone la commande s'exécute sur le fil principal et gèle l'UI au
/// moment précis où le panneau Réglages s'ouvre.
#[tauri::command]
async fn detect_ffmpeg(app: tauri::AppHandle<TauriRuntime>) -> Result<Option<String>, String> {
    let managed = managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ffmpeg(None, managed.as_deref());
    Ok(if bin_runs(&bin, "-version") {
        Some(bin)
    } else {
        None
    })
}

/// Download a static ffmpeg build into `<app-data>/bin/` so the video
/// transcode fallback works without the user installing anything. Streams the
/// archive (emitting `ffmpeg-install-progress` percent events), extracts the
/// ffmpeg binary via the system `tar` (bsdtar on Win10+, GNU tar on Linux —
/// both auto-detect zip/tar.xz), and marks it executable. Returns the path.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn download_ffmpeg(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    use std::io::Write;
    use tauri::Emitter;

    let dest = managed_ffmpeg_path(&app).ok_or("app-data introuvable")?;
    let bin_dir = dest.parent().ok_or("chemin invalide")?.to_path_buf();
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    // Reputable static-build hosts, stable "latest release" URLs.
    #[cfg(target_os = "windows")]
    let url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    #[cfg(target_os = "macos")]
    let url = "https://evermeet.cx/ffmpeg/getrelease/zip";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";

    let _ = app.emit("ffmpeg-install-progress", 0u64);

    // Stream download to a temp archive, reporting progress. Dedicated client
    // with a generous timeout — the archive is ~80 MB and the shared
    // build_client() caps at 10 s total, which aborts the body mid-download on
    // any normal link ("error decoding response body").
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion ffmpeg installer)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let tmp_dir = std::env::temp_dir();
    let archive = tmp_dir.join("sion_ffmpeg_dl");
    let mut file = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            if t > 0 {
                let _ = app.emit("ffmpeg-install-progress", downloaded * 95 / t);
            }
        }
    }
    drop(file);
    let _ = app.emit("ffmpeg-install-progress", 96u64);

    // Extract via system tar (auto-detects .zip / .tar.xz) into a temp dir.
    let ext_dir = tmp_dir.join("sion_ffmpeg_ext");
    let _ = std::fs::remove_dir_all(&ext_dir);
    std::fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;
    let out = hidden_command("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&ext_dir)
        .output()
        .map_err(|e| format!("tar introuvable: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "extraction échouée: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // Locate the ffmpeg binary in the extracted tree.
    let bin_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let found = find_file(&ext_dir, bin_name).ok_or("binaire ffmpeg absent de l'archive")?;
    std::fs::copy(&found, &dest).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }

    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_dir_all(&ext_dir);
    let _ = app.emit("ffmpeg-install-progress", 100u64);
    Ok(dest.to_string_lossy().into_owned())
}

/// Map a user-facing ASR model key to its GGUF source: (HF repo under
/// handy-computer, file). Q5_K_M quants — the size/quality sweet spot.
/// transcribe.cpp runs every family through the same API, so adding a model
/// here (+ a settings option) is the whole integration.
/// Legacy keys ("base"…) map to their whisper equivalents: they can survive
/// in persisted settings from the earlier whisper-rs iteration.
#[cfg(not(target_os = "android"))]
fn asr_model_source(model: &str) -> Option<(&'static str, &'static str)> {
    match model {
        "whisper-base" | "base" => Some(("whisper-base-gguf", "whisper-base-Q5_K_M.gguf")), // ~64 MB
        "whisper-small" | "small" => Some(("whisper-small-gguf", "whisper-small-Q5_K_M.gguf")), // ~194 MB — default
        "whisper-medium" | "medium" => Some(("whisper-medium-gguf", "whisper-medium-Q5_K_M.gguf")), // ~583 MB
        "parakeet-v3" => Some((
            "parakeet-tdt-0.6b-v3-gguf",
            "parakeet-tdt-0.6b-v3-Q5_K_M.gguf",
        )), // ~549 MB, 25 langues, très rapide CPU
        _ => None,
    }
}

/// Remove a downloaded ASR model from disk (settings 🗑️ button). The next
/// use simply re-downloads it.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn delete_asr_model(app: tauri::AppHandle<TauriRuntime>, model: String) -> Result<(), String> {
    let (_, file) = asr_model_source(&model).ok_or("modèle inconnu")?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join(file);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Path of an ASR model under `<app-data>/models/`, if downloaded.
/// Same convention as the managed ffmpeg: survit aux purges du profil webview.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn detect_asr_model(app: tauri::AppHandle<TauriRuntime>, model: String) -> Option<String> {
    let (_, file) = asr_model_source(&model)?;
    let path = app.path().app_data_dir().ok()?.join("models").join(file);
    if path.exists() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Download an ASR GGUF model from the handy-computer Hugging Face org into
/// `<app-data>/models/`, emitting `asr-model-progress` percent events (same
/// UX as the ffmpeg installer). Returns the model path.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn download_asr_model(
    app: tauri::AppHandle<TauriRuntime>,
    model: String,
) -> Result<String, String> {
    use std::io::Write;
    use tauri::Emitter;

    let (repo, file) = asr_model_source(&model).ok_or("modèle inconnu")?;
    let models_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    let dest = models_dir.join(file);
    if dest.exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }

    let url = format!("https://huggingface.co/handy-computer/{repo}/resolve/main/{file}");
    let _ = app.emit("asr-model-progress", 0u64);

    // Dedicated client: models are 60–540 MB, the shared client's timeout
    // would abort mid-body (same rationale as download_ffmpeg).
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion ASR installer)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    // Stream to a .part file, rename on success — a killed download never
    // leaves a truncated model that whisper would then fail to load.
    let part = models_dir.join(format!("{file}.part"));
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            if t > 0 {
                let _ = app.emit("asr-model-progress", downloaded * 99 / t);
            }
        }
    }
    drop(out);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    let _ = app.emit("asr-model-progress", 100u64);
    Ok(dest.to_string_lossy().into_owned())
}

/// Recursively search `dir` for a file named `name`; first match wins.
#[cfg(not(target_os = "android"))]
pub(crate) fn find_file(dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if path.file_name().map(|n| n == name).unwrap_or(false) {
            return Some(path);
        }
    }
    for sub in subdirs {
        if let Some(found) = find_file(&sub, name) {
            return Some(found);
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────
// yt-dlp: download external-media audio (YouTube, etc.) for the soundboard
// and voice-channel cues. Mirrors the ffmpeg model: a self-contained binary
// downloaded on demand into <app-data>/bin, resolved at call time.
// ─────────────────────────────────────────────────────────────────────────

/// `<app-data>/bin/yt-dlp[.exe]` — where the in-app installer drops the binary.
#[cfg(not(target_os = "android"))]
fn managed_ytdlp_path(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    Some(dir.join("bin").join(name))
}

/// Resolve which yt-dlp to invoke: user-configured path → app-managed download
/// → bare `yt-dlp` on PATH.
#[cfg(not(target_os = "android"))]
fn resolve_ytdlp(configured: Option<&str>, managed: Option<&str>) -> String {
    if let Some(p) = configured {
        let p = p.trim();
        if !p.is_empty() {
            return p.to_string();
        }
    }
    if let Some(p) = managed {
        if !p.is_empty() && std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "yt-dlp".to_string()
}

/// Report the yt-dlp the app would use (verifying it runs `--version`). None if
/// not found. Used by Settings → Advanced to show availability.
#[cfg(not(target_os = "android"))]
/// Détection yt-dlp — `async` pour la même raison que `detect_ffmpeg`
/// (sous-processus lancé par `bin_runs`).
#[tauri::command]
async fn detect_ytdlp(app: tauri::AppHandle<TauriRuntime>) -> Result<Option<String>, String> {
    let managed = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ytdlp(None, managed.as_deref());
    Ok(if bin_runs(&bin, "--version") {
        Some(bin)
    } else {
        None
    })
}

/// Report the installed yt-dlp version (`--version`) and the latest released
/// version (GitHub API). Returns JSON `{"current":<string|null>,"latest":<string|null>}`.
/// Versions are `YYYY.MM.DD`, so a plain string compare tells if an update exists.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn ytdlp_versions(
    app: tauri::AppHandle<TauriRuntime>,
    ytdlp_path: Option<String>,
) -> Result<String, String> {
    let managed = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ytdlp(ytdlp_path.as_deref(), managed.as_deref());

    let current = hidden_command(&bin)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // Latest release tag from GitHub (build_client sends a User-Agent, which
    // the GitHub API requires). Best-effort: None if offline / rate-limited.
    let latest: Option<String> = async {
        let client = build_client().ok()?;
        let resp = client
            .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let json: serde_json::Value = resp.json().await.ok()?;
        json.get("tag_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }
    .await;

    Ok(serde_json::json!({ "current": current, "latest": latest }).to_string())
}

/// Native file picker for a custom yt-dlp binary. None if cancelled.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn pick_ytdlp_path() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Sélectionner yt-dlp")
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Download the latest self-contained yt-dlp release into `<app-data>/bin/`.
/// Unlike ffmpeg these are single executables (no archive), so we stream the
/// file straight to the destination. Re-running updates yt-dlp (it breaks
/// often when YouTube changes). Emits `ytdlp-install-progress` percent events.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn download_ytdlp(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    use std::io::Write;
    use tauri::Emitter;

    let dest = managed_ytdlp_path(&app).ok_or("app-data introuvable")?;
    let bin_dir = dest.parent().ok_or("chemin invalide")?.to_path_buf();
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    // Official self-contained builds (no Python required) from GitHub releases.
    #[cfg(target_os = "windows")]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    #[cfg(target_os = "macos")]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

    let _ = app.emit("ytdlp-install-progress", 0u64);

    // Dedicated client with a generous timeout — the binary is ~30 MB and the
    // shared build_client() caps at 10 s, too short on slower links.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion yt-dlp installer)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    // Stream to a temp file first, then move into place (avoids a half-written
    // binary at the managed path if the download is interrupted).
    let tmp = std::env::temp_dir().join("sion_ytdlp_dl");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            if t > 0 {
                let _ = app.emit("ytdlp-install-progress", downloaded * 98 / t);
            }
        }
    }
    drop(file);

    let _ = std::fs::remove_file(&dest);
    std::fs::copy(&tmp, &dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }

    let _ = app.emit("ytdlp-install-progress", 100u64);
    Ok(dest.to_string_lossy().into_owned())
}

/// Probe an external-media URL for its duration (seconds) and title WITHOUT
/// downloading the stream. Returns JSON `{"duration":<u64>,"title":<string>}`.
/// Lets the UI decide whether to require a time range (videos > 5 min).
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn probe_url_media(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    ytdlp_path: Option<String>,
) -> Result<String, String> {
    let managed = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ytdlp(ytdlp_path.as_deref(), managed.as_deref());

    let out = hidden_command(&bin)
        .args([
            "--no-playlist",
            "--playlist-items",
            "1",
            "--skip-download",
            "--no-warnings",
            "--print",
            "%(duration)s|%(title)s",
        ])
        .arg(&url)
        .output()
        .map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    if !out.status.success() {
        return Err(format!("yt-dlp: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().next().unwrap_or("").trim();
    let (dur_str, title) = line.split_once('|').unwrap_or(("", line));
    let duration = dur_str.trim().parse::<f64>().map(|f| f as u64).unwrap_or(0);
    Ok(serde_json::json!({ "duration": duration, "title": title.trim() }).to_string())
}

/// Download audio from an external-media URL via yt-dlp and return it as base64.
/// When `start_sec`/`end_sec` are given (videos > 5 min), only that section is
/// fetched via `--download-sections` (requires ffmpeg). The temp file is never
/// uploaded — the renderer feeds it to the trimmer and uploads only the clip.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn import_url_audio(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    ytdlp_path: Option<String>,
    ffmpeg_path: Option<String>,
    start_sec: Option<f64>,
    end_sec: Option<f64>,
) -> Result<String, String> {
    use base64::Engine;

    let managed_yt = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ytdlp_bin = resolve_ytdlp(ytdlp_path.as_deref(), managed_yt.as_deref());
    let managed_ff = managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ffmpeg_bin = resolve_ffmpeg(ffmpeg_path.as_deref(), managed_ff.as_deref());

    // Unique temp dir per import; output ext is unknown (webm/m4a/opus), so we
    // template it and scan the dir afterwards.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    if let Some(s) = start_sec {
        (s as u64).hash(&mut hasher);
    }
    let work = std::env::temp_dir().join(format!("sion_yt_{:x}", hasher.finish()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let out_tmpl = work.join("audio.%(ext)s");

    let mut cmd = hidden_command(&ytdlp_bin);
    cmd.arg(&url)
        .args([
            "-f",
            "bestaudio/best",
            "--no-playlist",
            "--playlist-items",
            "1",
            "--no-warnings",
            "--no-part",
        ])
        .arg("-o")
        .arg(&out_tmpl)
        .args(["--ffmpeg-location", &ffmpeg_bin]);

    // Bounded section for long videos: cut precisely with keyframes.
    if let (Some(s), Some(e)) = (start_sec, end_sec) {
        if e > s {
            cmd.args([
                "--download-sections",
                &format!("*{}-{}", s, e),
                "--force-keyframes-at-cuts",
            ]);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!(
            "yt-dlp: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Pick the produced audio file (first regular file in the work dir).
    let produced = std::fs::read_dir(&work)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_file());
    let Some(audio) = produced else {
        let _ = std::fs::remove_dir_all(&work);
        return Err("yt-dlp n'a produit aucun fichier audio".into());
    };

    // Guard against decoding a huge file in the renderer (RAM blowup on the
    // waveform). ~40 MB ≈ well over 20 min of compressed audio.
    let meta = std::fs::metadata(&audio).map_err(|e| e.to_string())?;
    if meta.len() > 40 * 1024 * 1024 {
        let _ = std::fs::remove_dir_all(&work);
        return Err("Piste trop longue : indique une plage horaire ou un lien plus court.".into());
    }

    let bytes = std::fs::read(&audio).map_err(|e| e.to_string())?;
    let ext = audio
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("webm")
        .to_string();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let _ = std::fs::remove_dir_all(&work);
    Ok(serde_json::json!({ "ext": ext, "data": b64 }).to_string())
}

/// Normalize a yt-dlp vcodec string to a short label.
#[cfg(not(target_os = "android"))]
fn vcodec_label(v: &str) -> &'static str {
    if v.starts_with("vp9") || v.starts_with("vp09") {
        "VP9"
    } else if v.starts_with("avc") || v.starts_with("h264") {
        "H.264"
    } else if v.starts_with("av01") || v.starts_with("av1") {
        "AV1"
    } else {
        "?"
    }
}

/// Codec preference for native webview playback: VP9 (webm, plays natively) >
/// H.264 (mp4, needs transcode) > AV1 (uncertain). Lower = preferred.
#[cfg(not(target_os = "android"))]
fn vcodec_rank(label: &str) -> u8 {
    match label {
        "VP9" => 0,
        "H.264" => 1,
        "AV1" => 2,
        _ => 3,
    }
}

/// Parse a yt-dlp `--newline` download line ("[download]  45.2% of ...") → percent.
#[cfg(not(target_os = "android"))]
fn parse_download_pct(line: &str) -> Option<f64> {
    let l = line.trim_start();
    if !l.starts_with("[download]") {
        return None;
    }
    let pi = l.find('%')?;
    let pre = &l[..pi];
    let si = pre.rfind(' ')?;
    pre[si..].trim().parse::<f64>().ok()
}

/// Parse an ffmpeg `-progress` line ("out_time=HH:MM:SS.micro") → elapsed seconds.
#[cfg(not(target_os = "android"))]
fn parse_ffmpeg_time_secs(line: &str) -> Option<f64> {
    let rest = line.trim().strip_prefix("out_time=")?;
    let mut parts = rest.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Run ffmpeg with the given args, streaming `out_time` progress as
/// `video-import-progress {phase:"convert"}` events. `eff` = expected output
/// duration (s) for the percentage. Returns Err(stderr) on non-zero exit.
#[cfg(not(target_os = "android"))]
fn run_ffmpeg_encode(
    app: &tauri::AppHandle<TauriRuntime>,
    ffmpeg_bin: &str,
    args: &[&str],
    eff: f64,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use tauri::Emitter;

    let mut child = hidden_command(ffmpeg_bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg introuvable: {}", e))?;
    let mut errp = child.stderr.take().unwrap();
    let errh = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = errp.read_to_string(&mut s);
        s
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if eff > 0.0 {
                if let Some(t) = parse_ffmpeg_time_secs(&line) {
                    let pct = (t / eff * 100.0).clamp(0.0, 99.0);
                    let _ = app.emit(
                        "video-import-progress",
                        serde_json::json!({ "phase": "convert", "pct": pct }),
                    );
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = errh.join().unwrap_or_default();
    if !status.success() {
        return Err(err);
    }
    Ok(())
}

/// Probe a video URL for duration, title and the available resolutions (with a
/// codec-preferred best format per height + estimated total size). Returns JSON
/// `{duration, title, options:[{height, codec, ext, size}]}`. No download.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn probe_url_formats(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    ytdlp_path: Option<String>,
) -> Result<String, String> {
    let managed = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ytdlp(ytdlp_path.as_deref(), managed.as_deref());

    let out = hidden_command(&bin)
        // `--playlist-items 1`: multi-video posts (e.g. an X tweet with several
        // clips) are a playlist — without this yt-dlp emits one JSON object per
        // entry and the parse below breaks. Take the first video.
        .args([
            "--dump-json",
            "--no-playlist",
            "--playlist-items",
            "1",
            "--no-warnings",
        ])
        .arg(&url)
        .output()
        .map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    if !out.status.success() {
        return Err(format!("yt-dlp: {}", String::from_utf8_lossy(&out.stderr)));
    }
    // --dump-json emits NDJSON (one object per line); parse the first object.
    let stdout_str = String::from_utf8_lossy(&out.stdout);
    let first_line = stdout_str
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("");
    let json: serde_json::Value =
        serde_json::from_str(first_line).map_err(|e| format!("JSON yt-dlp: {}", e))?;

    let duration = json.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let empty = vec![];
    let formats = json
        .get("formats")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    // Estimate a format's byte size: prefer reported filesize, else derive it
    // from the bitrate × duration (many sources — X/Twitter, HLS — omit
    // filesize). `rate_keys` are the kbps fields to try (tbr/vbr for video,
    // abr/tbr for audio).
    let est = |f: &serde_json::Value, rate_keys: &[&str]| -> u64 {
        if let Some(s) = f.get("filesize").and_then(|v| v.as_u64()) {
            if s > 0 {
                return s;
            }
        }
        if let Some(s) = f.get("filesize_approx").and_then(|v| v.as_u64()) {
            if s > 0 {
                return s;
            }
        }
        if duration > 0 {
            for k in rate_keys {
                if let Some(r) = f.get(*k).and_then(|v| v.as_f64()) {
                    if r > 0.0 {
                        return (r * 1000.0 / 8.0 * duration as f64) as u64;
                    }
                }
            }
        }
        0
    };

    // Representative audio size (prefer an opus track, else any audio-only).
    let mut audio_size = 0u64;
    for f in formats {
        let v = f.get("vcodec").and_then(|x| x.as_str()).unwrap_or("none");
        let a = f.get("acodec").and_then(|x| x.as_str()).unwrap_or("none");
        if v == "none" && a != "none" {
            let s = est(f, &["abr", "tbr"]);
            if (a.starts_with("opus") && s > 0) || audio_size == 0 {
                audio_size = s;
            }
        }
    }

    // Best video-only format per height, preferring VP9 then H.264.
    use std::collections::HashMap;
    let mut best: HashMap<u64, (u8, u64, String)> = HashMap::new(); // height -> (rank, size, ext)
    for f in formats {
        let v = f.get("vcodec").and_then(|x| x.as_str()).unwrap_or("none");
        if v == "none" {
            continue;
        }
        let Some(h) = f.get("height").and_then(|x| x.as_u64()) else {
            continue;
        };
        if h == 0 {
            continue;
        }
        let label = vcodec_label(v);
        let rank = vcodec_rank(label);
        let ext = f
            .get("ext")
            .and_then(|x| x.as_str())
            .unwrap_or("mp4")
            .to_string();
        // A combined (progressive) format already includes audio in its tbr;
        // only add the separate audio track for video-only formats.
        let a = f.get("acodec").and_then(|x| x.as_str()).unwrap_or("none");
        let mut size = est(f, &["tbr", "vbr"]);
        if a == "none" {
            size += audio_size;
        }
        match best.get(&h) {
            Some((r, _, _)) if *r <= rank => {}
            _ => {
                best.insert(h, (rank, size, ext));
            }
        }
    }

    let mut options: Vec<serde_json::Value> = best
        .into_iter()
        .map(|(h, (rank, vsize, ext))| {
            let codec = match rank {
                0 => "VP9",
                1 => "H.264",
                2 => "AV1",
                _ => "?",
            };
            serde_json::json!({ "height": h, "codec": codec, "ext": ext, "size": vsize })
        })
        .collect();
    options.sort_by_key(|o| o.get("height").and_then(|v| v.as_u64()).unwrap_or(0));

    // Some sources expose a single format with no height/vcodec metadata at all
    // (e.g. X/Twitter animated GIFs served as tweet_video mp4). Offer it as an
    // "original quality" option (height 0) instead of returning nothing.
    if options.is_empty() {
        if let Some(f) = formats
            .iter()
            .rev()
            .find(|f| f.get("url").and_then(|v| v.as_str()).is_some())
        {
            let ext = f.get("ext").and_then(|x| x.as_str()).unwrap_or("mp4");
            let size = est(f, &["tbr", "vbr"]);
            options
                .push(serde_json::json!({ "height": 0, "codec": "?", "ext": ext, "size": size }));
        }
    }

    Ok(serde_json::json!({ "duration": duration, "title": title, "options": options }).to_string())
}

/// Download a video at a chosen max height (codec auto, preferring VP9 → native
/// webview playback), optionally a [start,end] section. Returns `{ext, data(b64)}`.
/// Errors if the result exceeds `max_bytes` (server upload limit).
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn import_url_video(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    ytdlp_path: Option<String>,
    ffmpeg_path: Option<String>,
    height: Option<u32>,
    start_sec: Option<f64>,
    end_sec: Option<f64>,
    max_bytes: Option<u64>,
    recode_webm: Option<bool>,
    duration_sec: Option<f64>,
) -> Result<String, String> {
    use base64::Engine;
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use tauri::Emitter;

    let managed_yt = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ytdlp_bin = resolve_ytdlp(ytdlp_path.as_deref(), managed_yt.as_deref());
    let managed_ff = managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let ffmpeg_bin = resolve_ffmpeg(ffmpeg_path.as_deref(), managed_ff.as_deref());

    let h = height.unwrap_or(720);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    h.hash(&mut hasher);
    if let Some(s) = start_sec {
        (s as u64).hash(&mut hasher);
    }
    let work = std::env::temp_dir().join(format!("sion_ytv_{:x}", hasher.finish()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let out_tmpl = work.join("src.%(ext)s");

    // ── Phase 1: download (+merge / section cut) via yt-dlp, streaming % ──
    let mut dl = hidden_command(&ytdlp_bin);
    dl.arg(&url)
        .args([
            "--no-playlist",
            "--playlist-items",
            "1",
            "--no-warnings",
            "--no-part",
            "--newline",
        ])
        // height 0 = "original quality" fallback (source without height
        // metadata, e.g. X GIFs) — a [height<=0] filter would match nothing.
        .args([
            "-f",
            &if h == 0 {
                "bv*+ba/b".to_string()
            } else {
                format!("bv*[height<={h}]+ba/b[height<={h}]")
            },
        ])
        .args(["-S", "vcodec:vp9,res,ext"])
        .arg("-o")
        .arg(&out_tmpl)
        .args(["--ffmpeg-location", &ffmpeg_bin])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let (Some(s), Some(e)) = (start_sec, end_sec) {
        if e > s {
            dl.args([
                "--download-sections",
                &format!("*{}-{}", s, e),
                "--force-keyframes-at-cuts",
            ]);
        }
    }
    let mut child = dl
        .spawn()
        .map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    let mut errp = child.stderr.take().unwrap();
    let errh = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = errp.read_to_string(&mut s);
        s
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(p) = parse_download_pct(&line) {
                let _ = app.emit(
                    "video-import-progress",
                    serde_json::json!({ "phase": "download", "pct": p }),
                );
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let dl_err = errh.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!("yt-dlp: {}", dl_err));
    }

    let src = std::fs::read_dir(&work)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_file());
    let Some(src) = src else {
        let _ = std::fs::remove_dir_all(&work);
        return Err("yt-dlp n'a produit aucun fichier vidéo".into());
    };

    // ── Phase 2: re-encode to WebM with real progress ──
    let (final_path, final_ext) = if recode_webm == Some(true) {
        let _ = app.emit(
            "video-import-progress",
            serde_json::json!({ "phase": "convert", "pct": 0.0 }),
        );
        let eff = match (start_sec, end_sec) {
            (Some(s), Some(e)) if e > s => e - s,
            _ => duration_sec.unwrap_or(0.0),
        };
        let out = work.join("out.mp4");
        let src_s = src.to_string_lossy().into_owned();
        let out_s = out.to_string_lossy().into_owned();
        let limit = max_bytes.unwrap_or(0);

        // Fit-the-limit bitrate (used only by the fallback candidates), capped by
        // a per-resolution ceiling.
        let ceiling_kbps: u64 = if h <= 360 {
            800
        } else if h <= 480 {
            1200
        } else if h <= 720 {
            2500
        } else if h <= 1080 {
            5000
        } else {
            8000
        };
        let fit_kbps: u64 = match (max_bytes, eff) {
            (Some(lim), e) if lim > 0 && e > 0.0 => {
                let budget = (lim as f64 * 8.0 * 0.92 / e / 1000.0) as u64;
                budget.saturating_sub(140).clamp(150, ceiling_kbps)
            }
            _ => ceiling_kbps,
        };
        let fit = format!("{}k", fit_kbps);
        let tail = [
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
        ];
        let mk = |head: &[&str]| -> Vec<String> {
            head.iter()
                .chain(tail.iter())
                .map(|s| s.to_string())
                .chain(std::iter::once(out_s.clone()))
                .collect()
        };

        // AV1, dans un conteneur MP4.
        //
        // L'AV1 avait déjà été préféré ici, puis retiré : ces fichiers
        // faisaient partir le démultiplexeur Matroska de WebKitGTK en assertion
        // avant que l'élément média ne signale quoi que ce soit. La cause a été
        // trouvée le 17/09 et ce n'était pas l'AV1 : il manquait
        // `gst-plugin-dav1d`. Sans lui, le moteur déclare l'AV1 non supporté et
        // sonde quand même le fichier, ce qui déclenche l'assertion. Avec lui,
        // les mêmes fichiers se lisent intégralement, en WebM comme en MP4.
        //
        // Le conteneur passe donc en MP4 avec audio AAC — la combinaison la
        // plus largement lisible — et le repli final est du H.264 plutôt que du
        // VP9 : si aucun encodeur AV1 n'est compilé dans le ffmpeg de la
        // machine, autant produire le format que tout lit.
        let mut candidates: Vec<Vec<String>> = Vec::new();
        candidates.push(mk(&[
            "-y", "-i", src_s.as_str(), "-c:v", "libsvtav1", "-crf", "32",
            "-preset", "6", "-g", "240", "-pix_fmt", "yuv420p",
        ]));
        candidates.push(mk(&[
            "-y", "-i", src_s.as_str(), "-c:v", "libaom-av1", "-crf", "32",
            "-b:v", "0", "-cpu-used", "6", "-row-mt", "1", "-pix_fmt", "yuv420p",
        ]));
        candidates.push(mk(&[
            "-y", "-i", src_s.as_str(), "-c:v", "libx264", "-crf", "23",
            "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ]));
        // Dernier recours quand une limite de taille serveur doit être tenue :
        // même H.264 mais à débit contraint.
        candidates.push(mk(&[
            "-y", "-i", src_s.as_str(), "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", fit.as_str(), "-pix_fmt", "yuv420p",
        ]));

        let mut encoded = false;
        for args in &candidates {
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            if run_ffmpeg_encode(&app, &ffmpeg_bin, &refs, eff).is_ok() {
                let sz = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(u64::MAX);
                if limit == 0 || sz <= limit {
                    encoded = true;
                    break;
                }
            }
            let _ = std::fs::remove_file(&out);
        }
        if !encoded {
            let _ = std::fs::remove_dir_all(&work);
            return Err("Vidéo trop lourde même après compression : choisis une résolution plus basse ou une plage plus courte.".into());
        }

        let _ = app.emit(
            "video-import-progress",
            serde_json::json!({ "phase": "convert", "pct": 100.0 }),
        );
        let _ = std::fs::remove_file(&src);
        (out, "webm".to_string())
    } else {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4")
            .to_string();
        (src, ext)
    };

    let meta = std::fs::metadata(&final_path).map_err(|e| e.to_string())?;
    if let Some(limit) = max_bytes {
        if limit > 0 && meta.len() > limit {
            let _ = std::fs::remove_dir_all(&work);
            return Err(format!(
                "Vidéo trop lourde ({:.1} Mo > limite {:.1} Mo) : choisis une résolution plus basse ou une plage plus courte.",
                meta.len() as f64 / 1_048_576.0, limit as f64 / 1_048_576.0
            ));
        }
    }

    let bytes = std::fs::read(&final_path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let _ = std::fs::remove_dir_all(&work);
    Ok(serde_json::json!({ "ext": final_ext, "data": b64 }).to_string())
}

/// Register global shortcuts via plugin + update rdev state (Linux).
/// Shared logic extracted so both Linux and non-Linux entry points use it.
// Not compiled on Windows: win_shortcuts.rs replaces the plugin path there.
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
pub(crate) fn register_plugin_shortcuts(
    app: &tauri::AppHandle<TauriRuntime>,
    payload: &UpdateShortcutsPayload,
) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let mute_sc = if !payload.mute.is_empty() {
        payload.mute.parse::<Shortcut>().ok()
    } else {
        None
    };
    let deafen_sc = if !payload.deafen.is_empty() {
        payload.deafen.parse::<Shortcut>().ok()
    } else {
        None
    };

    // Parse all soundboard combos, keeping a map combo → soundId for dispatch.
    let mut soundboard_map: Vec<(Shortcut, String)> = Vec::new();
    for sb in &payload.soundboard {
        if sb.combo.is_empty() {
            continue;
        }
        if let Ok(sc) = sb.combo.parse::<Shortcut>() {
            soundboard_map.push((sc, sb.id.clone()));
        }
    }

    let mut to_register: Vec<Shortcut> = Vec::new();
    if let Some(s) = mute_sc {
        to_register.push(s);
    }
    if let Some(s) = deafen_sc {
        to_register.push(s);
    }
    for (sc, _) in &soundboard_map {
        to_register.push(*sc);
    }

    if !to_register.is_empty() {
        let soundboard_clone = soundboard_map.clone();
        if let Err(e) = gs.on_shortcuts(to_register, move |_app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if mute_sc.is_some() && shortcut == &mute_sc.unwrap() {
                push_shortcut_event("mute");
                return;
            }
            if deafen_sc.is_some() && shortcut == &deafen_sc.unwrap() {
                push_shortcut_event("deafen");
                return;
            }
            for (sc, id) in &soundboard_clone {
                if shortcut == sc {
                    push_shortcut_event(&format!("soundboard:{}", id));
                    return;
                }
            }
        }) {
            log::warn!("[Sion] Failed to register plugin shortcuts: {}", e);
        }
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn update_shortcuts(
    app: tauri::AppHandle<TauriRuntime>,
    state: tauri::State<'_, SharedShortcuts>,
    payload: UpdateShortcutsPayload,
) {
    let mut shortcuts = state.lock().unwrap();
    shortcuts.mute_keys = parse_shortcut(&payload.mute);
    shortcuts.deafen_keys = parse_shortcut(&payload.deafen);
    drop(shortcuts);
    log::info!(
        "[Sion] Global shortcuts updated: mute={}, deafen={}",
        payload.mute,
        payload.deafen
    );

    // Background capture: prefer the XDG portal (layout-proof, sees native
    // Wayland windows); it falls back to the X11-grab plugin if unavailable.
    // Any previously plugin-registered grabs are cleared either way so the
    // two backends never double-fire beyond the WS-level dedup.
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister_all();
    }
    let mut bindings: Vec<portal_shortcuts::Binding> = Vec::new();
    if !payload.mute.is_empty() {
        bindings.push(portal_shortcuts::Binding {
            action: "mute".into(),
            description: "Sion — Couper/activer le micro".into(),
            combo: payload.mute.clone(),
        });
    }
    if !payload.deafen.is_empty() {
        bindings.push(portal_shortcuts::Binding {
            action: "deafen".into(),
            description: "Sion — Sourdine (casque)".into(),
            combo: payload.deafen.clone(),
        });
    }
    for sb in &payload.soundboard {
        if sb.combo.is_empty() {
            continue;
        }
        bindings.push(portal_shortcuts::Binding {
            action: format!("soundboard:{}", sb.id),
            description: format!("Sion — Soundboard ({})", sb.combo),
            combo: sb.combo.clone(),
        });
    }
    portal_shortcuts::update(app, bindings, payload);
}

#[cfg(all(not(target_os = "android"), not(target_os = "linux")))]
#[tauri::command]
fn update_shortcuts(app: tauri::AppHandle<TauriRuntime>, payload: UpdateShortcutsPayload) {
    log::info!(
        "[Sion] Global shortcuts updated: mute={}, deafen={}",
        payload.mute,
        payload.deafen
    );
    // Windows: layout-aware RegisterHotKey path (see win_shortcuts.rs) — the
    // plugin's fixed US VK table binds the wrong keys on AZERTY & co. Clear
    // any plugin grabs from a previous version of this handler first.
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister_all();
        let mut bindings: Vec<win_shortcuts::Binding> = Vec::new();
        if !payload.mute.is_empty() {
            bindings.push(win_shortcuts::Binding {
                action: "mute".into(),
                combo: payload.mute.clone(),
            });
        }
        if !payload.deafen.is_empty() {
            bindings.push(win_shortcuts::Binding {
                action: "deafen".into(),
                combo: payload.deafen.clone(),
            });
        }
        for sb in &payload.soundboard {
            if sb.combo.is_empty() {
                continue;
            }
            bindings.push(win_shortcuts::Binding {
                action: format!("soundboard:{}", sb.id),
                combo: sb.combo.clone(),
            });
        }
        win_shortcuts::update(bindings);
    }
    // macOS: the plugin is fine — Carbon RegisterEventHotKey works on
    // physical keycodes (Code::Backquote → kVK_ANSI_Grave).
    #[cfg(not(target_os = "windows"))]
    register_plugin_shortcuts(&app, &payload);
}

// WebSocket server for global shortcut polling. JS sends "poll" every 100ms,
// Rust responds with the current mute/deafen toggle counts. This avoids Tauri
// IPC (invoke), dont les événements peuvent être différés quand la fenêtre
// n'a pas le focus selon le runtime webview.
#[cfg(not(target_os = "android"))]
static WS_PORT: AtomicU16 = AtomicU16::new(0);

// Channel senders for push-based shortcut delivery to WS clients
#[cfg(not(target_os = "android"))]
static WS_SENDERS: std::sync::LazyLock<Mutex<Vec<std::sync::mpsc::Sender<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// Push a shortcut event to all connected WS clients immediately.
/// Deduplicates events from multiple sources (rdev + plugin) within 500ms.
#[cfg(not(target_os = "android"))]
static LAST_PUSH_TS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(not(target_os = "android"))]
pub(crate) fn push_shortcut_event(action: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let prev = LAST_PUSH_TS.swap(ts, Ordering::Relaxed);
    if ts - prev < 500 {
        return;
    } // Deduplicate rdev + plugin firing for same keypress

    let msg = format!("{},{}", action, ts);
    let mut senders = WS_SENDERS.lock().unwrap();
    senders.retain(|tx| tx.send(msg.clone()).is_ok());
}

#[cfg(not(target_os = "android"))]
fn start_ws_server() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind WS server");
    let port = listener.local_addr().unwrap().port();
    WS_PORT.store(port, Ordering::Relaxed);
    log::info!("[Sion] Shortcut WebSocket server on 127.0.0.1:{}", port);

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if let Ok(ws) = tungstenite::accept(stream) {
                log::info!("[Sion] WS shortcut client connected");

                let (tx, rx) = std::sync::mpsc::channel::<String>();
                WS_SENDERS.lock().unwrap().push(tx);

                // Single thread per client: non-blocking read + channel receive
                thread::spawn(move || {
                    let mut ws = ws;
                    // Set a short read timeout so we can check the channel regularly
                    let _ = ws
                        .get_ref()
                        .set_read_timeout(Some(Duration::from_millis(50)));

                    loop {
                        // Check for messages to send (from push_shortcut_event)
                        while let Ok(msg) = rx.try_recv() {
                            if ws.send(Message::Text(msg.into())).is_err() {
                                return;
                            }
                        }
                        // Non-blocking read: handle ping/close from JS
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
        }
    });
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn get_shortcut_ws_port() -> u16 {
    WS_PORT.load(Ordering::Relaxed)
}

#[cfg(not(target_os = "android"))]
struct WindowStatePersistence {
    save: std::sync::mpsc::SyncSender<()>,
    ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
struct SavedMainWindowState {
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
struct SavedWindowStates {
    main: Option<SavedMainWindowState>,
}

/// Renforce `tauri-plugin-window-state` sur deux points observés en pratique :
///
/// - son restore très précoce peut être ignoré avant que WRY ait associé la
///   fenêtre à son écran (et le plugin applique une `PhysicalSize`) ;
/// - il n'écrit normalement sur disque qu'à la sortie. Un crash, Ctrl-C ou le
///   redémarrage du serveur dev laisse donc un fichier ancien.
///
/// On capture l'état disque avant les premiers événements de fenêtre, on
/// réapplique sa taille une fois WRY prêt, puis on sauvegarde sur le thread UI
/// après 600 ms sans resize/move. Le passage par le thread UI évite le deadlock
/// amont du plugin (verrou du cache + getter de fenêtre depuis un worker).
#[cfg(not(target_os = "android"))]
fn install_window_state_resilience(app: &tauri::App<TauriRuntime>) {
    use std::sync::atomic::Ordering as AtomicOrdering;
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    let saved = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(".window-state.json")).ok())
        .and_then(|raw| serde_json::from_str::<SavedWindowStates>(&raw).ok())
        .and_then(|states| states.main)
        .filter(|state| state.width > 0 && state.height > 0);

    let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(saved.is_none()));
    let (save, requests) = std::sync::mpsc::sync_channel::<()>(1);
    app.manage(WindowStatePersistence {
        save,
        ready: ready.clone(),
    });

    let save_app = app.handle().clone();
    thread::spawn(move || {
        while requests.recv().is_ok() {
            // Un drag produit beaucoup d'événements : attendre le dernier et
            // ne faire qu'une écriture disque.
            while requests.recv_timeout(Duration::from_millis(600)).is_ok() {}
            let app = save_app.clone();
            let _ = save_app.run_on_main_thread(move || {
                let flags = StateFlags::SIZE
                    | StateFlags::POSITION
                    | StateFlags::MAXIMIZED
                    | StateFlags::FULLSCREEN;
                if let Err(error) = app.save_window_state(flags) {
                    log::warn!("[Sion][fenêtre] sauvegarde différée impossible: {error}");
                }
            });
        }
    });

    let Some(saved) = saved else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        ready.store(true, AtomicOrdering::Release);
        return;
    };
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(700));
        let result = if saved.maximized {
            window.maximize()
        } else if saved.fullscreen {
            // Le plugin a déjà restauré le fullscreen. Conserver ici la taille
            // normale en cache pour le retour au mode fenêtré.
            Ok(())
        } else {
            window.set_size(tauri::PhysicalSize::new(saved.width, saved.height))
        };
        match result {
            Ok(()) => log::info!(
                "[Sion][fenêtre] état restauré après initialisation WRY: {}x{} maximisée={} plein-écran={}",
                saved.width,
                saved.height,
                saved.maximized,
                saved.fullscreen
            ),
            Err(error) => log::warn!("[Sion][fenêtre] restauration différée impossible: {error}"),
        }
        ready.store(true, AtomicOrdering::Release);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    let shortcuts: SharedShortcuts = Arc::new(Mutex::new(ShortcutState {
        mute_keys: vec![],
        deafen_keys: vec![],
    }));

    #[cfg(target_os = "linux")]
    let shortcuts_clone = shortcuts.clone();

    #[cfg(target_os = "linux")]
    let shortcuts_managed = shortcuts.clone();

    let builder = tauri::Builder::<TauriRuntime>::default();

    #[cfg(target_os = "linux")]
    let builder = builder.manage(shortcuts_managed);

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        update_shortcuts,
        get_shortcut_ws_port,
        open_url,
        open_file_default,
        download_file,
        open_local_file,
        show_in_folder,
        fetch_link_preview,
        transcode_video,
        stage_media,
        read_media,
        media_server_port,
        av1_playable_natively,
        prepare_video_for_send,
        exit_app,
        persist_session,
        load_session,
        system_locale,
        pick_ffmpeg_path,
        pick_audio_file,
        pick_image_file,
        read_file_b64,
        read_clipboard_image,
        read_dropped_file,
        detect_ffmpeg,
        download_ffmpeg,
        detect_ytdlp,
        download_ytdlp,
        pick_ytdlp_path,
        ytdlp_versions,
        probe_url_media,
        import_url_audio,
        probe_url_formats,
        import_url_video,
        save_imported_audio,
        cursor_overlay::cursor_overlay_open,
        cursor_overlay::cursor_overlay_close,
        native_video_surface::native_video_surface_available,
        native_video_surface::native_video_surfaces_set,
        pip_window::pip_native_open,
        pip_window::pip_native_close,
        pip_window::pip_native_status,
        transcribe::transcribe_start,
        transcribe::transcribe_start_native,
        transcribe::transcribe_stop,
        detect_asr_model,
        download_asr_model,
        delete_asr_model,
        summarize::detect_summary_assets,
        summarize::download_llama,
        summarize::download_summary_model,
        summarize::summarize_transcript,
        summarize::delete_summary_assets,
        summarize::llama_versions,
        tts::list_tts_models,
        tts::detect_tts_engine,
        tts::pick_tts_engine_path,
        tts::download_tts_engine,
        tts::download_tts_model,
        tts::delete_tts_model,
        tts::tts_generate,
        voice_native::voice_native_status,
        voice_native::voice_native_available,
        voice_native::voice_native_audio_devices,
        voice_native::voice_native_switch_audio_device,
        voice_native::voice_native_set_audio_processing,
        voice_native::voice_native_start_microphone_test,
        voice_native::voice_native_stop_audio_test,
        voice_native::voice_native_audio_level,
        voice_native::voice_native_test_speaker,
        voice_native::voice_native_set_audio_quality,
        voice_native::voice_native_debug,
        voice_native::voice_native_connect,
        voice_native::voice_native_disconnect,
        voice_native::voice_native_play_soundboard,
        voice_native::voice_native_set_muted,
        voice_native::voice_native_set_deafened,
        voice_native::voice_native_set_e2ee_key,
        voice_native::voice_native_publish_data,
        voice_native::voice_native_extend_soundboard_badge,
        voice_native::voice_media_caps,
        voice_native::voice_native_set_screenshare_audio_muted,
        voice_native::voice_native_set_screenshare_audio_volume,
        voice_native::voice_native_get_screenshare_audio_state,
        voice_native::voice_native_video_port,
        voice_native::voice_native_set_screensharing
    ]);

    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_url,
        open_file_default,
        download_file,
        open_local_file,
        show_in_folder,
        fetch_link_preview,
        transcode_video,
        stage_media,
        read_media,
        media_server_port,
        av1_playable_natively,
        prepare_video_for_send,
        exit_app,
        persist_session,
        load_session,
        system_locale,
        voice_native::voice_native_status,
        voice_native::voice_native_available,
        voice_native::voice_native_audio_devices,
        voice_native::voice_native_switch_audio_device,
        voice_native::voice_native_set_audio_processing,
        voice_native::voice_native_start_microphone_test,
        voice_native::voice_native_stop_audio_test,
        voice_native::voice_native_audio_level,
        voice_native::voice_native_test_speaker,
        voice_native::voice_native_set_audio_quality,
        voice_native::voice_native_debug,
        voice_native::voice_native_connect,
        voice_native::voice_native_disconnect,
        voice_native::voice_native_play_soundboard,
        voice_native::voice_native_set_muted,
        voice_native::voice_native_set_deafened,
        voice_native::voice_native_set_e2ee_key,
        voice_native::voice_native_publish_data,
        voice_native::voice_native_extend_soundboard_badge,
        voice_native::voice_media_caps,
        voice_native::voice_native_set_screenshare_audio_muted,
        voice_native::voice_native_set_screenshare_audio_volume,
        voice_native::voice_native_get_screenshare_audio_state,
        voice_native::voice_native_video_port,
        voice_native::voice_native_set_screensharing
    ]);

    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    // Persist window position/size/maximised/fullscreen across app launches.
    // Desktop only — Android windows are OS-managed fullscreen views, the
    // plugin has nothing to persist there. The plugin hooks Tauri's window
    // events under the hood; no JS glue needed for the default behaviour.
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            // Logging enabled in debug AND release: the shipped Windows build
            // (windows_subsystem="windows") has no console, so without an
            // installed logger Rust `log::*` output is silently dropped and
            // there's no way to diagnose issues on it. The Webview target
            // surfaces Rust logs in DevTools (exportable); the default LogDir
            // target also writes them to a file, dans le dossier de données de
            // l'application (`AppData\Local\com.sion.client\logs` sous
            // Windows). Le viser ailleurs a été essayé puis annulé le 17/09 :
            // écrire des journaux dans le dossier d'INSTALLATION mélange des
            // fichiers qui changent sans cesse avec un dossier censé ne bouger
            // qu'aux mises à jour, et un désinstalleur les emporterait.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Webview,
                    ))
                    .build(),
            )?;

            #[cfg(not(target_os = "android"))]
            install_window_state_resilience(app);

            // ── Réglages WebKit du web process (perf mémoire, 2026-09-12) ──
            // Mesuré : la release est plate (691 → 694 Mo sur 28 min) mais son
            // plancher est ~690 Mo, tout côté web process. WebKit y entretient
            // des caches dont l'app n'a aucun usage : tout son contenu vient du
            // réseau (Matrix) et de l'IPC natif, jamais du cache disque, et le
            // page cache garde en mémoire la page précédente à chaque
            // rechargement (mesuré en dev : +100-200 Mo par reload, jamais
            // rendus). Modèle de cache « document viewer » = l'équivalent d'un
            // navigateur sans cache pour une app qui ne navigue pas.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                // Le repli NVIDIA relance l'appli : il lui faut ce handle.
                let gpu_handle = app.handle().clone();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(move |webview| {
                        use webkit2gtk::{
                            CacheModel, SettingsExt, WebContextExt, WebViewExt,
                        };
                        let view = webview.inner();
                        if let Some(context) = view.context() {
                            // `DocumentViewer` était utilisé ici : WebKit le
                            // documente comme « désactive complètement le
                            // cache », prévu pour une application affichant un
                            // seul fichier local sans navigation. C'est ce qui
                            // cassait TOUTE lecture vidéo — mesuré le 17/09.
                            // Un média passe par le cache de ressources du
                            // moteur : sans lui, l'élément lit ses métadonnées,
                            // joue les deux secondes qu'il a en mémoire, puis
                            // s'arrête. Sans erreur, sans événement, quel que
                            // soit le codec, le conteneur ou le transport —
                            // base64, `asset:`, `blob:` ou HTTP local. Les
                            // mêmes fichiers se lisent intégralement dans
                            // MiniBrowser, qui utilise le modèle par défaut.
                            //
                            // `DocumentBrowser` garde un cache modeste, ce dont
                            // le lecteur a besoin, sans revenir au cache disque
                            // d'un navigateur complet. Le gain mémoire visé à
                            // l'origine — 100 à 200 Mo par rechargement — venait
                            // du PAGE cache, réglage distinct, désactivé juste
                            // en dessous et conservé.
                            context.set_cache_model(CacheModel::DocumentBrowser);
                        }
                        if let Some(settings) = view.settings() {
                            settings.set_enable_page_cache(false);
                        }
                        log::info!(
                            "[Sion][webkit] caches bridés (document browser, page cache off)"
                        );
                        // Page blanche sous pilote NVIDIA : surveille le web
                        // process (cf. `gpu_fallback`).
                        crate::gpu_fallback::watch_web_process(&gpu_handle, &view);
                        // Surface intégrée native par défaut. Le correctif WRY
                        // garde la WebView interactive sous Wayland ; un
                        // opt-out explicite reste disponible pour diagnostiquer
                        // un pilote/compositeur exotique.
                        if std::env::var_os("SION_DISABLE_NATIVE_VIDEO_SURFACE").is_none() {
                            if let Err(err) =
                                crate::native_video_surface::attach(&gpu_handle, &view)
                            {
                                log::warn!(
                                    "[Sion][partage-natif] surface GTK indisponible: {err}"
                                );
                            }
                        } else {
                            log::info!(
                                "[Sion][partage-natif] surface GTK désactivée par SION_DISABLE_NATIVE_VIDEO_SURFACE"
                            );
                        }
                    });
                }
            }

            // WebView2 est déjà un enfant de cette fenêtre. Les surfaces HWND
            // sont des enfants frères, placés exactement sur les canvas DOM :
            // les frames BGRA restent hors de JavaScript et les hit-tests
            // traversent vers la WebView.
            // Sous Windows la surface native est OPT-IN, contrairement à Linux.
            //
            // Elle se déclare disponible et le moteur lui envoie les frames —
            // « frames vidéo … en surface native (sans JPEG ni ticker) » — mais
            // l'image reste noire chez le viewer (alpha 5, 17/09, partage VP8
            // 1920x1080 reçu). Elle n'a jamais été validée en session réelle ;
            // la feuille de route le note comme critère de sortie non atteint.
            //
            // Tant que ce n'est pas diagnostiqué sur une vraie machine, le
            // chemin JPEG — celui d'alpha 4, fonctionnel — reprend la main.
            // `SION_NATIVE_VIDEO_SURFACE=1` la réactive pour le diagnostic.
            #[cfg(target_os = "windows")]
            if std::env::var_os("SION_NATIVE_VIDEO_SURFACE").is_some()
                && std::env::var_os("SION_DISABLE_NATIVE_VIDEO_SURFACE").is_none()
            {
                if let Some(window) = app.get_webview_window("main") {
                    match (window.hwnd(), window.scale_factor()) {
                        (Ok(hwnd), Ok(scale_factor)) => {
                            if let Err(err) = crate::native_video_surface::attach(
                                app.handle(),
                                hwnd.0 as isize,
                                scale_factor,
                            ) {
                                log::warn!(
                                    "[Sion][partage-natif/windows] surface HWND indisponible: {err}"
                                );
                            }
                        }
                        (Err(err), _) | (_, Err(err)) => log::warn!(
                            "[Sion][partage-natif/windows] fenêtre principale inaccessible: {err}"
                        ),
                    }
                }
            }

            // Diagnostic : overlay curseurs ouvert au démarrage
            // (`SION_OVERLAY_OPEN=1`) — fenêtre + blit sans attendre un viewer.
            #[cfg(not(target_os = "android"))]
            crate::cursor_overlay::maybe_autotest_open();

            // Sans sink, WebRTC n'émet aucun log (échecs PipeWire/portail
            // indiscernables d'une absence de frame).
            #[cfg(feature = "native-voice")]
            crate::voice_engine::install_webrtc_log_sink();

            // Actions des boutons du PIP natif (retour sur Sion, son du
            // partage) : la fenêtre vit sur un fil winit hors de l'arbre
            // Tauri — elle a besoin de ce handle pour agir.
            pip_window::set_app_handle(app.handle().clone());
            // Préchauffe la boucle winit du PIP : le premier clic ne paie
            // plus sa construction.
            pip_window::prewarm();

            // WebSocket server for global shortcuts (évite l'IPC Tauri, dont
            // les événements peuvent être différés quand la fenêtre n'a pas
            // le focus selon le runtime webview).
            #[cfg(not(target_os = "android"))]
            start_ws_server();

            // rdev captures keyboard events at the evdev level — Linux only.
            // Works when focused (even on Wayland). The plugin handles background.
            #[cfg(target_os = "linux")]
            {
                use rdev::{listen, EventType};
                let sc = shortcuts_clone;

                thread::spawn(move || {
                    let pressed_keys: Arc<Mutex<HashSet<Key>>> =
                        Arc::new(Mutex::new(HashSet::new()));
                    let last_mute = Arc::new(Mutex::new(
                        std::time::Instant::now() - Duration::from_secs(1),
                    ));
                    let last_deafen = Arc::new(Mutex::new(
                        std::time::Instant::now() - Duration::from_secs(1),
                    ));
                    let pk = pressed_keys.clone();
                    let lm = last_mute.clone();
                    let ld = last_deafen.clone();

                    log::info!("[Sion] Starting rdev input listener...");
                    if let Err(e) = listen(move |event| match event.event_type {
                        EventType::KeyPress(key) => {
                            let mut keys = pk.lock().unwrap();
                            keys.insert(key);
                            let sc_lock = sc.lock().unwrap();
                            let mute_keys = sc_lock.mute_keys.clone();
                            let deafen_keys = sc_lock.deafen_keys.clone();
                            drop(sc_lock);
                            let now = std::time::Instant::now();
                            let debounce = Duration::from_millis(200);
                            if keys_match(&mute_keys, &keys) {
                                let mut lm = lm.lock().unwrap();
                                if now.duration_since(*lm) > debounce {
                                    *lm = now;
                                    push_shortcut_event("mute");
                                }
                            }
                            if keys_match(&deafen_keys, &keys) {
                                let mut ld = ld.lock().unwrap();
                                if now.duration_since(*ld) > debounce {
                                    *ld = now;
                                    push_shortcut_event("deafen");
                                }
                            }
                        }
                        EventType::KeyRelease(key) => {
                            let mut keys = pk.lock().unwrap();
                            keys.remove(&key);
                        }
                        _ => {}
                    }) {
                        log::error!("[Sion] rdev listen failed: {:?}", e);
                    }
                });
            }

            Ok(())
        });

    // Desktop-only graceful close handler. On Android there's no window
    // X button (the app stays alive in the background), and the desktop-
    // specific `Window::destroy()` API isn't available — so this whole
    // handler is gated to non-Android targets.
    #[cfg(not(target_os = "android"))]
    let builder = builder.on_window_event(|window, event| {
        // Only the main window needs the graceful-shutdown dance. Secondary
        // windows (e.g. the cursor-overlay created by the JS side) must be
        // allowed to close immediately — delaying them here blocks the
        // JS-side `closeCursorOverlay()` path and emitting
        // `sion-graceful-shutdown` from any window close would also tear
        // down the voice session just because the overlay was closed.
        if window.label() != "main" {
            return;
        }
        if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
        ) {
            if let Some(state) = window.try_state::<WindowStatePersistence>() {
                use std::sync::atomic::Ordering as AtomicOrdering;
                if state.ready.load(AtomicOrdering::Acquire) {
                    let _ = state.save.try_send(());
                }
            }
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let win = window.clone();
            // Persist size/position NOW, while the window is still alive. The
            // window-state plugin only flushes to disk on RunEvent::Exit, and
            // our prevent_close + delayed destroy() can race or be cut short
            // (force-kill, crash) before that ever fires — so the file would
            // never get written. An explicit save here guarantees it.
            {
                use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                if let Err(e) = window.app_handle().save_window_state(StateFlags::all()) {
                    log::warn!("[Sion] save_window_state failed: {}", e);
                }
            }
            let _ = window.emit("sion-graceful-shutdown", ());
            // Give JS ~1.5s to flush the LiveKit WS leave + MatrixRTC
            // membership state event before forcing the close.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let _ = win.destroy();
            });
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
