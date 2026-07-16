//! Meeting summary — phase 2 of the local transcription system.
//!
//! Runs a local LLM over the meeting transcript and returns a markdown
//! compte-rendu. Everything stays on the machine, mirroring the managed
//! ffmpeg / yt-dlp pattern:
//!  - `llama-cli` (prebuilt from the official ggml-org/llama.cpp releases)
//!    is downloaded on demand into `<app-data>/bin/llama/`;
//!  - the model (Qwen3-4B-Instruct, Q4_K_M GGUF, ~2.5 GB — strong French)
//!    is downloaded on demand into `<app-data>/models/`.
//!
//! The prompt uses Qwen's ChatML template applied MANUALLY in raw completion
//! mode (`-no-cnv`): llama-cli's conversation flags have drifted across
//! releases, while raw mode + explicit template is stable. Generation stops
//! at the model's EOS (`<|im_end|>`).

#![cfg(not(target_os = "android"))]

use std::io::Write;
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::{bin_runs, find_file, hidden_command, TauriRuntime};

// Qwen3.5-4B (2026) — successor of the Qwen3-4B-Instruct first pick, same
// ~4B/CPU-friendly class, still ChatML. Suggested by Grégory.
const SUMMARY_MODEL_REPO: &str = "unsloth/Qwen3.5-4B-GGUF";
const SUMMARY_MODEL_FILE: &str = "Qwen3.5-4B-Q4_K_M.gguf";

fn llama_dir(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("bin").join("llama"))
}

fn llama_bin_name() -> &'static str {
    if cfg!(target_os = "windows") { "llama-cli.exe" } else { "llama-cli" }
}

fn find_llama(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    let dir = llama_dir(app)?;
    let bin = find_file(&dir, llama_bin_name())?;
    bin_runs(&bin.to_string_lossy(), "--version").then_some(bin)
}

fn summary_model_path(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("models").join(SUMMARY_MODEL_FILE))
}

/// What the summary feature needs and whether each piece is present.
/// The JS side uses this to decide which download to trigger.
#[derive(serde::Serialize)]
pub struct SummaryAssets {
    pub llama: Option<String>,
    pub model: Option<String>,
}

#[tauri::command]
pub fn detect_summary_assets(app: tauri::AppHandle<TauriRuntime>) -> SummaryAssets {
    SummaryAssets {
        llama: find_llama(&app).map(|p| p.to_string_lossy().into_owned()),
        model: summary_model_path(&app)
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Download the latest prebuilt llama.cpp (CPU) from the official GitHub
/// releases and unpack it into `<app-data>/bin/llama/`. Emits
/// `llama-install-progress` percent events. ~16–18 MB.
#[tauri::command]
pub async fn download_llama(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let dir = llama_dir(&app).ok_or("app-data introuvable")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = app.emit("llama-install-progress", 0u64);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion llama installer)")
        .build()
        .map_err(|e| e.to_string())?;

    // Resolve the right asset from the latest release. Names as of b10045:
    // linux `llama-<tag>-bin-ubuntu-x64.tar.gz`, windows `…-bin-win-cpu-x64.zip`.
    let rel: serde_json::Value = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let suffix = if cfg!(target_os = "windows") { "bin-win-cpu-x64.zip" } else { "bin-ubuntu-x64.tar.gz" };
    let url = rel["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find_map(|a| {
                let name = a["name"].as_str()?;
                name.ends_with(suffix).then(|| a["browser_download_url"].as_str().map(String::from))?
            })
        })
        .ok_or_else(|| format!("asset '*{suffix}' introuvable dans la dernière release llama.cpp"))?;

    let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let archive = std::env::temp_dir().join(if cfg!(target_os = "windows") { "sion_llama_dl.zip" } else { "sion_llama_dl.tar.gz" });
    let mut file = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            if t > 0 {
                let _ = app.emit("llama-install-progress", downloaded * 90 / t);
            }
        }
    }
    drop(file);

    // Fresh unpack (wipe any older build) — the whole archive is kept: the
    // binary needs its shared libs (libllama.so / .dll) next to it.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = hidden_command("tar")
        .arg("-xf").arg(&archive).arg("-C").arg(&dir)
        .output()
        .map_err(|e| format!("tar introuvable: {e}"))?;
    if !out.status.success() {
        return Err(format!("extraction échouée: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let _ = std::fs::remove_file(&archive);

    let bin = find_file(&dir, llama_bin_name()).ok_or("llama-cli absent de l'archive")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Every extracted binary/lib needs exec perms, not just llama-cli.
        if let Some(parent) = bin.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(entry.path(), perms);
                    }
                }
            }
        }
    }
    let _ = app.emit("llama-install-progress", 100u64);
    Ok(bin.to_string_lossy().into_owned())
}

/// Download the summary model (Qwen3-4B-Instruct Q4_K_M, ~2.5 GB) into
/// `<app-data>/models/`, emitting `summary-model-progress` percent events.
#[tauri::command]
pub async fn download_summary_model(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let dest = summary_model_path(&app).ok_or("app-data introuvable")?;
    if dest.exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    let url = format!("https://huggingface.co/{SUMMARY_MODEL_REPO}/resolve/main/{SUMMARY_MODEL_FILE}");
    let _ = app.emit("summary-model-progress", 0u64);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(7200))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion summary installer)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let part = dest.with_extension("gguf.part");
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            if t > 0 {
                let _ = app.emit("summary-model-progress", downloaded * 99 / t);
            }
        }
    }
    drop(out);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    let _ = app.emit("summary-model-progress", 100u64);
    Ok(dest.to_string_lossy().into_owned())
}

/// Summarize a meeting transcript with the local LLM. Blocking by design —
/// Tauri runs sync commands off the main thread, and generation takes tens
/// of seconds on CPU. Returns the markdown compte-rendu.
#[tauri::command]
pub fn summarize_transcript(
    app: tauri::AppHandle<TauriRuntime>,
    transcript: String,
    lang: String,
) -> Result<String, String> {
    let bin = find_llama(&app).ok_or("llama-cli non installé")?;
    let model = summary_model_path(&app)
        .filter(|p| p.exists())
        .ok_or("modèle de résumé non téléchargé")?;

    let (system, user_head) = if lang.starts_with("en") {
        (
            "You write concise, structured meeting minutes.",
            "Here is the timestamped transcript of a voice meeting. Write meeting minutes in English, in markdown, with three sections: **Topics discussed**, **Decisions**, **Action items** (with owners when identifiable). Be factual and concise; do not invent anything that is not in the transcript.",
        )
    } else {
        (
            "Tu rédiges des comptes-rendus de réunion concis et structurés.",
            "Voici la transcription horodatée d'une réunion vocale. Rédige un compte-rendu en français, en markdown, avec trois sections : **Sujets abordés**, **Décisions**, **Actions à suivre** (avec responsables si identifiables). Sois factuel et concis ; n'invente rien qui ne soit pas dans la transcription.",
        )
    };
    // Qwen ChatML, applied manually (see module docs). `/no_think` opts out
    // of Qwen3's thinking mode — minutes need no chain-of-thought budget.
    let prompt = format!(
        "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user_head}\n\n/no_think\n\nTranscription :\n{transcript}<|im_end|>\n<|im_start|>assistant\n"
    );
    let prompt_file = std::env::temp_dir().join("sion_summary_prompt.txt");
    std::fs::write(&prompt_file, &prompt).map_err(|e| e.to_string())?;

    let threads = std::thread::available_parallelism().map(|n| n.get().min(6)).unwrap_or(4);
    let mut cmd = hidden_command(&bin);
    cmd.arg("-m").arg(&model)
        .arg("-f").arg(&prompt_file)
        .arg("-no-cnv")
        .arg("--no-display-prompt")
        .arg("--simple-io")
        .arg("-c").arg("16384")
        .arg("-n").arg("1200")
        .arg("--temp").arg("0.4")
        .arg("-t").arg(threads.to_string());
    // The prebuilt ubuntu tarball ships libllama.so next to the binary.
    #[cfg(target_os = "linux")]
    if let Some(parent) = bin.parent() {
        cmd.env("LD_LIBRARY_PATH", parent);
    }

    log::info!("[Sion][summary] running llama-cli ({} chars of transcript)", transcript.len());
    let started = std::time::Instant::now();
    let out = cmd.output().map_err(|e| format!("lancement llama-cli: {e}"))?;
    let _ = std::fs::remove_file(&prompt_file);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("llama-cli a échoué: {}", err.chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()));
    }
    let raw = String::from_utf8_lossy(&out.stdout).replace("<|im_end|>", "");
    // Hybrid-reasoning models (Qwen3.5) may open with a <think> block even
    // with /no_think in the prompt — strip it, minutes only.
    let text = match (raw.find("<think>"), raw.find("</think>")) {
        (Some(a), Some(b)) if b > a => format!("{}{}", &raw[..a], &raw[b + 8..]),
        _ => raw,
    }
    .trim()
    .to_string();
    log::info!("[Sion][summary] done in {} s, {} chars", started.elapsed().as_secs(), text.len());
    if text.is_empty() {
        return Err("le modèle n'a rien produit".into());
    }
    Ok(text)
}
