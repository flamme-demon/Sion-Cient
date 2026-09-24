//! Profils Sion (`.sionprofil`) : disposition, thème, fonds de panneaux et
//! sons d'événements dans une seule archive, pour les partager ou les
//! retrouver sur une autre machine.
//!
//! L'archive est un zip : `manifest.json`, que la page compose et relit, et
//! les fichiers sous `fichiers/`. Côté Rust, on ne fait que l'écrire, la lire
//! et en extraire ce que l'utilisateur a choisi — la page valide le contenu
//! du manifeste.
//!
//! Une archive reçue est une donnée étrangère. Un nom d'entrée ne sert jamais
//! de chemin : il doit correspondre à `fichiers/<nom simple>` avec une
//! extension connue, et le fichier extrait reçoit un chemin choisi ici.
//! Tailles et nombre d'entrées sont plafonnés, à la lecture de l'en-tête ET
//! pendant la copie — un en-tête peut mentir.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const MANIFESTE: &str = "manifest.json";
const MANIFESTE_MAX: u64 = 1024 * 1024;
/// Une image de fond ou un son d'événement : 20 Mo couvrent une photo en
/// pleine résolution ; un son d'événement est lu avec un plafond de 5 Mo.
const FICHIER_MAX: u64 = 20 * 1024 * 1024;
const TOTAL_MAX: u64 = 100 * 1024 * 1024;
const ENTREES_MAX: usize = 64;

const EXTENSIONS: &[&str] = &[
    // Images de fond (les fonds animés sont des WebP animés).
    "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp",
    // Sons d'événements : ceux qu'accepte leur sélecteur, et quelques autres.
    "ogg", "oga", "opus", "mp3", "wav", "flac", "m4a", "aac", "webm",
];

/// `fichiers/<nom simple>` avec une extension connue, ou rien.
fn nom_valide(nom: &str) -> Option<&str> {
    let simple = nom.strip_prefix("fichiers/")?;
    let correct = !simple.is_empty()
        && simple.len() <= 80
        && !simple.starts_with('.')
        && simple
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let extension = simple.rsplit_once('.')?.1.to_ascii_lowercase();
    (correct && EXTENSIONS.contains(&extension.as_str())).then_some(simple)
}

#[derive(Deserialize)]
pub struct FichierAEcrire {
    /// Nom dans l'archive (`fichiers/…`).
    nom: String,
    /// Chemin du fichier sur cette machine.
    source: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct EntreeProfil {
    nom: String,
    taille: u64,
}

#[derive(Serialize, Debug)]
pub struct ProfilLu {
    manifeste: String,
    fichiers: Vec<EntreeProfil>,
}

fn ecrire(destination: &Path, manifeste: &str, fichiers: &[FichierAEcrire]) -> Result<u64, String> {
    if manifeste.len() as u64 > MANIFESTE_MAX {
        return Err("manifeste trop volumineux".into());
    }
    if fichiers.len() > ENTREES_MAX {
        return Err(format!("plus de {ENTREES_MAX} fichiers"));
    }
    let mut total = 0u64;
    for f in fichiers {
        if nom_valide(&f.nom).is_none() {
            return Err(format!("nom de fichier refusé : {}", f.nom));
        }
        let taille = std::fs::metadata(&f.source)
            .map_err(|e| format!("{} : {e}", f.source))?
            .len();
        if taille > FICHIER_MAX {
            return Err(format!("{} dépasse {} Mo", f.source, FICHIER_MAX / 1_048_576));
        }
        total += taille;
    }
    if total > TOTAL_MAX {
        return Err(format!("le profil dépasserait {} Mo", TOTAL_MAX / 1_048_576));
    }

    // Écrit à côté puis renommé : un export interrompu ne laisse pas un
    // profil tronqué sous le nom choisi.
    let partiel = destination.with_extension("sionprofil.partiel");
    let resultat = (|| {
        let fichier = std::fs::File::create(&partiel).map_err(|e| format!("création : {e}"))?;
        let mut zip = zip::ZipWriter::new(fichier);
        let texte = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // Images et sons sont déjà compressés : les recompresser ne gagne rien.
        let brut =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(MANIFESTE, texte).map_err(|e| e.to_string())?;
        zip.write_all(manifeste.as_bytes()).map_err(|e| e.to_string())?;
        for f in fichiers {
            zip.start_file(&f.nom, brut).map_err(|e| e.to_string())?;
            let mut source =
                std::fs::File::open(&f.source).map_err(|e| format!("{} : {e}", f.source))?;
            std::io::copy(&mut source, &mut zip).map_err(|e| format!("{} : {e}", f.source))?;
        }
        let fichier = zip.finish().map_err(|e| e.to_string())?;
        fichier.sync_all().map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    })();
    if let Err(e) = resultat {
        let _ = std::fs::remove_file(&partiel);
        return Err(e);
    }
    std::fs::rename(&partiel, destination).map_err(|e| format!("renommage : {e}"))?;
    Ok(std::fs::metadata(destination).map(|m| m.len()).unwrap_or(0))
}

fn lire(chemin: &Path) -> Result<ProfilLu, String> {
    let fichier = std::fs::File::open(chemin).map_err(|e| format!("ouverture : {e}"))?;
    let mut zip = zip::ZipArchive::new(fichier).map_err(|_| "ce n'est pas un profil Sion".to_string())?;
    if zip.len() > ENTREES_MAX + 1 {
        return Err("profil trop chargé".into());
    }
    let mut fichiers = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entree = zip.by_index(i).map_err(|e| e.to_string())?;
        let nom = entree.name().to_string();
        if nom == MANIFESTE || entree.is_dir() {
            continue;
        }
        // Une entrée inconnue est ignorée, pas refusée : un profil plus
        // récent peut contenir ce qu'on ne sait pas encore appliquer.
        if nom_valide(&nom).is_none() {
            continue;
        }
        if entree.size() > FICHIER_MAX {
            return Err(format!("{nom} dépasse {} Mo", FICHIER_MAX / 1_048_576));
        }
        total += entree.size();
        fichiers.push(EntreeProfil { nom, taille: entree.size() });
    }
    if total > TOTAL_MAX {
        return Err(format!("profil de plus de {} Mo", TOTAL_MAX / 1_048_576));
    }
    let manifeste = zip
        .by_name(MANIFESTE)
        .map_err(|_| "ce n'est pas un profil Sion".to_string())?;
    if manifeste.size() > MANIFESTE_MAX {
        return Err("manifeste trop volumineux".into());
    }
    let mut texte = String::new();
    manifeste
        .take(MANIFESTE_MAX + 1)
        .read_to_string(&mut texte)
        .map_err(|_| "manifeste illisible".to_string())?;
    if texte.len() as u64 > MANIFESTE_MAX {
        return Err("manifeste trop volumineux".into());
    }
    Ok(ProfilLu { manifeste: texte, fichiers })
}

/// Extrait les entrées demandées dans `dossier`, et rend pour chacune le
/// chemin où elle a été posée.
fn extraire_vers(chemin: &Path, noms: &[String], dossier: &Path) -> Result<HashMap<String, String>, String> {
    let fichier = std::fs::File::open(chemin).map_err(|e| format!("ouverture : {e}"))?;
    let mut zip = zip::ZipArchive::new(fichier).map_err(|_| "ce n'est pas un profil Sion".to_string())?;
    std::fs::create_dir_all(dossier).map_err(|e| format!("dossier du profil : {e}"))?;
    let mut poses = HashMap::new();
    let mut total = 0u64;
    for nom in noms {
        let simple = nom_valide(nom).ok_or_else(|| format!("nom de fichier refusé : {nom}"))?;
        let entree = zip.by_name(nom).map_err(|_| format!("{nom} absent du profil"))?;
        if entree.size() > FICHIER_MAX {
            return Err(format!("{nom} dépasse {} Mo", FICHIER_MAX / 1_048_576));
        }
        let cible = dossier.join(simple);
        let mut sortie = std::fs::File::create(&cible).map_err(|e| format!("{simple} : {e}"))?;
        let copies = std::io::copy(&mut entree.take(FICHIER_MAX + 1), &mut sortie)
            .map_err(|e| format!("{simple} : {e}"))?;
        total += copies;
        if copies > FICHIER_MAX || total > TOTAL_MAX {
            drop(sortie);
            let _ = std::fs::remove_file(&cible);
            return Err(format!("{nom} plus gros qu'annoncé"));
        }
        poses.insert(nom.clone(), cible.to_string_lossy().into_owned());
    }
    Ok(poses)
}

fn dossier_profils(app: &tauri::AppHandle<crate::TauriRuntime>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("dossier de données inaccessible : {e}"))?
        .join("profils"))
}

/// Où enregistrer le profil ; `None` si l'utilisateur renonce.
#[tauri::command]
pub async fn profil_choisir_destination() -> Option<String> {
    let choisi = rfd::AsyncFileDialog::new()
        .set_title("Exporter mon profil Sion")
        .set_file_name("mon-profil.sionprofil")
        .add_filter("Profil Sion", &["sionprofil"])
        .save_file()
        .await?;
    let mut chemin = choisi.path().to_path_buf();
    if !matches!(chemin.extension(), Some(e) if e == "sionprofil") {
        chemin.set_extension("sionprofil");
    }
    Some(chemin.to_string_lossy().into_owned())
}

/// Le profil à importer ; `None` si l'utilisateur renonce.
#[tauri::command]
pub async fn profil_choisir_source() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Importer un profil Sion")
        .add_filter("Profil Sion", &["sionprofil"])
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn profil_ecrire(
    chemin: String,
    manifeste: String,
    fichiers: Vec<FichierAEcrire>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || ecrire(Path::new(&chemin), &manifeste, &fichiers))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn profil_lire(chemin: String) -> Result<ProfilLu, String> {
    tauri::async_runtime::spawn_blocking(move || lire(Path::new(&chemin)))
        .await
        .map_err(|e| e.to_string())?
}

/// Extrait les fichiers choisis dans un dossier propre à cet import, sous le
/// dossier de données de Sion — jamais sous `/tmp`, que le redémarrage vide.
#[tauri::command]
pub async fn profil_extraire(
    app: tauri::AppHandle<crate::TauriRuntime>,
    chemin: String,
    noms: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let horodatage = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dossier = dossier_profils(&app)?.join(format!("import-{horodatage}"));
    tauri::async_runtime::spawn_blocking(move || extraire_vers(Path::new(&chemin), &noms, &dossier))
        .await
        .map_err(|e| e.to_string())?
}

/// Retire des profils importés les fichiers que plus aucun réglage ne cite —
/// un import en remplace un autre — puis les dossiers vides.
#[tauri::command]
pub fn profil_nettoyer(
    app: tauri::AppHandle<crate::TauriRuntime>,
    conserves: Vec<String>,
) -> Result<u32, String> {
    let racine = dossier_profils(&app)?;
    Ok(nettoyer(&racine, &conserves))
}

fn nettoyer(racine: &Path, conserves: &[String]) -> u32 {
    let garder = conserves.iter().map(PathBuf::from).collect::<Vec<_>>();
    let mut retires = 0;
    let Ok(dossiers) = std::fs::read_dir(racine) else {
        return 0;
    };
    for dossier in dossiers.flatten().map(|d| d.path()).filter(|p| p.is_dir()) {
        if let Ok(fichiers) = std::fs::read_dir(&dossier) {
            for f in fichiers.flatten().map(|f| f.path()) {
                if f.is_file() && !garder.contains(&f) && std::fs::remove_file(&f).is_ok() {
                    retires += 1;
                }
            }
        }
        let _ = std::fs::remove_dir(&dossier); // n'aboutit que s'il est vide
    }
    retires
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dossier_essai(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sion-profil-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn seuls_les_noms_simples_et_connus_passent() {
        assert_eq!(nom_valide("fichiers/fond-chat.webp"), Some("fond-chat.webp"));
        assert_eq!(nom_valide("fichiers/son-join.OGG"), Some("son-join.OGG"));
        for refuse in [
            "fichiers/../../etc/passwd.png",
            "fichiers/sous/dossier.png",
            "/fichiers/a.png",
            "fichiers/.cache.png",
            "fichiers/script.sh",
            "fichiers/",
            "autre/a.png",
            "fichiers/a b.png",
        ] {
            assert_eq!(nom_valide(refuse), None, "{refuse}");
        }
    }

    #[test]
    fn un_profil_ecrit_se_relit_et_s_extrait() {
        let d = dossier_essai("aller-retour");
        let image = d.join("fond.webp");
        std::fs::write(&image, b"RIFF....WEBP").unwrap();
        let profil = d.join("essai.sionprofil");
        let fichiers = vec![FichierAEcrire {
            nom: "fichiers/fond-chat.webp".into(),
            source: image.to_string_lossy().into_owned(),
        }];
        ecrire(&profil, r#"{"kind":"sion-profile"}"#, &fichiers).unwrap();
        assert!(!profil.with_extension("sionprofil.partiel").exists());

        let lu = lire(&profil).unwrap();
        assert_eq!(lu.manifeste, r#"{"kind":"sion-profile"}"#);
        assert_eq!(
            lu.fichiers,
            vec![EntreeProfil { nom: "fichiers/fond-chat.webp".into(), taille: 12 }]
        );

        let cible = d.join("import");
        let poses = extraire_vers(&profil, &["fichiers/fond-chat.webp".into()], &cible).unwrap();
        let pose = PathBuf::from(&poses["fichiers/fond-chat.webp"]);
        assert_eq!(pose, cible.join("fond-chat.webp"));
        assert_eq!(std::fs::read(&pose).unwrap(), b"RIFF....WEBP");

        // Ménage : ce qui est cité reste, le reste part.
        std::fs::write(cible.join("ancien.png"), b"x").unwrap();
        assert_eq!(nettoyer(&d, &[pose.to_string_lossy().into_owned()]), 1);
        assert!(pose.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn une_archive_etrangere_ne_sort_pas_de_son_dossier() {
        let d = dossier_essai("etrangere");
        let profil = d.join("piege.sionprofil");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&profil).unwrap());
            let o = zip::write::FileOptions::default();
            zip.start_file("manifest.json", o).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file("fichiers/../../evade.png", o).unwrap();
            zip.write_all(b"x").unwrap();
            zip.start_file("fichiers/outil.exe", o).unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        // Les entrées suspectes n'apparaissent même pas à la lecture…
        assert!(lire(&profil).unwrap().fichiers.is_empty());
        // … et les demander explicitement est refusé.
        let cible = d.join("import");
        assert!(extraire_vers(&profil, &["fichiers/../../evade.png".into()], &cible).is_err());
        assert!(extraire_vers(&profil, &["fichiers/outil.exe".into()], &cible).is_err());
        assert!(!d.join("evade.png").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ce_qui_n_est_pas_un_profil_est_refuse() {
        let d = dossier_essai("pas-profil");
        let faux = d.join("faux.sionprofil");
        std::fs::write(&faux, b"pas une archive").unwrap();
        assert!(lire(&faux).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
