//! Voix générées — clonage vocal local via audio.cpp.
//!
//! Un moteur unique (`audiocpp_cli`, ggml) pilote plusieurs familles de modèles
//! TTS. L'utilisateur choisit son modèle comme il choisit déjà son modèle ASR,
//! et le moteur comme les modèles sont téléchargés à la demande dans
//! `<app-data>` — rien n'est empaqueté (les poids pèsent 4 à 7 Go par modèle).
//!
//! Le flux est volontairement hors-ligne : on produit un WAV à partir d'un
//! extrait de référence + du texte, puis ce WAV rejoint le pipeline soundboard
//! existant (upload Matrix + rediffusion). Personne n'attend en direct, donc la
//! latence de génération (~10-20 s) est sans conséquence.
//!
//! Deux pièges tirés du POC, encodés dans le catalogue plutôt que laissés à
//! l'appelant :
//!  - Chatterbox est en `--language en` PAR DÉFAUT et lit alors le français
//!    avec un accent anglais ; il faut lui passer la langue explicitement.
//!  - Higgs et Qwen3 exigent `--reference-text`, la transcription exacte de
//!    l'extrait. Chatterbox s'en passe (il n'encode que le timbre).
//!
//! Le binaire n'est distribué en release que pour Windows côté amont. Sur
//! Linux/macOS il faut le compiler (CMake + Ninja + `spirv-headers` pour le
//! backend Vulkan), d'où le sélecteur de chemin manuel — même échappatoire que
//! pour ffmpeg.

#![cfg(not(target_os = "android"))]

use std::io::Write;
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::{hidden_command, TauriRuntime};

/// Un modèle TTS installable. Les deux drapeaux de capacité évitent que
/// l'appelant (et l'UI) aient à connaître les particularités de chaque famille.
struct TtsModel {
    /// Identifiant stable, utilisé par le front et persisté dans les réglages.
    id: &'static str,
    /// Valeur passée à `--family`.
    family: &'static str,
    /// Valeur passée à `--task` : `clon` pour Chatterbox, `tts` pour les autres.
    task: &'static str,
    /// Dépôt Hugging Face source.
    repo: &'static str,
    /// Dossier d'installation sous `<app-data>/tts-models/`.
    dir: &'static str,
    /// Fichiers à récupérer : (chemin distant dans le dépôt, chemin local).
    /// Les deux diffèrent quand le dépôt préfixe ses fichiers (cas de Higgs).
    files: &'static [(&'static str, &'static str)],
    /// Chemin passé à `--model` : soit le dossier, soit un fichier précis.
    model_arg: Option<&'static str>,
    /// La famille exige la transcription exacte de l'extrait de référence.
    needs_reference_text: bool,
    /// La famille a besoin qu'on lui impose la langue (défaut inadapté).
    needs_language: bool,
    /// Taille approximative, affichée avant téléchargement.
    size_mb: u64,
}

/// Catalogue. Les listes de fichiers suivent les `model_specs/<family>.json`
/// d'audio.cpp — qui exige parfois des variantes qu'on croirait superflues :
/// Chatterbox charge les TROIS T3 (anglais, multilingue v2 ET v3), en omettre
/// une fait échouer le chargement.
const MODELS: &[TtsModel] = &[
    TtsModel {
        id: "chatterbox",
        family: "chatterbox",
        task: "clon",
        repo: "ResembleAI/chatterbox",
        dir: "chatterbox",
        files: &[
            ("tokenizer.json", "tokenizer.json"),
            (
                "grapheme_mtl_merged_expanded_v1.json",
                "grapheme_mtl_merged_expanded_v1.json",
            ),
            ("Cangjie5_TC.json", "Cangjie5_TC.json"),
            ("conds.pt", "conds.pt"),
            ("ve.safetensors", "ve.safetensors"),
            ("s3gen.safetensors", "s3gen.safetensors"),
            ("t3_cfg.safetensors", "t3_cfg.safetensors"),
            ("t3_mtl23ls_v2.safetensors", "t3_mtl23ls_v2.safetensors"),
            ("t3_mtl23ls_v3.safetensors", "t3_mtl23ls_v3.safetensors"),
        ],
        model_arg: None,
        needs_reference_text: false,
        needs_language: true,
        size_mb: 7000,
    },
    TtsModel {
        id: "higgs_v3",
        family: "higgs_audio_tts",
        task: "tts",
        repo: "audio-cpp/audio.cpp-gguf",
        dir: "Higgs-Audio-v3-TTS-4B-GGUF",
        // Paquet autonome : le GGUF embarque tokenizer et métadonnées. Le dépôt
        // préfixe ses fichiers, on aplatit à l'installation.
        files: &[(
            "Higgs-Audio-v3-TTS-4B-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf",
            "higgs-audio-v3-tts-4b-q8_0.gguf",
        )],
        model_arg: Some("higgs-audio-v3-tts-4b-q8_0.gguf"),
        needs_reference_text: true,
        needs_language: false,
        size_mb: 4800,
    },
    TtsModel {
        id: "qwen3_tts",
        family: "qwen3_tts",
        task: "tts",
        repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        dir: "Qwen3-TTS-12Hz-1.7B-Base",
        files: &[
            ("config.json", "config.json"),
            ("generation_config.json", "generation_config.json"),
            ("merges.txt", "merges.txt"),
            ("model.safetensors", "model.safetensors"),
            ("preprocessor_config.json", "preprocessor_config.json"),
            ("tokenizer_config.json", "tokenizer_config.json"),
            ("vocab.json", "vocab.json"),
            ("speech_tokenizer/config.json", "speech_tokenizer/config.json"),
            (
                "speech_tokenizer/configuration.json",
                "speech_tokenizer/configuration.json",
            ),
            (
                "speech_tokenizer/model.safetensors",
                "speech_tokenizer/model.safetensors",
            ),
            (
                "speech_tokenizer/preprocessor_config.json",
                "speech_tokenizer/preprocessor_config.json",
            ),
        ],
        model_arg: None,
        needs_reference_text: true,
        needs_language: false,
        size_mb: 4100,
    },
];

fn find_model(id: &str) -> Option<&'static TtsModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// Description d'un modèle exposée au front (catalogue + état d'installation).
#[derive(serde::Serialize)]
pub struct TtsModelInfo {
    pub id: String,
    pub family: String,
    pub size_mb: u64,
    pub needs_reference_text: bool,
    pub installed: bool,
}

fn models_root(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("tts-models"))
}

fn model_dir(app: &tauri::AppHandle<TauriRuntime>, m: &TtsModel) -> Option<std::path::PathBuf> {
    Some(models_root(app)?.join(m.dir))
}

/// Un modèle est installé quand TOUS ses fichiers sont là. Un téléchargement
/// interrompu laisse un dossier partiel qu'audio.cpp refuserait de charger avec
/// une erreur peu parlante — mieux vaut le signaler comme absent et réinstaller.
fn model_installed(app: &tauri::AppHandle<TauriRuntime>, m: &TtsModel) -> bool {
    match model_dir(app, m) {
        Some(dir) => m.files.iter().all(|(_, local)| dir.join(local).exists()),
        None => false,
    }
}

#[tauri::command]
pub fn list_tts_models(app: tauri::AppHandle<TauriRuntime>) -> Vec<TtsModelInfo> {
    MODELS
        .iter()
        .map(|m| TtsModelInfo {
            id: m.id.to_string(),
            family: m.family.to_string(),
            size_mb: m.size_mb,
            needs_reference_text: m.needs_reference_text,
            installed: model_installed(&app, m),
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────
// Moteur audio.cpp

fn engine_dir(app: &tauri::AppHandle<TauriRuntime>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("bin").join("audiocpp"))
}

fn engine_bin_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "audiocpp_cli.exe"
    } else {
        "audiocpp_cli"
    }
}

/// Le binaire répond-il ? Sonde `--help` plutôt que `--version` : le CLI
/// d'audio.cpp n'expose pas de `--version` et sortirait en erreur.
fn engine_runs(bin: &std::path::Path) -> bool {
    hidden_command(bin)
        .arg("--help")
        .output()
        .map(|o| {
            o.status.success()
                || String::from_utf8_lossy(&o.stdout).contains("--task")
                || String::from_utf8_lossy(&o.stderr).contains("--task")
        })
        .unwrap_or(false)
}

/// Chemin du moteur : d'abord celui choisi manuellement (Linux/macOS, où
/// l'amont ne publie pas de binaire), sinon l'installation gérée.
#[tauri::command]
pub fn detect_tts_engine(
    app: tauri::AppHandle<TauriRuntime>,
    custom_path: Option<String>,
) -> Option<String> {
    if let Some(p) = custom_path.filter(|p| !p.is_empty()) {
        let path = std::path::PathBuf::from(&p);
        if path.exists() && engine_runs(&path) {
            return Some(p);
        }
    }
    let bin = crate::find_file(&engine_dir(&app)?, engine_bin_name())?;
    engine_runs(&bin).then(|| bin.to_string_lossy().into_owned())
}

/// Dossier `model_specs/` associé à un binaire donné.
///
/// audio.cpp y lit la description de chaque famille (fichiers requis, préfixes
/// de tenseurs). Seuls les modèles GGUF embarquent leur spec ; les modèles
/// safetensors — Chatterbox, Qwen3 — échouent sans lui sur
/// `model spec not found for family '…'`.
///
/// On remonte depuis le binaire parce que les deux dispositions rencontrées le
/// placent à des profondeurs différentes : `build/bin/audiocpp_cli` avec
/// `model_specs/` à la racine du dépôt (compilation locale), ou côte à côte
/// dans l'archive de release.
fn model_specs_dir(bin: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut cur = bin.parent()?;
    for _ in 0..4 {
        let candidate = cur.join("model_specs");
        if candidate.is_dir() {
            return Some(candidate);
        }
        cur = cur.parent()?;
    }
    None
}

/// Sélecteur natif pour un `audiocpp_cli` compilé soi-même.
#[tauri::command]
pub async fn pick_tts_engine_path() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Sélectionner audiocpp_cli")
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Tag de la release Sion qui héberge le moteur.
///
/// Volontairement figé, et distinct des releases applicatives : le moteur ne
/// bouge qu'au rythme d'audio.cpp. Pointer `/releases/latest/` obligerait à
/// ré-attacher 76 Mo à chaque version de Sion, sous peine de casser le
/// téléchargement dès la publication suivante.
///
/// Pour le mettre à jour : relancer le workflow `audiocpp.yml` sur un nouveau
/// tag d'audio.cpp, publier une release `audiocpp-<version>`, puis changer
/// cette constante.
const ENGINE_RELEASE_TAG: &str = "audiocpp-0.4.2";

/// Archive à récupérer selon la plateforme.
///
/// Windows est servi directement par l'amont. Linux et macOS n'ont pas de
/// binaire publié : ils viennent d'une release Sion dédiée, alimentée par le
/// workflow `audiocpp.yml` — qui joint aussi `model_specs/`, indispensable aux
/// modèles safetensors.
fn engine_archive_url() -> Option<(String, bool)> {
    let sion = |asset: &str| {
        format!("https://github.com/flamme-demon/Sion-Cient/releases/download/{ENGINE_RELEASE_TAG}/{asset}")
    };
    if cfg!(target_os = "windows") {
        Some((
            "https://github.com/0xShug0/audio.cpp/releases/latest/download/audiocpp-windows-cpu-balance.zip".to_string(),
            true,
        ))
    } else if cfg!(target_os = "linux") {
        Some((sion("audiocpp-linux-x64-vulkan.tar.gz"), false))
    } else if cfg!(target_os = "macos") {
        Some((sion("audiocpp-macos-arm64-metal.tar.gz"), false))
    } else {
        None
    }
}

/// Récupère le moteur. En cas d'absence de build publié pour la plateforme,
/// l'utilisateur peut toujours compiler audio.cpp et désigner son binaire via
/// `pick_tts_engine_path`.
#[tauri::command]
pub async fn download_tts_engine(app: tauri::AppHandle<TauriRuntime>) -> Result<String, String> {
    let (url, is_zip) = engine_archive_url().ok_or(
        "aucun build audio.cpp pour cette plateforme — compilez-le puis \
         sélectionnez audiocpp_cli avec le bouton Parcourir",
    )?;
    let dir = engine_dir(&app).ok_or("app-data indisponible")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let _ = app.emit("tts-engine-progress", 0u64);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion TTS installer)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} — build indisponible pour cette plateforme", resp.status()));
    }
    let total = resp.content_length();
    let archive = dir.join(if is_zip { "engine.zip" } else { "engine.tar.gz" });
    let mut out = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if let Some(t) = total.filter(|t| *t > 0) {
            let _ = app.emit("tts-engine-progress", got * 90 / t);
        }
    }
    drop(out);

    // Décompression déléguée aux outils du système : pas de crate d'archive
    // dans l'arbre, et `tar` est présent partout (y compris Windows 10+, mais
    // PowerShell y gère mieux les zip).
    let status = if is_zip {
        hidden_command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Force -LiteralPath '{}' -DestinationPath '{}'",
                    archive.display(),
                    dir.display()
                ),
            ])
            .status()
    } else {
        hidden_command("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&dir)
            .status()
    }
    .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() {
        return Err("décompression échouée".into());
    }
    // Le bit exécutable ne survit pas toujours à l'extraction selon l'outil.
    #[cfg(unix)]
    if let Some(bin) = crate::find_file(&dir, engine_bin_name()) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&bin, perms);
        }
    }
    let _ = app.emit("tts-engine-progress", 100u64);

    let bin = crate::find_file(&dir, engine_bin_name()).ok_or("binaire introuvable après extraction")?;
    Ok(bin.to_string_lossy().into_owned())
}

// ─────────────────────────────────────────────────────────────────────────
// Modèles

#[tauri::command]
pub fn delete_tts_model(app: tauri::AppHandle<TauriRuntime>, model: String) -> Result<(), String> {
    let m = find_model(&model).ok_or("modèle inconnu")?;
    let dir = model_dir(&app, m).ok_or("app-data indisponible")?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Télécharge tous les fichiers d'un modèle. La progression est pondérée par le
/// nombre de fichiers, ce qui suffit ici : un seul fichier domine le volume
/// dans chaque modèle, et pondérer par octets demanderait un HEAD par fichier.
#[tauri::command]
pub async fn download_tts_model(
    app: tauri::AppHandle<TauriRuntime>,
    model: String,
) -> Result<String, String> {
    let m = find_model(&model).ok_or("modèle inconnu")?;
    let dir = model_dir(&app, m).ok_or("app-data indisponible")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(7200))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Sion TTS installer)")
        .build()
        .map_err(|e| e.to_string())?;

    let n = m.files.len() as u64;
    let _ = app.emit("tts-model-progress", 0u64);
    for (i, (remote, local)) in m.files.iter().enumerate() {
        let dest = dir.join(local);
        if dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let url = format!(
            "https://huggingface.co/{}/resolve/main/{remote}",
            m.repo
        );
        let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("{remote}: HTTP {}", resp.status()));
        }
        let total = resp.content_length();
        // .part puis rename : un téléchargement tué ne laisse jamais un fichier
        // tronqué que `model_installed` compterait à tort comme présent.
        let part = dir.join(format!("{local}.part"));
        if let Some(parent) = part.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            if let Some(t) = total.filter(|t| *t > 0) {
                let done = i as u64 * 100 + got * 100 / t;
                let _ = app.emit("tts-model-progress", (done / n).min(99));
            }
        }
        drop(out);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("tts-model-progress", 100u64);
    Ok(dir.to_string_lossy().into_owned())
}

// ─────────────────────────────────────────────────────────────────────────
// Génération

/// Une génération met ~10-20 s sur GPU, nettement plus en CPU sur un long
/// texte. 15 min laisse une marge confortable avant de déclarer le processus
/// bloqué.
const TTS_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// audio.cpp écrit peu sur stdout ; au-delà, c'est qu'il boucle.
const TTS_MAX_OUTPUT: usize = 1024 * 1024;

/// Lance le moteur avec stdin fermé, un délai maximal et une sortie plafonnée.
/// Même garde-fou que `summarize::run_bounded` : un binaire qui déraille ne doit
/// jamais saturer la RAM de l'app.
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
        .map_err(|e| format!("lancement audiocpp: {e}"))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));

    let watchdog = {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + TTS_TIMEOUT;
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

    // Drainer stderr en parallèle évite l'interblocage du tube quand ggml y
    // déverse ses lignes d'init Vulkan.
    let stderr_tail = std::thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
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
                if out.len() + n > TTS_MAX_OUTPUT {
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
    let tail = stderr_tail.join().unwrap_or_default();

    if timed_out {
        return Err("génération interrompue (délai dépassé)".into());
    }
    if overflow {
        return Err("sortie anormalement longue, génération interrompue".into());
    }
    match status {
        Ok(s) if s.success() => Ok(String::from_utf8_lossy(&out).into_owned()),
        Ok(s) => Err(format!(
            "audiocpp a échoué ({}): {}",
            s.code().unwrap_or(-1),
            tail.trim()
        )),
        Err(e) => Err(e.to_string()),
    }
}

/// L'échec vient-il d'un manque de mémoire GPU ?
///
/// ggml remonte l'échec d'allocation Vulkan/CUDA sous plusieurs libellés selon
/// l'étage qui abandonne (allocation directe, réservation de graphe, allocateur
/// de tenseurs) : on les reconnaît tous plutôt que d'en privilégier un.
fn is_gpu_oom(err: &str) -> bool {
    const MARKERS: [&str; 4] = [
        "ErrorOutOfDeviceMemory",
        "failed to allocate",
        "out of memory",
        "OutOfDeviceMemory",
    ];
    MARKERS.iter().any(|m| err.contains(m))
}

/// Le backend est choisi ici plutôt que via `--backend best` : la sonde Vulkan
/// est déjà celle des résumés, et un backend explicite rend les logs lisibles
/// quand un utilisateur remonte un problème.
fn backend() -> &'static str {
    if crate::summarize::host_has_vulkan() {
        "vulkan"
    } else {
        "cpu"
    }
}

/// Génère un WAV depuis un extrait de référence et du texte.
///
/// `reference_text` n'est utilisé que par les familles qui l'exigent ; le
/// fournir à Chatterbox serait au mieux ignoré. Inversement son absence sur
/// Higgs/Qwen3 est une erreur explicite plutôt qu'une génération incohérente —
/// un `--reference-text` faux fait dériver ces modèles silencieusement.
/// Asynchrone, et le travail bloquant part sur le pool dédié.
///
/// Une commande Tauri synchrone s'exécute sur le thread principal : la
/// génération y gelait toute l'interface une vingtaine de secondes, au point de
/// faire passer l'application pour plantée. `spawn_blocking` est fourni par
/// Tauri lui-même, sans dépendance supplémentaire.
#[tauri::command]
pub async fn tts_generate(
    app: tauri::AppHandle<TauriRuntime>,
    model: String,
    text: String,
    voice_ref: String,
    reference_text: Option<String>,
    language: Option<String>,
    engine_path: Option<String>,
) -> Result<String, String> {
    let m = find_model(&model).ok_or("modèle inconnu")?;
    if text.trim().is_empty() {
        return Err("texte vide".into());
    }
    if !std::path::Path::new(&voice_ref).exists() {
        return Err("extrait de référence introuvable".into());
    }
    let ref_text = reference_text.unwrap_or_default();
    if m.needs_reference_text && ref_text.trim().is_empty() {
        return Err(format!(
            "{} exige la transcription exacte de l'extrait de référence",
            m.id
        ));
    }

    let engine = detect_tts_engine(app.clone(), engine_path).ok_or(
        "moteur audio.cpp introuvable — installez-le ou indiquez son chemin dans les réglages",
    )?;
    if !model_installed(&app, m) {
        return Err(format!("modèle {} non installé", m.id));
    }
    let dir = model_dir(&app, m).ok_or("app-data indisponible")?;
    let model_arg = match m.model_arg {
        Some(f) => dir.join(f),
        None => dir.clone(),
    };

    let out_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tts-out");
    std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
    let out_file = out_path.join(format!(
        "tts-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));

    // Fabrique la commande pour un backend donné : on peut avoir à la rejouer
    // sur CPU si le GPU manque de mémoire.
    let build = |backend: &str| {
        let mut cmd = hidden_command(&engine);
        cmd.args(["--task", m.task, "--family", m.family]);
        cmd.arg("--model").arg(&model_arg);
        cmd.args(["--backend", backend]);
        cmd.arg("--text").arg(&text);
        cmd.arg("--voice-ref").arg(&voice_ref);
        cmd.arg("--out").arg(&out_file);
        // Indispensable pour les familles safetensors (Chatterbox, Qwen3) : sans
        // spec, audiocpp refuse de charger. Les GGUF l'embarquent, d'où le silence
        // quand le dossier est absent.
        if let Some(specs) = model_specs_dir(std::path::Path::new(&engine)) {
            cmd.arg("--model-spec-override").arg(specs);
        }
        if m.needs_language {
            cmd.args(["--language", language.as_deref().unwrap_or("fr")]);
        }
        if m.needs_reference_text {
            cmd.arg("--reference-text").arg(&ref_text);
        }
        // Nos builds lient ggml et onnxruntime statiquement, mais les archives
        // amont (Windows) livrent des DLL à côté du binaire — et un utilisateur
        // peut pointer sur une compilation dynamique. Coût nul si inutile.
        #[cfg(not(target_os = "windows"))]
        if let Some(parent) = std::path::Path::new(&engine).parent() {
            cmd.env("LD_LIBRARY_PATH", parent);
        }
        cmd
    };

    let first = backend();
    log::info!("[Sion][tts] génération {} sur {}", m.id, first);
    let cmd = build(first);
    let mut stdout = tauri::async_runtime::spawn_blocking(move || run_bounded(cmd))
        .await
        .map_err(|e| format!("tâche interrompue: {e}"))?;

    // L'échec n'est PAS une question de mémoire libre. Ces modèles demandent
    // ~1 Go d'un seul tenant dans le tas à la fois DEVICE_LOCAL et HOST_VISIBLE,
    // c'est-à-dire la fenêtre BAR — plafonnée à 256 Mo tant que le Resizable BAR
    // manque, ce qui est le cas de toute la génération Turing. Constaté sur une
    // RTX 2080 Ti avec 7,3 Go libres : libérer davantage n'y changerait rien.
    // On rejoue donc sur CPU, plus lent mais hors-ligne de toute façon.
    if first != "cpu" {
        if let Err(err) = &stdout {
            if is_gpu_oom(err) {
                log::warn!("[Sion][tts] VRAM insuffisante — nouvelle tentative sur CPU");
                // Prévenir l'interface : la génération va prendre bien plus
                // longtemps, et une attente inexpliquée passe pour un blocage.
                let _ = app.emit("tts-cpu-fallback", ());
                let cmd = build("cpu");
                stdout = tauri::async_runtime::spawn_blocking(move || run_bounded(cmd))
                    .await
                    .map_err(|e| format!("tâche interrompue: {e}"))?;
            }
        }
    }
    let stdout = stdout?;
    if !out_file.exists() {
        return Err(format!(
            "aucun fichier produit — sortie: {}",
            stdout.lines().last().unwrap_or("(vide)")
        ));
    }
    Ok(out_file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_ids_uniques() {
        let mut ids: Vec<&str> = MODELS.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "deux modèles partagent le même id");
    }

    #[test]
    fn find_model_resout_le_catalogue() {
        assert!(find_model("chatterbox").is_some());
        assert!(find_model("higgs_v3").is_some());
        assert!(find_model("qwen3_tts").is_some());
        assert!(find_model("inexistant").is_none());
    }

    /// Chatterbox encode le timbre seul : lui demander une transcription serait
    /// une friction inutile dans l'UI. Higgs et Qwen3 en dépendent au contraire.
    #[test]
    fn capacites_par_famille() {
        let cb = find_model("chatterbox").unwrap();
        assert!(!cb.needs_reference_text);
        assert!(cb.needs_language, "défaut --language en → accent anglais");
        assert!(find_model("higgs_v3").unwrap().needs_reference_text);
        assert!(find_model("qwen3_tts").unwrap().needs_reference_text);
    }

    /// Un modèle mono-fichier doit pointer `--model` sur le fichier, un modèle
    /// multi-fichiers sur son dossier.
    #[test]
    fn model_arg_coherent_avec_les_fichiers() {
        for m in MODELS {
            if m.files.len() == 1 {
                assert!(m.model_arg.is_some(), "{} : fichier unique sans model_arg", m.id);
            } else {
                assert!(m.model_arg.is_none(), "{} : dossier mais model_arg défini", m.id);
            }
        }
    }

    /// Les deux dispositions rencontrées : compilation locale
    /// (`build/bin/audiocpp_cli` + `model_specs/` à la racine) et archive de
    /// release (côte à côte). Sans ce dossier, Chatterbox et Qwen3 échouent sur
    /// « model spec not found ».
    #[test]
    fn model_specs_trouve_les_deux_dispositions() {
        let tmp = std::env::temp_dir().join(format!("sion-tts-spec-{}", std::process::id()));
        let repo = tmp.join("repo");
        std::fs::create_dir_all(repo.join("build").join("bin")).unwrap();
        std::fs::create_dir_all(repo.join("model_specs")).unwrap();
        let deep = repo.join("build").join("bin").join("audiocpp_cli");
        std::fs::write(&deep, b"").unwrap();
        assert_eq!(model_specs_dir(&deep), Some(repo.join("model_specs")));

        let flat = repo.join("audiocpp_cli");
        std::fs::write(&flat, b"").unwrap();
        assert_eq!(model_specs_dir(&flat), Some(repo.join("model_specs")));

        let orphan = tmp.join("ailleurs");
        std::fs::create_dir_all(&orphan).unwrap();
        let bin = orphan.join("audiocpp_cli");
        std::fs::write(&bin, b"").unwrap();
        assert_eq!(model_specs_dir(&bin), None, "ne doit pas remonter indéfiniment");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Chaînes relevées chez un utilisateur en RTX 2080 Ti. On teste le message
    /// COMPLET tel que `run_bounded` le compose, pas un extrait choisi : c'est
    /// lui que `tts_generate` inspecte pour décider du repli.
    #[test]
    fn oom_gpu_reconnu_sur_les_erreurs_reelles() {
        let higgs = "audiocpp a échoué (1): ggml_vulkan: Found 1 Vulkan devices: \
            ggml_vulkan: 0 = NVIDIA GeForce RTX 2080 Ti (NVIDIA) | uma: 0 | fp16: 1 \
            ggml_vulkan: Device memory allocation of size 1071755264 failed. \
            ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory \
            alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1071755264 \
            audiocpp_cli failed: failed to allocate Higgs TTS AR prefill graph";
        let qwen = "audiocpp a échoué (1): ggml_vulkan: Device memory allocation of \
            size 1476034560 failed. ggml_vulkan: vk::Device::allocateMemory: \
            ErrorOutOfDeviceMemory ggml_gallocr_reserve_n_impl: failed to allocate \
            Vulkan0 buffer of size 3233301504 \
            audiocpp_cli failed: failed to allocate Qwen3 speech decoder graph";
        assert!(is_gpu_oom(higgs));
        assert!(is_gpu_oom(qwen));
    }

    /// Un échec ordinaire ne doit pas déclencher de seconde tentative : elle
    /// coûterait une génération complète sur CPU pour rien.
    #[test]
    fn oom_gpu_ne_confond_pas_les_autres_echecs() {
        assert!(!is_gpu_oom("audiocpp a échoué (1): invalid WAV RIFF header"));
        assert!(!is_gpu_oom("model spec not found for family 'qwen3_tts'"));
        assert!(!is_gpu_oom("génération interrompue (délai dépassé)"));
    }

    #[test]
    fn aucun_chemin_local_absolu_ni_remontant() {
        for m in MODELS {
            for (_, local) in m.files {
                assert!(!local.starts_with('/'), "{}: {local} absolu", m.id);
                assert!(!local.contains(".."), "{}: {local} remonte", m.id);
            }
        }
    }
}
