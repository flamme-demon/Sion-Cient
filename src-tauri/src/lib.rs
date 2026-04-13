#[cfg(target_os = "linux")]
use rdev::Key;
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
type TauriRuntime = tauri::Cef;
#[cfg(not(feature = "cef"))]
type TauriRuntime = tauri::Wry;

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
struct UpdateShortcutsPayload {
    mute: String,
    deafen: String,
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
async fn transcode_video(url: String) -> Result<String, String> {
    use base64::Engine;

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

    // Download video
    let client = build_client().map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&input_path, &bytes).map_err(|e| e.to_string())?;

    // Transcode with ffmpeg (fast preset)
    let output = std::process::Command::new("ffmpeg")
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

/// Register global shortcuts via plugin + update rdev state (Linux).
/// Shared logic extracted so both Linux and non-Linux entry points use it.
#[cfg(not(target_os = "android"))]
fn register_plugin_shortcuts(app: &tauri::AppHandle<TauriRuntime>, payload: &UpdateShortcutsPayload) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let mute_sc = if !payload.mute.is_empty() { payload.mute.parse::<Shortcut>().ok() } else { None };
    let deafen_sc = if !payload.deafen.is_empty() { payload.deafen.parse::<Shortcut>().ok() } else { None };

    let mut to_register: Vec<Shortcut> = Vec::new();
    if let Some(s) = mute_sc { to_register.push(s); }
    if let Some(s) = deafen_sc { to_register.push(s); }

    if !to_register.is_empty() {
        if let Err(e) = gs.on_shortcuts(to_register, move |_app, shortcut, event| {
            if event.state != ShortcutState::Pressed { return; }
            if mute_sc.is_some() && shortcut == &mute_sc.unwrap() {
                push_shortcut_event("mute");
            } else if deafen_sc.is_some() && shortcut == &deafen_sc.unwrap() {
                push_shortcut_event("deafen");
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
    log::info!("[Sion] Global shortcuts updated: mute={}, deafen={}", payload.mute, payload.deafen);
    register_plugin_shortcuts(&app, &payload);
}

#[cfg(all(not(target_os = "android"), not(target_os = "linux")))]
#[tauri::command]
fn update_shortcuts(app: tauri::AppHandle<TauriRuntime>, payload: UpdateShortcutsPayload) {
    log::info!("[Sion] Global shortcuts updated: mute={}, deafen={}", payload.mute, payload.deafen);
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
fn push_shortcut_event(action: &str) {
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
    #[cfg(feature = "cef")]
    let builder = builder.command_line_args([
        ("--disable-background-timer-throttling".to_string(), None::<String>),
        ("--disable-backgrounding-occluded-windows".to_string(), None::<String>),
        ("--disable-renderer-backgrounding".to_string(), None::<String>),
        ("--autoplay-policy".to_string(), Some("no-user-gesture-required".to_string())),
    ]);

    #[cfg(target_os = "linux")]
    let builder = builder.manage(shortcuts_managed);

    #[cfg(not(target_os = "android"))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![update_shortcuts, poll_shortcuts, get_shortcut_ws_port, open_url, open_file_default, download_file, open_local_file, show_in_folder, fetch_link_preview, transcode_video, list_audio_devices, switch_audio_device, set_default_audio, get_default_audio_devices, exit_app, start_voice_service, stop_voice_service]);

    #[cfg(target_os = "android")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![open_url, open_file_default, download_file, open_local_file, show_in_folder, fetch_link_preview, transcode_video, exit_app, start_voice_service, stop_voice_service]);

    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
            .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

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
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

