use std::path::PathBuf;

/// Recopie les bibliothèques de `transcribe-cpp` à côté de l'exécutable.
///
/// Le crate est bâti avec `dynamic-backends`, qui compile UNE variante du noyau
/// CPU par palier SIMD (sse42, haswell, icelake, zen4…) et laisse ggml choisir
/// au démarrage selon le processeur réel. C'est la seule façon de livrer un
/// binaire unique : lié statiquement, ggml se cale sur le CPU de COMPILATION et
/// embarque de l'AVX-512 que la machine de l'utilisateur ne sait pas exécuter —
/// SIGILL dès que le moteur de transcription démarre. Constaté sur un Ryzen
/// 5950X avec l'AppImage 1.6.1, compilée sur un runner Intel.
///
/// La contrepartie est que ces `.so`/`.dll` doivent voyager avec l'exécutable.
///
/// On les cherche dans le dossier de build du crate -sys plutôt que via
/// `DEP_TRANSCRIBE_LIB_DIR` : cargo ne transmet les variables `DEP_*` qu'aux
/// dépendants DIRECTS du crate portant la clé `links`, or Sion passe par
/// `transcribe-cpp` et n'est donc qu'un dépendant indirect.
fn copy_transcribe_libs() {
    // OUT_DIR = target/<profil>/build/<pkg>-<hash>/out → on remonte au dossier
    // qui contiendra le binaire.
    let Some(target_dir) = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .and_then(|p| p.ancestors().nth(3).map(PathBuf::from))
    else {
        return;
    };

    // Plusieurs dossiers coexistent quand les features ont changé : on retient
    // le plus récent qui contienne réellement des bibliothèques partagées.
    let Ok(builds) = std::fs::read_dir(target_dir.join("build")) else {
        return;
    };
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in builds.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("transcribe-cpp-sys-") {
            continue;
        }
        let lib = entry.path().join("out").join("lib");
        let has_shared = std::fs::read_dir(&lib)
            .map(|d| {
                d.flatten().any(|f| {
                    f.file_name().to_string_lossy().contains(".so")
                        || f.file_name().to_string_lossy().ends_with(".dll")
                })
            })
            .unwrap_or(false);
        if !has_shared {
            continue;
        }
        let stamp = entry.metadata().and_then(|m| m.modified()).ok();
        if let Some(stamp) = stamp {
            if best.as_ref().map(|(t, _)| stamp > *t).unwrap_or(true) {
                best = Some((stamp, lib));
            }
        }
    }
    let Some((_, lib_dir)) = best else {
        return; // build statique : rien à recopier
    };

    let Ok(entries) = std::fs::read_dir(&lib_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let is_lib = name
            .to_str()
            .map(|n| n.contains(".so") || n.ends_with(".dll") || n.ends_with(".dylib"))
            .unwrap_or(false);
        if !is_lib || !path.is_file() {
            continue;
        }
        // Recopie inconditionnelle : une variante obsolète serait chargée en
        // priorité et pourrait réexposer le SIGILL que tout ceci évite.
        let _ = std::fs::copy(&path, target_dir.join(&name));
    }
    println!("cargo:rerun-if-changed={}", lib_dir.display());
}

fn main() {
    copy_transcribe_libs();
    // Les variantes ggml voyagent à côté de l'exécutable : sans $ORIGIN dans le
    // RPATH, l'éditeur de liens dynamique ne regarde jamais ce dossier et le
    // lancement échoue sur « libtranscribe.so.0 => not found ».
    // `$ORIGIN` couvre le lancement depuis target/ ; le second chemin couvre
    // l'AppImage, qui range le binaire dans usr/bin et les bibliothèques dans
    // usr/lib/sion-client, aux côtés de CEF.
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/sion-client");
    tauri_build::build()
}
