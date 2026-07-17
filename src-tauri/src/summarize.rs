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
//! mode (`-no-cnv`), running `llama-completion` (preferred — the modern raw
//! completion tool) or `llama-cli` (older archives). Generation stops at the
//! model's EOS (`<|im_end|>`). The child is run with closed stdin, a hard
//! timeout and a capped stdout — see `run_bounded` for the war story.

#![cfg(not(target_os = "android"))]

use std::io::Write;
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::{find_file, hidden_command, TauriRuntime};

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

/// Binaries usable for raw completion, in order of preference. Since ~b10000
/// `llama-cli` is an interactive chat UI that ignores `-no-cnv` and, with a
/// closed stdin, loops printing its `> ` prompt forever (gigabytes of output);
/// the old raw-completion behaviour lives in `llama-completion`. Older
/// archives only ship `llama-cli`.
fn completion_bin_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["llama-completion.exe", "llama-cli.exe"]
    } else {
        &["llama-completion", "llama-cli"]
    }
}

/// The GPU backend library shipped only by the Vulkan archives — its absence
/// identifies a CPU-only install.
fn vulkan_lib_name() -> &'static str {
    if cfg!(target_os = "windows") { "ggml-vulkan.dll" } else { "libggml-vulkan.so" }
}

/// Marker written after a deliberate fall-back to the CPU build, so a
/// Vulkan-looking host that can't actually run the Vulkan build doesn't
/// trigger an endless purge/re-download cycle. Wiped with the install dir
/// (delete_summary_assets), which is the manual escape hatch.
const CPU_FALLBACK_MARKER: &str = ".vulkan-upgrade-attempted";

/// Cheap probe: does the host look Vulkan-capable? (loader present — the
/// Vulkan build keeps an internal CPU fallback, so a loader without a
/// usable GPU still runs.)
fn host_has_vulkan() -> bool {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("WINDIR")
            .map(|w| std::path::Path::new(&w).join("System32").join("vulkan-1.dll").exists())
            .unwrap_or(false);
    }
    #[cfg(target_os = "linux")]
    {
        return hidden_command("ldconfig")
            .arg("-p")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("libvulkan.so"))
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

/** `--version` probe with the lib dir wired up — the prebuilt archives ship
 *  libllama/libggml next to the binary (bin_runs alone can't find them). */
fn llama_runs(bin: &std::path::Path) -> bool {
    let mut cmd = hidden_command(bin);
    cmd.arg("--version");
    #[cfg(target_os = "linux")]
    if let Some(parent) = bin.parent() {
        cmd.env("LD_LIBRARY_PATH", parent);
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Locate a working completion binary in the install dir, upgrade-gate aside.
fn find_llama_bin(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    completion_bin_names().iter().find_map(|name| {
        let bin = find_file(dir, name)?;
        llama_runs(&bin).then_some(bin)
    })
}

fn find_llama(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    let dir = llama_dir(app)?;
    let bin = find_llama_bin(&dir)?;
    // CPU-only install on a Vulkan-capable host (typically installed before
    // the Vulkan-first preference, or after a transient failure): report it
    // as absent so the next asset check purges and re-downloads the Vulkan
    // build. The marker prevents looping when the fall-back was deliberate.
    if find_file(&dir, vulkan_lib_name()).is_none()
        && !dir.join(CPU_FALLBACK_MARKER).exists()
        && host_has_vulkan()
    {
        log::info!("[Sion][summary] CPU-only llama build on a Vulkan host — will reinstall the Vulkan build");
        return None;
    }
    Some(bin)
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

/// Download the latest prebuilt llama.cpp from the official GitHub releases
/// into `<app-data>/bin/llama/`, emitting `llama-install-progress` events.
/// Tries the VULKAN build first (GPU: minutes → seconds on any AMD/NVIDIA/
/// Intel with a Vulkan driver; those builds keep the CPU backend as an
/// internal fallback), and falls back to the pure-CPU build when the Vulkan
/// binary can't even start (no libvulkan on the host).
#[tauri::command]
pub async fn download_llama(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let dir = llama_dir(&app).ok_or("app-data introuvable")?;
    let _ = app.emit("llama-install-progress", 0u64);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion llama installer)")
        .build()
        .map_err(|e| e.to_string())?;

    let rel: serde_json::Value = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    // Asset names as of b10059. Order = preference.
    let suffixes: &[&str] = if cfg!(target_os = "windows") {
        &["bin-win-vulkan-x64.zip", "bin-win-cpu-x64.zip"]
    } else {
        &["bin-ubuntu-vulkan-x64.tar.gz", "bin-ubuntu-x64.tar.gz"]
    };

    let mut last_err = String::from("aucun asset llama.cpp trouvé");
    for suffix in suffixes {
        let Some(url) = rel["assets"].as_array().and_then(|assets| {
            assets.iter().find_map(|a| {
                let name = a["name"].as_str()?;
                name.ends_with(suffix).then(|| a["browser_download_url"].as_str().map(String::from))?
            })
        }) else {
            last_err = format!("asset '*{suffix}' introuvable");
            continue;
        };

        match fetch_and_install_llama(&app, &client, &url, &dir).await {
            Ok(bin) => {
                if llama_runs(&bin) {
                    log::info!("[Sion][summary] llama.cpp installé ({suffix})");
                    if !suffix.contains("vulkan") {
                        // Deliberate CPU fall-back: remember it so find_llama
                        // doesn't keep purging this install on Vulkan-looking
                        // hosts where the Vulkan build can't start.
                        let _ = std::fs::write(dir.join(CPU_FALLBACK_MARKER), b"");
                    }
                    let _ = app.emit("llama-install-progress", 100u64);
                    return Ok(bin.to_string_lossy().into_owned());
                }
                // Vulkan build refused to start (missing libvulkan?) — wipe
                // and let the loop try the CPU build.
                log::warn!("[Sion][summary] {suffix} ne démarre pas — essai du build suivant");
                last_err = format!("{suffix} ne démarre pas sur cette machine");
                let _ = std::fs::remove_dir_all(&dir);
            }
            Err(e) => {
                last_err = e;
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }
    Err(last_err)
}

async fn fetch_and_install_llama(
    app: &tauri::AppHandle<TauriRuntime>,
    client: &reqwest::Client,
    url: &str,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let mut resp = client.get(url).send().await.map_err(|e| e.to_string())?;
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
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let out = hidden_command("tar")
        .arg("-xf").arg(&archive).arg("-C").arg(dir)
        .output()
        .map_err(|e| format!("tar introuvable: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    if !out.status.success() {
        return Err(format!("extraction échouée: {}", String::from_utf8_lossy(&out.stderr)));
    }

    let bin = find_file(dir, llama_bin_name()).ok_or("llama-cli absent de l'archive")?;
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
    Ok(bin)
}

/// Installed / latest llama.cpp build info for the settings page, mirroring
/// `ytdlp_versions`: JSON `{current, latest, vulkan}` where versions are
/// release tags ("b10059") and `vulkan` says whether the installed build has
/// the GPU backend. `latest` is null when GitHub is unreachable.
#[tauri::command]
pub async fn llama_versions(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let dir = llama_dir(&app);
    // Bypass find_llama: its CPU-on-Vulkan-host upgrade gate reports the
    // build as absent, but the settings page wants to SHOW that build.
    let bin = dir.as_deref().and_then(find_llama_bin);
    let current = bin.and_then(|bin| {
        let mut cmd = hidden_command(&bin);
        cmd.arg("--version");
        #[cfg(target_os = "linux")]
        if let Some(parent) = bin.parent() {
            cmd.env("LD_LIBRARY_PATH", parent);
        }
        let out = cmd.output().ok()?;
        // "version: 10059 (11fd0a6fb)" — printed on stdout or stderr
        // depending on the build.
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        text.lines().find_map(|l| {
            let n = l.trim().strip_prefix("version: ")?;
            Some(format!("b{}", n.split_whitespace().next().unwrap_or(n)))
        })
    });
    let vulkan = dir
        .as_deref()
        .map(|d| find_file(d, vulkan_lib_name()).is_some())
        .unwrap_or(false);

    let latest: Option<String> = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("Mozilla/5.0 (Sion llama installer)")
            .build()
            .ok()?;
        let rel: serde_json::Value = client
            .get("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        rel["tag_name"].as_str().map(String::from)
    }
    .await;

    Ok(serde_json::json!({ "current": current, "latest": latest, "vulkan": vulkan }).to_string())
}

/// Remove the summary assets (llama build + LLM model) from disk — frees
/// ~2.7 GB, next use re-downloads (and picks up newer builds).
#[tauri::command]
pub fn delete_summary_assets(app: tauri::AppHandle<TauriRuntime>) -> Result<(), String> {
    if let Some(dir) = llama_dir(&app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Some(model) = summary_model_path(&app) {
        let _ = std::fs::remove_file(model);
    }
    Ok(())
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

/// Longest acceptable llama run — a 24k-chars transcript takes ~2 min on a
/// mid GPU, allow a slow CPU plenty of headroom before declaring it stuck.
const LLAMA_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// -n 1200 tokens is ~10 KB of text; anything near this cap means the
/// binary is misbehaving (the b10059 llama-cli chat UI printed its REPL
/// prompt in a tight loop on closed stdin — 40 GB of `> ` lines buffered
/// in RAM took the whole app down).
const LLAMA_MAX_OUTPUT: usize = 2 * 1024 * 1024;

/// Run the command with closed stdin, a hard timeout, and a cap on captured
/// stdout, so a misbehaving llama build can never OOM the app. Returns stdout.
fn run_bounded(mut cmd: std::process::Command) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("lancement llama: {e}"))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));

    // Watchdog: kill the child once the deadline passes, unblocking the reads.
    let watchdog = {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + LLAMA_TIMEOUT;
            while std::time::Instant::now() < deadline {
                if finished.load(Ordering::Relaxed) {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            let _ = child.lock().unwrap().kill();
            true
        })
    };

    // Drain stderr concurrently (avoids pipe deadlock), keep only a tail.
    let stderr_tail = std::thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 { break; }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 4096 {
                tail.drain(..tail.len() - 4096);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });

    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 65536];
    let mut overflow = false;
    loop {
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() + n > LLAMA_MAX_OUTPUT {
                    overflow = true;
                    let _ = child.lock().unwrap().kill();
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
        }
    }

    let status = child.lock().unwrap().wait();
    finished.store(true, Ordering::Relaxed);
    let timed_out = watchdog.join().unwrap_or(false);
    let stderr_tail = stderr_tail.join().unwrap_or_default();

    if overflow {
        return Err("llama produit une sortie anormalement volumineuse (binaire incompatible ?)".into());
    }
    if timed_out {
        return Err(format!("llama n'a pas terminé en {} min", LLAMA_TIMEOUT.as_secs() / 60));
    }
    match status {
        Ok(s) if s.success() => Ok(String::from_utf8_lossy(&out).into_owned()),
        Ok(s) => Err(format!("llama a échoué ({s}): {stderr_tail}")),
        Err(e) => Err(format!("attente llama: {e}")),
    }
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
    // Qwen ChatML, applied manually (see module docs). Qwen3.5 ignores the
    // Qwen3-era `/no_think` soft switch and will happily burn the whole -n
    // budget thinking; prefilling an empty <think> block in the assistant
    // turn is what actually forces a direct answer.
    let prompt = format!(
        "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user_head}\n\nTranscription :\n{transcript}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
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

    log::info!("[Sion][summary] running {:?} ({} chars of transcript)", bin.file_name().unwrap_or_default(), transcript.len());
    let started = std::time::Instant::now();
    let out = run_bounded(cmd);
    let _ = std::fs::remove_file(&prompt_file);
    let out = out?;
    let raw = out.replace("<|im_end|>", "").replace("[end of text]", "");
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
