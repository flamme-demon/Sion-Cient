#[cfg(not(target_os = "android"))]
use rdev::{listen, EventType, Key};
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(not(target_os = "android"))]
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
#[cfg(not(target_os = "android"))]
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "android"))]
use std::thread;
use std::time::Duration;
#[cfg(not(target_os = "android"))]
use std::time::Instant;
#[cfg(not(target_os = "android"))]
use tauri::Emitter;

#[cfg(feature = "cef")]
type TauriRuntime = tauri::Cef;
#[cfg(not(feature = "cef"))]
type TauriRuntime = tauri::Wry;

#[cfg(not(target_os = "android"))]
struct ShortcutState {
    mute_keys: Vec<Key>,
    deafen_keys: Vec<Key>,
}

#[cfg(not(target_os = "android"))]
type SharedShortcuts = Arc<Mutex<ShortcutState>>;

#[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
fn parse_shortcut(shortcut: &str) -> Vec<Key> {
    if shortcut.is_empty() {
        return vec![];
    }
    shortcut.split('+').filter_map(parse_key).collect()
}

#[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn list_audio_devices() -> Vec<AudioDevice> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let mut devices = Vec::new();
    let host = cpal::default_host();

    for device in host.devices().into_iter().flatten() {
        let raw_name = device.name().unwrap_or_default();

        // Skip virtual/system ALSA devices
        if is_virtual_alsa_device(&raw_name) {
            continue;
        }

        let label = prettify_alsa_name(&raw_name);

        let is_input = device.supported_input_configs().map(|mut c| c.next().is_some()).unwrap_or(false);
        let is_output = device.supported_output_configs().map(|mut c| c.next().is_some()).unwrap_or(false);

        if is_input {
            devices.push(AudioDevice { id: raw_name.clone(), name: label.clone(), kind: "input".into() });
        }
        if is_output {
            devices.push(AudioDevice { id: raw_name, name: label, kind: "output".into() });
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
    let client = build_client()?;

    // Try oEmbed first for known sites
    if let Some(preview) = try_oembed(&client, url).await {
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

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn update_shortcuts(state: tauri::State<'_, SharedShortcuts>, payload: UpdateShortcutsPayload) {
    let mut shortcuts = state.lock().unwrap();
    shortcuts.mute_keys = parse_shortcut(&payload.mute);
    shortcuts.deafen_keys = parse_shortcut(&payload.deafen);
    log::info!(
        "[Sion] Global shortcuts updated: mute={:?}, deafen={:?}",
        shortcuts.mute_keys,
        shortcuts.deafen_keys
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg_attr(feature = "cef", tauri::cef_entry_point)]
pub fn run() {
    #[cfg(not(target_os = "android"))]
    let shortcuts: SharedShortcuts = Arc::new(Mutex::new(ShortcutState {
        mute_keys: vec![],
        deafen_keys: vec![],
    }));

    #[cfg(not(target_os = "android"))]
    let shortcuts_clone = shortcuts.clone();

    let builder = tauri::Builder::<TauriRuntime>::default();

    #[cfg(feature = "cef")]
    let builder = builder.command_line_args([
        ("--disable-features".to_string(), Some("PasswordManager,AutofillServerCommunication".to_string())),
    ]);

    #[cfg(not(target_os = "android"))]
    let builder = builder
        .manage(shortcuts)
        .invoke_handler(tauri::generate_handler![update_shortcuts, open_url, fetch_link_preview, transcode_video, list_audio_devices]);

    #[cfg(target_os = "android")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![open_url, fetch_link_preview, transcode_video]);

    builder
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Global shortcut listener using rdev — desktop only
            #[cfg(not(target_os = "android"))]
            {
                let handle = app.handle().clone();
                let sc = shortcuts_clone;

                thread::spawn(move || {
                    let pressed_keys: Arc<Mutex<HashSet<Key>>> = Arc::new(Mutex::new(HashSet::new()));
                    let last_mute = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
                    let last_deafen = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));

                    let pk = pressed_keys.clone();
                    let lm = last_mute.clone();
                    let ld = last_deafen.clone();

                    log::info!("[Sion] Starting rdev global input listener...");

                    if let Err(e) = listen(move |event| {
                        match event.event_type {
                            EventType::KeyPress(key) => {
                                let mut keys = pk.lock().unwrap();
                                keys.insert(key);

                                let sc_lock = sc.lock().unwrap();
                                let mute_keys = sc_lock.mute_keys.clone();
                                let deafen_keys = sc_lock.deafen_keys.clone();
                                drop(sc_lock);

                                let now = Instant::now();
                                let debounce = Duration::from_millis(200);

                                if keys_match(&mute_keys, &keys) {
                                    let mut lm = lm.lock().unwrap();
                                    if now.duration_since(*lm) > debounce {
                                        *lm = now;
                                        log::info!("[Sion] Global shortcut: mute");
                                        let _ = handle.emit("global-shortcut", "mute");
                                    }
                                }
                                if keys_match(&deafen_keys, &keys) {
                                    let mut ld = ld.lock().unwrap();
                                    if now.duration_since(*ld) > debounce {
                                        *ld = now;
                                        log::info!("[Sion] Global shortcut: deafen");
                                        let _ = handle.emit("global-shortcut", "deafen");
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
