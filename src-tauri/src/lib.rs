#[cfg(target_os = "linux")]
use rdev::Key;
use tauri::Emitter;
use tauri::Manager;

#[cfg(not(target_os = "android"))]
mod cursor_overlay;
#[cfg(target_os = "linux")]
mod portal_shortcuts;
#[cfg(target_os = "windows")]
mod win_shortcuts;
#[cfg(not(target_os = "android"))]
mod system_audio;
#[cfg(not(target_os = "android"))]
mod transcribe;
#[cfg(not(target_os = "android"))]
mod summarize;
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
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use std::thread;
use std::time::Duration;
#[cfg(not(target_os = "android"))]
use tungstenite::Message;

#[cfg(feature = "cef")]
pub(crate) type TauriRuntime = tauri::Cef;
#[cfg(not(feature = "cef"))]
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
        "Numpad0" => Some(Key::Kp0), "Numpad1" => Some(Key::Kp1), "Numpad2" => Some(Key::Kp2),
        "Numpad3" => Some(Key::Kp3), "Numpad4" => Some(Key::Kp4), "Numpad5" => Some(Key::Kp5),
        "Numpad6" => Some(Key::Kp6), "Numpad7" => Some(Key::Kp7), "Numpad8" => Some(Key::Kp8),
        "Numpad9" => Some(Key::Kp9),
        // "KeyA" / "Digit1" → recurse on the trailing letter/digit.
        s if s.len() == 4 && s.starts_with("Key") => parse_key(&s[3..]),
        s if s.len() == 6 && s.starts_with("Digit") => parse_key(&s[5..]),
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap().to_ascii_uppercase();
            match c {
                'A' => Some(Key::KeyA), 'B' => Some(Key::KeyB), 'C' => Some(Key::KeyC),
                'D' => Some(Key::KeyD), 'E' => Some(Key::KeyE), 'F' => Some(Key::KeyF),
                'G' => Some(Key::KeyG), 'H' => Some(Key::KeyH), 'I' => Some(Key::KeyI),
                'J' => Some(Key::KeyJ), 'K' => Some(Key::KeyK), 'L' => Some(Key::KeyL),
                'M' => Some(Key::KeyM), 'N' => Some(Key::KeyN), 'O' => Some(Key::KeyO),
                'P' => Some(Key::KeyP), 'Q' => Some(Key::KeyQ), 'R' => Some(Key::KeyR),
                'S' => Some(Key::KeyS), 'T' => Some(Key::KeyT), 'U' => Some(Key::KeyU),
                'V' => Some(Key::KeyV), 'W' => Some(Key::KeyW), 'X' => Some(Key::KeyX),
                'Y' => Some(Key::KeyY), 'Z' => Some(Key::KeyZ),
                '0' => Some(Key::Num0), '1' => Some(Key::Num1), '2' => Some(Key::Num2),
                '3' => Some(Key::Num3), '4' => Some(Key::Num4), '5' => Some(Key::Num5),
                '6' => Some(Key::Num6), '7' => Some(Key::Num7), '8' => Some(Key::Num8),
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
        Key::ControlLeft => pressed.contains(&Key::ControlLeft) || pressed.contains(&Key::ControlRight),
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
        "default", "sysdefault", "pipewire", "pulse", "dmix", "dsnoop",
        "hw:", "plughw:", "null", "lavrate", "samplerate", "speexrate",
        "jack", "oss", "surround", "upmix", "vdownmix",
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

        let dev_num = name.find("DEV=").map(|i| &name[i + 4..]).and_then(|s| s.split(',').next());

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

/// Move Sion's audio stream to a specific PulseAudio source/sink,
/// WITHOUT changing the system default.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn switch_audio_device(device_id: String, kind: String) -> Result<(), String> {
    let pa_name = if device_id.starts_with("alsa_") {
        device_id.clone()
    } else {
        resolve_pa_name(&device_id, &kind)?
    };

    if kind == "input" {
        let indices = find_pa_stream_indices("source-outputs", "sion-client");
        if indices.is_empty() {
            return Err("No active source-output for sion-client".into());
        }
        for idx in &indices {
            log::info!("[Sion] Moving source-output {} to: {}", idx, pa_name);
            run_pactl(&["move-source-output", &idx.to_string(), &pa_name])?;
        }
    } else {
        let indices = find_pa_stream_indices("sink-inputs", "sion-client");
        if indices.is_empty() {
            return Err("No active sink-input for sion-client".into());
        }
        for idx in &indices {
            log::info!("[Sion] Moving sink-input {} to: {}", idx, pa_name);
            run_pactl(&["move-sink-input", &idx.to_string(), &pa_name])?;
        }
    }
    Ok(())
}

/// Set the PulseAudio default source or sink (no stream moving).
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn set_default_audio(device_id: String, kind: String) -> Result<(), String> {
    let pa_name = if device_id.starts_with("alsa_") {
        device_id
    } else {
        resolve_pa_name(&device_id, &kind)?
    };
    let cmd = if kind == "input" { "set-default-source" } else { "set-default-sink" };
    run_pactl(&[cmd, &pa_name])
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
    if name.is_empty() { None } else { Some(name) }
}

/// Get the default audio devices (source + sink) with their friendly names.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn get_default_audio_devices() -> DefaultAudioDevices {
    let source_name = get_pa_default("source").unwrap_or_default();
    let sink_name = get_pa_default("sink").unwrap_or_default();

    // Look up friendly descriptions from full device list
    let devices = list_audio_devices();
    let source_label = devices.iter()
        .find(|d| d.id == source_name && d.kind == "input")
        .map(|d| d.name.clone())
        .unwrap_or(source_name.clone());
    let sink_label = devices.iter()
        .find(|d| d.id == sink_name && d.kind == "output")
        .map(|d| d.name.clone())
        .unwrap_or(sink_name.clone());

    DefaultAudioDevices {
        source_id: source_name,
        source_label,
        sink_id: sink_name,
        sink_label,
    }
}

#[derive(Serialize)]
struct DefaultAudioDevices {
    source_id: String,
    source_label: String,
    sink_id: String,
    sink_label: String,
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

#[cfg(not(target_os = "android"))]
fn resolve_pa_name(cpal_id: &str, kind: &str) -> Result<String, String> {
    let card_name = cpal_id
        .find("CARD=")
        .map(|i| {
            let after = &cpal_id[i + 5..];
            after.split(',').next().unwrap_or(after)
        })
        .unwrap_or(cpal_id)
        .to_lowercase();

    let pa_type = if kind == "input" { "sources" } else { "sinks" };
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", pa_type, "short"])
        .output()
        .map_err(|e| format!("pactl failed: {}", e))?;

    let json_str = String::from_utf8_lossy(&output.stdout);
    for entry in json_str.split("\"name\":\"") {
        if let Some(end) = entry.find('"') {
            let name = &entry[..end];
            if kind == "input" && name.contains(".monitor") { continue; }
            if name.to_lowercase().replace(['_', '-'], "").contains(&card_name.replace(['_', '-'], "")) {
                return Ok(name.to_string());
            }
        }
    }
    Err(format!("No PulseAudio {} matching '{}'", pa_type, card_name))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
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
        if source.name.contains(".monitor") { continue; }
        devices.push(AudioDevice { id: source.name, name: source.description, kind: "input".into() });
    }

    // Sinks (outputs)
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", "sinks"])
        .output()
        .map_err(|e| e.to_string())?;
    for sink in parse_pa_devices(&String::from_utf8_lossy(&output.stdout)) {
        devices.push(AudioDevice { id: sink.name, name: sink.description, kind: "output".into() });
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
        let Some(name_start) = json[pos..].find(name_key) else { break };
        let name_start = pos + name_start + name_key.len();
        pos = name_start;

        let name = extract_json_string(&json[name_start..]).unwrap_or_default();
        // Skip nested "name" fields from ports/profiles — real sources/sinks
        // start with "alsa_" (e.g. "alsa_input.usb-...").
        if name.is_empty() || !name.starts_with("alsa_") { continue; }

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
                let d = extract_json_string(&search_window[desc_start + desc_key2.len()..]).unwrap_or_default();
                if d != "(null)" { d } else { name.clone() }
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
    if !s.starts_with('"') { return None; }
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
        if is_virtual_alsa_device(&raw_name) { continue; }
        let label = prettify_alsa_name(&raw_name);
        let is_input = device.supported_input_configs().map(|mut c| c.next().is_some()).unwrap_or(false);
        let is_output = device.supported_output_configs().map(|mut c| c.next().is_some()).unwrap_or(false);
        if is_input { devices.push(AudioDevice { id: raw_name.clone(), name: label.clone(), kind: "input".into() }); }
        if is_output { devices.push(AudioDevice { id: raw_name, name: label, kind: "output".into() }); }
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
    use base64::Engine;
    let resp = client.get(image_url).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let content_type = resp.headers().get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.ok()?;
    // Limit image to 2MB
    if bytes.len() > 2 * 1024 * 1024 { return None; }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", content_type, b64))
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    fetch_link_preview_inner(&url).await.map_err(|e| {
        let msg = format!("[Sion] Link preview failed for {}: {}", url, e);
        log::warn!("{}", msg);
        msg
    })
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
        format!("https://www.youtube.com/oembed?url={}&format=json", encoded_url)
    } else if url.contains("vimeo.com/") {
        format!("https://vimeo.com/api/oembed.json?url={}", encoded_url)
    } else if url.contains("twitter.com/") || url.contains("x.com/") {
        format!("https://publish.twitter.com/oembed?url={}", encoded_url)
    } else {
        return None;
    };

    let resp = client.get(&oembed_url).send().await.ok()?;
    if !resp.status().is_success() { return None; }

    let json: serde_json::Value = resp.json().await.ok()?;
    let title = json["title"].as_str().map(|s| s.to_string());
    let author = json["author_name"].as_str().map(|s| s.to_string());
    let site_name = json["provider_name"].as_str().map(|s| s.to_string());
    let image = json["thumbnail_url"].as_str().map(|s| s.to_string());

    if title.is_none() && author.is_none() { return None; }

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
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await?;

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
                if let Ok(selector) = scraper::Selector::parse(&format!("meta[{}=\"{}\"]", attr, tag)) {
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
            if trimmed.is_empty() { None } else { Some(trimmed) }
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

    Ok(LinkPreview { title, description, image, site_name })
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
    let path = temp_dir.join(&filename);

    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
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

    // Avoid overwriting: append (1), (2), etc. if file already exists
    let base = std::path::Path::new(&filename);
    let stem = base.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = base.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut path = downloads.join(&filename);
    let mut counter = 1u32;
    while path.exists() {
        path = downloads.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }

    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("open file: {e}"))?;
    Ok(())
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    open::that(dir).map_err(|e| format!("open folder: {e}"))?;
    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle<TauriRuntime>) {
    app.exit(0);
}

// Persist a small session blob (auth credentials + device_id/user_id) OUTSIDE
// the Chromium/CEF profile. localStorage lives inside that profile and gets
// reset on a CEF/Chromium major upgrade (observed 144→148: logged out + new
// device + recovery-key re-entry) and by the "purge cache" action. app_data_dir
// (%APPDATA% / ~/.local/share) is separate from the CEF cache_path
// (dirs::cache_dir()/<id>/cef) so this file survives both — letting JS restore
// the session on boot and avoid forced re-login + device churn.
#[tauri::command]
fn persist_session(app: tauri::AppHandle<TauriRuntime>, json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("session.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(std::fs::read_to_string(dir.join("session.json")).unwrap_or_default())
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
        .add_filter("Audio", &["ogg", "mp3", "wav", "m4a", "oga", "opus", "flac"])
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Read an arbitrary local file as base64. Used to load a user-picked cue
/// sound (outside the bundle) so the renderer can turn it into a blob URL —
/// CEF can't `new Audio()` an arbitrary file:// path directly. Capped at 5 MB
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
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cues");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let safe_ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dest = dir.join(format!("cue_{}.{}", stamp, if safe_ext.is_empty() { "webm".into() } else { safe_ext }));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn start_voice_service(_channel_name: String, _is_muted: bool, _is_deafened: bool) {
    // On Android, the JS calls window.__SION__.startVoiceService() directly via JavascriptInterface
    // This command is a no-op stub so invoke() doesn't error on desktop
}

#[tauri::command]
fn stop_voice_service() {
    // On Android, the JS calls window.__SION__.stopVoiceService() directly via JavascriptInterface
    // This command is a no-op stub so invoke() doesn't error on desktop
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
    let tmp_dir = std::env::temp_dir();
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
    if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if (name_str.starts_with("sion_in_") || name_str.starts_with("sion_out_"))
                && entry.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Transcode a video URL to WebM (VP9+Opus) using system ffmpeg.
/// Returns base64-encoded WebM data.
#[tauri::command]
async fn transcode_video(
    app: tauri::AppHandle<TauriRuntime>,
    url: String,
    ffmpeg_path: Option<String>,
    data_b64: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
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
    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join(format!("sion_in_{:x}.mp4", hash));
    let output_path = tmp_dir.join(format!("sion_out_{:x}.webm", hash));

    // Return cached transcoded file if it exists
    if output_path.exists() {
        let webm_bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&webm_bytes);
        return Ok(b64);
    }

    // Obtain the source bytes. Prefer the bytes the renderer already resolved
    // (it has handled E2EE decryption + Matrix media auth) and passed in as
    // base64 — re-downloading the URL here would have NO access token and NO
    // decryption, so it fails on authenticated-media servers (401) and on
    // encrypted channels (we'd fetch ciphertext that ffmpeg can't decode).
    // Fall back to downloading the URL only when no bytes were provided.
    if let Some(b64) = data_b64.filter(|s| !s.is_empty()) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("base64 decode: {}", e))?;
        std::fs::write(&input_path, &bytes).map_err(|e| e.to_string())?;
    } else {
        let client = build_client().map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        std::fs::write(&input_path, &bytes).map_err(|e| e.to_string())?;
    }

    // Transcode with ffmpeg (fast preset)
    let output = hidden_command(&ffmpeg_bin)
        .args(["-y", "-i"])
        .arg(&input_path)
        .args(["-c:v", "libvpx-vp9", "-crf", "35", "-b:v", "0",
               "-deadline", "realtime", "-cpu-used", "8",
               "-c:a", "libopus", "-b:a", "96k",
               "-f", "webm"])
        .arg(&output_path)
        .output()
        .map_err(|e| format!("ffmpeg not found: {}", e))?;

    let _ = std::fs::remove_file(&input_path);

    if !output.status.success() {
        let _ = std::fs::remove_file(&output_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg error: {}", stderr));
    }

    let webm_bytes = std::fs::read(&output_path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&webm_bytes);
    Ok(b64)
}

/// Path where the in-app "Installer ffmpeg" button stores the downloaded
/// binary: `<app-data>/bin/ffmpeg[.exe]`. Survives CEF upgrades (app-data is
/// outside the Chromium profile). None if the app-data dir can't be resolved.
#[cfg(not(target_os = "android"))]
fn managed_ffmpeg_path(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
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
            let name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
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
#[tauri::command]
fn detect_ffmpeg(app: tauri::AppHandle<TauriRuntime>) -> Option<String> {
    let managed = managed_ffmpeg_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ffmpeg(None, managed.as_deref());
    if bin_runs(&bin, "-version") { Some(bin) } else { None }
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
        .arg("-xf").arg(&archive).arg("-C").arg(&ext_dir)
        .output()
        .map_err(|e| format!("tar introuvable: {}", e))?;
    if !out.status.success() {
        return Err(format!("extraction échouée: {}", String::from_utf8_lossy(&out.stderr)));
    }

    // Locate the ffmpeg binary in the extracted tree.
    let bin_name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let found = find_file(&ext_dir, bin_name).ok_or("binaire ffmpeg absent de l'archive")?;
    std::fs::copy(&found, &dest).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest).map_err(|e| e.to_string())?.permissions();
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
        "parakeet-v3" => Some(("parakeet-tdt-0.6b-v3-gguf", "parakeet-tdt-0.6b-v3-Q5_K_M.gguf")), // ~549 MB, 25 langues, très rapide CPU
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
/// Same convention as the managed ffmpeg: survives CEF profile purges.
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
    let name = if cfg!(target_os = "windows") { "yt-dlp.exe" } else { "yt-dlp" };
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
#[tauri::command]
fn detect_ytdlp(app: tauri::AppHandle<TauriRuntime>) -> Option<String> {
    let managed = managed_ytdlp_path(&app).map(|p| p.to_string_lossy().into_owned());
    let bin = resolve_ytdlp(None, managed.as_deref());
    if bin_runs(&bin, "--version") { Some(bin) } else { None }
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
        json.get("tag_name").and_then(|v| v.as_str()).map(|s| s.to_string())
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
        let mut perms = std::fs::metadata(&dest).map_err(|e| e.to_string())?.permissions();
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
        .args(["--no-playlist", "--playlist-items", "1", "--skip-download", "--no-warnings",
               "--print", "%(duration)s|%(title)s"])
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
    if let Some(s) = start_sec { (s as u64).hash(&mut hasher); }
    let work = std::env::temp_dir().join(format!("sion_yt_{:x}", hasher.finish()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let out_tmpl = work.join("audio.%(ext)s");

    let mut cmd = hidden_command(&ytdlp_bin);
    cmd.arg(&url)
        .args(["-f", "bestaudio/best", "--no-playlist", "--playlist-items", "1", "--no-warnings", "--no-part"])
        .arg("-o").arg(&out_tmpl)
        .args(["--ffmpeg-location", &ffmpeg_bin]);

    // Bounded section for long videos: cut precisely with keyframes.
    if let (Some(s), Some(e)) = (start_sec, end_sec) {
        if e > s {
            cmd.args(["--download-sections", &format!("*{}-{}", s, e), "--force-keyframes-at-cuts"]);
        }
    }

    let output = cmd.output().map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!("yt-dlp: {}", String::from_utf8_lossy(&output.stderr)));
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
    let ext = audio.extension().and_then(|e| e.to_str()).unwrap_or("webm").to_string();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let _ = std::fs::remove_dir_all(&work);
    Ok(serde_json::json!({ "ext": ext, "data": b64 }).to_string())
}

/// Normalize a yt-dlp vcodec string to a short label.
#[cfg(not(target_os = "android"))]
fn vcodec_label(v: &str) -> &'static str {
    if v.starts_with("vp9") || v.starts_with("vp09") { "VP9" }
    else if v.starts_with("avc") || v.starts_with("h264") { "H.264" }
    else if v.starts_with("av01") || v.starts_with("av1") { "AV1" }
    else { "?" }
}

/// Codec preference for native CEF playback: VP9 (webm, plays natively) > H.264
/// (mp4, needs transcode) > AV1 (uncertain). Lower = preferred.
#[cfg(not(target_os = "android"))]
fn vcodec_rank(label: &str) -> u8 {
    match label { "VP9" => 0, "H.264" => 1, "AV1" => 2, _ => 3 }
}

/// Parse a yt-dlp `--newline` download line ("[download]  45.2% of ...") → percent.
#[cfg(not(target_os = "android"))]
fn parse_download_pct(line: &str) -> Option<f64> {
    let l = line.trim_start();
    if !l.starts_with("[download]") { return None; }
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
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg introuvable: {}", e))?;
    let mut errp = child.stderr.take().unwrap();
    let errh = std::thread::spawn(move || { let mut s = String::new(); let _ = errp.read_to_string(&mut s); s });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().flatten() {
            if eff > 0.0 {
                if let Some(t) = parse_ffmpeg_time_secs(&line) {
                    let pct = (t / eff * 100.0).clamp(0.0, 99.0);
                    let _ = app.emit("video-import-progress", serde_json::json!({ "phase": "convert", "pct": pct }));
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = errh.join().unwrap_or_default();
    if !status.success() { return Err(err); }
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
        .args(["--dump-json", "--no-playlist", "--playlist-items", "1", "--no-warnings"])
        .arg(&url)
        .output()
        .map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    if !out.status.success() {
        return Err(format!("yt-dlp: {}", String::from_utf8_lossy(&out.stderr)));
    }
    // --dump-json emits NDJSON (one object per line); parse the first object.
    let stdout_str = String::from_utf8_lossy(&out.stdout);
    let first_line = stdout_str.lines().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let json: serde_json::Value = serde_json::from_str(first_line)
        .map_err(|e| format!("JSON yt-dlp: {}", e))?;

    let duration = json.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
    let title = json.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let empty = vec![];
    let formats = json.get("formats").and_then(|v| v.as_array()).unwrap_or(&empty);

    // Estimate a format's byte size: prefer reported filesize, else derive it
    // from the bitrate × duration (many sources — X/Twitter, HLS — omit
    // filesize). `rate_keys` are the kbps fields to try (tbr/vbr for video,
    // abr/tbr for audio).
    let est = |f: &serde_json::Value, rate_keys: &[&str]| -> u64 {
        if let Some(s) = f.get("filesize").and_then(|v| v.as_u64()) { if s > 0 { return s; } }
        if let Some(s) = f.get("filesize_approx").and_then(|v| v.as_u64()) { if s > 0 { return s; } }
        if duration > 0 {
            for k in rate_keys {
                if let Some(r) = f.get(*k).and_then(|v| v.as_f64()) {
                    if r > 0.0 { return (r * 1000.0 / 8.0 * duration as f64) as u64; }
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
            if a.starts_with("opus") && s > 0 { audio_size = s; }
            else if audio_size == 0 { audio_size = s; }
        }
    }

    // Best video-only format per height, preferring VP9 then H.264.
    use std::collections::HashMap;
    let mut best: HashMap<u64, (u8, u64, String)> = HashMap::new(); // height -> (rank, size, ext)
    for f in formats {
        let v = f.get("vcodec").and_then(|x| x.as_str()).unwrap_or("none");
        if v == "none" { continue; }
        let Some(h) = f.get("height").and_then(|x| x.as_u64()) else { continue; };
        if h == 0 { continue; }
        let label = vcodec_label(v);
        let rank = vcodec_rank(label);
        let ext = f.get("ext").and_then(|x| x.as_str()).unwrap_or("mp4").to_string();
        // A combined (progressive) format already includes audio in its tbr;
        // only add the separate audio track for video-only formats.
        let a = f.get("acodec").and_then(|x| x.as_str()).unwrap_or("none");
        let mut size = est(f, &["tbr", "vbr"]);
        if a == "none" { size += audio_size; }
        match best.get(&h) {
            Some((r, _, _)) if *r <= rank => {}
            _ => { best.insert(h, (rank, size, ext)); }
        }
    }

    let mut options: Vec<serde_json::Value> = best.into_iter()
        .map(|(h, (rank, vsize, ext))| {
            let codec = match rank { 0 => "VP9", 1 => "H.264", 2 => "AV1", _ => "?" };
            serde_json::json!({ "height": h, "codec": codec, "ext": ext, "size": vsize })
        })
        .collect();
    options.sort_by_key(|o| o.get("height").and_then(|v| v.as_u64()).unwrap_or(0));

    // Some sources expose a single format with no height/vcodec metadata at all
    // (e.g. X/Twitter animated GIFs served as tweet_video mp4). Offer it as an
    // "original quality" option (height 0) instead of returning nothing.
    if options.is_empty() {
        if let Some(f) = formats.iter().rev().find(|f| f.get("url").and_then(|v| v.as_str()).is_some()) {
            let ext = f.get("ext").and_then(|x| x.as_str()).unwrap_or("mp4");
            let size = est(f, &["tbr", "vbr"]);
            options.push(serde_json::json!({ "height": 0, "codec": "?", "ext": ext, "size": size }));
        }
    }

    Ok(serde_json::json!({ "duration": duration, "title": title, "options": options }).to_string())
}

/// Download a video at a chosen max height (codec auto, preferring VP9 → native
/// CEF playback), optionally a [start,end] section. Returns `{ext, data(b64)}`.
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
    if let Some(s) = start_sec { (s as u64).hash(&mut hasher); }
    let work = std::env::temp_dir().join(format!("sion_ytv_{:x}", hasher.finish()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let out_tmpl = work.join("src.%(ext)s");

    // ── Phase 1: download (+merge / section cut) via yt-dlp, streaming % ──
    let mut dl = hidden_command(&ytdlp_bin);
    dl.arg(&url)
        .args(["--no-playlist", "--playlist-items", "1", "--no-warnings", "--no-part", "--newline"])
        // height 0 = "original quality" fallback (source without height
        // metadata, e.g. X GIFs) — a [height<=0] filter would match nothing.
        .args(["-f", &if h == 0 { "bv*+ba/b".to_string() } else { format!("bv*[height<={h}]+ba/b[height<={h}]") }])
        .args(["-S", "vcodec:vp9,res,ext"])
        .arg("-o").arg(&out_tmpl)
        .args(["--ffmpeg-location", &ffmpeg_bin])
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    if let (Some(s), Some(e)) = (start_sec, end_sec) {
        if e > s {
            dl.args(["--download-sections", &format!("*{}-{}", s, e), "--force-keyframes-at-cuts"]);
        }
    }
    let mut child = dl.spawn().map_err(|e| format!("yt-dlp introuvable: {}", e))?;
    let mut errp = child.stderr.take().unwrap();
    let errh = std::thread::spawn(move || { let mut s = String::new(); let _ = errp.read_to_string(&mut s); s });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().flatten() {
            if let Some(p) = parse_download_pct(&line) {
                let _ = app.emit("video-import-progress", serde_json::json!({ "phase": "download", "pct": p }));
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let dl_err = errh.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!("yt-dlp: {}", dl_err));
    }

    let src = std::fs::read_dir(&work).map_err(|e| e.to_string())?
        .flatten().map(|e| e.path()).find(|p| p.is_file());
    let Some(src) = src else {
        let _ = std::fs::remove_dir_all(&work);
        return Err("yt-dlp n'a produit aucun fichier vidéo".into());
    };

    // ── Phase 2: re-encode to WebM with real progress ──
    let (final_path, final_ext) = if recode_webm == Some(true) {
        let _ = app.emit("video-import-progress", serde_json::json!({ "phase": "convert", "pct": 0.0 }));
        let eff = match (start_sec, end_sec) {
            (Some(s), Some(e)) if e > s => e - s,
            _ => duration_sec.unwrap_or(0.0),
        };
        let out = work.join("out.webm");
        let src_s = src.to_string_lossy().into_owned();
        let out_s = out.to_string_lossy().into_owned();
        let limit = max_bytes.unwrap_or(0);

        // Fit-the-limit bitrate (used only by the fallback candidates), capped by
        // a per-resolution ceiling.
        let ceiling_kbps: u64 = if h <= 360 { 800 } else if h <= 480 { 1200 } else if h <= 720 { 2500 } else if h <= 1080 { 5000 } else { 8000 };
        let fit_kbps: u64 = match (max_bytes, eff) {
            (Some(lim), e) if lim > 0 && e > 0.0 => {
                let budget = (lim as f64 * 8.0 * 0.92 / e / 1000.0) as u64;
                budget.saturating_sub(140).clamp(150, ceiling_kbps)
            }
            _ => ceiling_kbps,
        };
        let fit = format!("{}k", fit_kbps);
        let tail = ["-c:a", "libopus", "-b:a", "128k", "-f", "webm", "-progress", "pipe:1", "-nostats"];
        let mk = |head: &[&str]| -> Vec<String> {
            head.iter().chain(tail.iter()).map(|s| s.to_string())
                .chain(std::iter::once(out_s.clone())).collect()
        };

        // Priority order: constant-QUALITY first (AV1/VP9 beat H.264 at equal
        // quality → smaller file); if that overflows the limit, a bitrate-capped
        // pass guarantees it fits. AV1 (GPU) before VP9 (CPU).
        let mut candidates: Vec<Vec<String>> = Vec::new();
        #[cfg(target_os = "linux")]
        {
            if std::path::Path::new("/dev/dri/renderD128").exists() {
                // AMD AV1 VAAPI uses -global_quality (not -qp) for constant
                // quality; ~125 ≈ good quality, smaller than the source H.264.
                // MUST be scoped to the video stream (:v) — applied globally it
                // hits libopus, which rejects quality-based encoding and aborts.
                candidates.push(mk(&["-y", "-vaapi_device", "/dev/dri/renderD128", "-i", src_s.as_str(),
                    "-vf", "format=nv12,hwupload", "-c:v", "av1_vaapi", "-rc_mode", "CQP", "-global_quality:v", "125"]));
                candidates.push(mk(&["-y", "-vaapi_device", "/dev/dri/renderD128", "-i", src_s.as_str(),
                    "-vf", "format=nv12,hwupload", "-c:v", "av1_vaapi", "-rc_mode", "VBR", "-b:v", fit.as_str(), "-maxrate", fit.as_str()]));
            }
        }
        candidates.push(mk(&["-y", "-i", src_s.as_str(), "-c:v", "libvpx-vp9", "-crf", "33", "-b:v", "0",
            "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-threads", "0"]));
        candidates.push(mk(&["-y", "-i", src_s.as_str(), "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", fit.as_str(),
            "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-threads", "0"]));

        let mut encoded = false;
        for args in &candidates {
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            if run_ffmpeg_encode(&app, &ffmpeg_bin, &refs, eff).is_ok() {
                let sz = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(u64::MAX);
                if limit == 0 || sz <= limit { encoded = true; break; }
            }
            let _ = std::fs::remove_file(&out);
        }
        if !encoded {
            let _ = std::fs::remove_dir_all(&work);
            return Err("Vidéo trop lourde même après compression : choisis une résolution plus basse ou une plage plus courte.".into());
        }

        let _ = app.emit("video-import-progress", serde_json::json!({ "phase": "convert", "pct": 100.0 }));
        let _ = std::fs::remove_file(&src);
        (out, "webm".to_string())
    } else {
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();
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
pub(crate) fn register_plugin_shortcuts(app: &tauri::AppHandle<TauriRuntime>, payload: &UpdateShortcutsPayload) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let mute_sc = if !payload.mute.is_empty() { payload.mute.parse::<Shortcut>().ok() } else { None };
    let deafen_sc = if !payload.deafen.is_empty() { payload.deafen.parse::<Shortcut>().ok() } else { None };

    // Parse all soundboard combos, keeping a map combo → soundId for dispatch.
    let mut soundboard_map: Vec<(Shortcut, String)> = Vec::new();
    for sb in &payload.soundboard {
        if sb.combo.is_empty() { continue; }
        if let Ok(sc) = sb.combo.parse::<Shortcut>() {
            soundboard_map.push((sc, sb.id.clone()));
        }
    }

    let mut to_register: Vec<Shortcut> = Vec::new();
    if let Some(s) = mute_sc { to_register.push(s); }
    if let Some(s) = deafen_sc { to_register.push(s); }
    for (sc, _) in &soundboard_map { to_register.push(*sc); }

    if !to_register.is_empty() {
        let soundboard_clone = soundboard_map.clone();
        if let Err(e) = gs.on_shortcuts(to_register, move |_app, shortcut, event| {
            if event.state != ShortcutState::Pressed { return; }
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
fn update_shortcuts(app: tauri::AppHandle<TauriRuntime>, state: tauri::State<'_, SharedShortcuts>, payload: UpdateShortcutsPayload) {
    let mut shortcuts = state.lock().unwrap();
    shortcuts.mute_keys = parse_shortcut(&payload.mute);
    shortcuts.deafen_keys = parse_shortcut(&payload.deafen);
    drop(shortcuts);
    log::info!("[Sion] Global shortcuts updated: mute={}, deafen={}", payload.mute, payload.deafen);

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
        if sb.combo.is_empty() { continue; }
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
    log::info!("[Sion] Global shortcuts updated: mute={}, deafen={}", payload.mute, payload.deafen);
    // Windows: layout-aware RegisterHotKey path (see win_shortcuts.rs) — the
    // plugin's fixed US VK table binds the wrong keys on AZERTY & co. Clear
    // any plugin grabs from a previous version of this handler first.
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister_all();
        let mut bindings: Vec<win_shortcuts::Binding> = Vec::new();
        if !payload.mute.is_empty() {
            bindings.push(win_shortcuts::Binding { action: "mute".into(), combo: payload.mute.clone() });
        }
        if !payload.deafen.is_empty() {
            bindings.push(win_shortcuts::Binding { action: "deafen".into(), combo: payload.deafen.clone() });
        }
        for sb in &payload.soundboard {
            if sb.combo.is_empty() { continue; }
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
// IPC (invoke) which CEF throttles when the window is unfocused.
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
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let prev = LAST_PUSH_TS.swap(ts, Ordering::Relaxed);
    if ts - prev < 500 { return; } // Deduplicate rdev + plugin firing for same keypress

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
                    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(50)));

                    loop {
                        // Check for messages to send (from push_shortcut_event)
                        while let Ok(msg) = rx.try_recv() {
                            if ws.send(Message::Text(msg.into())).is_err() {
                                return;
                            }
                        }
                        // Non-blocking read: handle ping/close from JS
                        match ws.read() {
                            Ok(Message::Ping(data)) => { let _ = ws.send(Message::Pong(data)); }
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

// poll_shortcuts kept for backward compat but no longer primary path
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn poll_shortcuts() -> (u64, u64) { (0, 0) }

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn get_shortcut_ws_port() -> u16 {
    WS_PORT.load(Ordering::Relaxed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg_attr(feature = "cef", tauri::cef_entry_point)]
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

    // CEF flags to prevent JS suspension when window is unfocused.
    // Without these, WebSocket/timers/events are frozen in background,
    // breaking global keyboard shortcuts.
    // `mut` is only needed on Linux where we push the PipeWire feature below;
    // on other platforms the vec is built and consumed as-is. `allow` avoids
    // a spurious warning on non-Linux targets.
    #[cfg(feature = "cef")]
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut cef_args: Vec<(String, Option<String>)> = vec![
        ("--disable-background-timer-throttling".to_string(), None),
        ("--disable-backgrounding-occluded-windows".to_string(), None),
        ("--disable-renderer-backgrounding".to_string(), None),
        ("--autoplay-policy".to_string(), Some("no-user-gesture-required".to_string())),
    ];

    // Linux-only: WebRtcPipeWireCapturer routes getDisplayMedia through
    // xdg-desktop-portal + PipeWire, which is what lets the portal dialog
    // expose the "Share audio" checkbox on Wayland (KDE / GNOME).
    // Without this, audio during screen share silently never gets captured.
    // On Windows and macOS, screen share audio is handled by the OS-native
    // capture path and needs no extra flag.
    #[cfg(all(feature = "cef", target_os = "linux"))]
    cef_args.push(("--enable-features".to_string(), Some("WebRtcPipeWireCapturer".to_string())));

    // NOTE: a `--disable-features=WaylandPerSurfaceScale,WaylandWpColorManagementV1`
    // flag was added here to fix the Chromium color-manager SIGILL but it
    // breaks CEF webview attachment at startup on this build (segfault in
    // libcef.so OnWebContentsAttached → GetForExtraction). Removed pending
    // a more surgical workaround for the color-manager crash that doesn't
    // disable a feature CEF still expects to be on internally.

    #[cfg(feature = "cef")]
    let builder = builder.command_line_args(cef_args);

    #[cfg(target_os = "linux")]
    let builder = builder.manage(shortcuts_managed);

    #[cfg(not(target_os = "android"))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![update_shortcuts, poll_shortcuts, get_shortcut_ws_port, open_url, open_file_default, download_file, open_local_file, show_in_folder, fetch_link_preview, transcode_video, list_audio_devices, switch_audio_device, set_default_audio, get_default_audio_devices, exit_app, persist_session, load_session, pick_ffmpeg_path, pick_audio_file, read_file_b64, detect_ffmpeg, download_ffmpeg, detect_ytdlp, download_ytdlp, pick_ytdlp_path, ytdlp_versions, probe_url_media, import_url_audio, probe_url_formats, import_url_video, save_imported_audio, start_voice_service, stop_voice_service, cursor_overlay::cursor_overlay_open, cursor_overlay::cursor_overlay_close, cursor_overlay::cursor_overlay_push, cursor_overlay::cursor_overlay_clear, cursor_overlay::cursor_overlay_push_click, system_audio::system_audio_start, system_audio::system_audio_stop, system_audio::system_audio_ws_port, system_audio::system_audio_list_sinks, transcribe::transcribe_start, transcribe::transcribe_stop, detect_asr_model, download_asr_model, delete_asr_model, summarize::detect_summary_assets, summarize::download_llama, summarize::download_summary_model, summarize::summarize_transcript, summarize::delete_summary_assets, summarize::llama_versions]);

    #[cfg(target_os = "android")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![open_url, open_file_default, download_file, open_local_file, show_in_folder, fetch_link_preview, transcode_video, exit_app, persist_session, load_session, start_voice_service, stop_voice_service]);

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
            // target also writes them to a file.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Webview,
                    ))
                    .build(),
            )?;

            // Disable Chromium password manager via CEF preferences
            #[cfg(feature = "cef")]
            {
                use cef::{request_context_get_global_context, value_create, CefString, ImplPreferenceManager, ImplValue};

                if let Some(ctx) = request_context_get_global_context() {
                    if let Some(mut value) = value_create() {
                        value.set_bool(0);
                        let name = CefString::from("credentials_enable_service");
                        let mut error = CefString::default();
                        let result = ImplPreferenceManager::set_preference(&ctx, Some(&name), Some(&mut value), Some(&mut error));
                        if result != 0 {
                            log::info!("[Sion] Disabled Chromium password manager");
                        } else {
                            log::warn!("[Sion] Failed to disable password manager: {:?}", error.to_string());
                        }
                    }
                }
            }

            // WebSocket server for global shortcuts (bypasses CEF JS throttling)
            #[cfg(not(target_os = "android"))]
            start_ws_server();

            // Re-apply the saved window size shortly after launch. Two CEF
            // quirks force this manual path instead of the window-state
            // plugin's own restore:
            //   1. The plugin restores on `on_window_ready`, but the CEF window
            //      has no `display()` yet → its SetSize handler silently
            //      no-ops and the window opens at the config default.
            //   2. The plugin restores via `PhysicalSize`, which the CEF
            //      runtime mis-handles (the window stays at the default);
            //      a `LogicalSize` set_size works (verified empirically).
            // So we wait for the display to attach, read the saved size
            // ourselves, and apply it as a LogicalSize. POSITION is omitted —
            // on Wayland the compositor owns window placement.
            #[cfg(not(target_os = "android"))]
            {
                use tauri::Manager;
                let cfg_dir = app.path().app_config_dir().ok();
                if let Some(win) = app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        let Some(dir) = cfg_dir else { return };
                        let path = dir.join(".window-state.json");
                        let Ok(raw) = std::fs::read_to_string(&path) else { return };
                        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
                        let main = &json["main"];
                        let (w, h) = (main["width"].as_f64(), main["height"].as_f64());
                        if let (Some(w), Some(h)) = (w, h) {
                            if w > 0.0 && h > 0.0 {
                                if main["maximized"].as_bool() == Some(true) {
                                    let _ = win.maximize();
                                } else if let Err(e) = win.set_size(tauri::LogicalSize::new(w, h)) {
                                    log::warn!("[Sion] restore window size failed: {}", e);
                                }
                            }
                        }
                    });
                }
            }

            // rdev captures keyboard events at the evdev level — Linux only.
            // Works when focused (even on Wayland). The plugin handles background.
            #[cfg(target_os = "linux")]
            {
                use rdev::{listen, EventType};
                let sc = shortcuts_clone;

                thread::spawn(move || {
                    let pressed_keys: Arc<Mutex<HashSet<Key>>> = Arc::new(Mutex::new(HashSet::new()));
                    let last_mute = Arc::new(Mutex::new(std::time::Instant::now() - Duration::from_secs(1)));
                    let last_deafen = Arc::new(Mutex::new(std::time::Instant::now() - Duration::from_secs(1)));
                    let pk = pressed_keys.clone();
                    let lm = last_mute.clone();
                    let ld = last_deafen.clone();

                    log::info!("[Sion] Starting rdev input listener...");
                    if let Err(e) = listen(move |event| {
                        match event.event_type {
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
                        }
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

