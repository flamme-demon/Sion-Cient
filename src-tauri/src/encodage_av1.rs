//! Encodeurs d'une conversion vidéo (import par lien, envoi trop lourd).
//!
//! L'AV1 se faisait sur le processeur, par libaom quand le ffmpeg livré n'a
//! pas SVT-AV1 (build statique sous Linux) : 45 s par tranche de 10 s pour un
//! reel de 1080x1920, soit 13 minutes pour trois minutes de vidéo, avec un
//! pourcentage bloqué à 0 — Sion semblait planté (02/10). La carte graphique
//! fait le même travail en 1,3 s (RX 7900 XTX, VAAPI), à taille égale.
//!
//! Les encodeurs matériels sont donc essayés d'abord, dans le ffmpeg livré
//! puis dans celui du système (sous Linux, le livré n'a pas VAAPI) ; un essai
//! réel d'une image, une fois par lancement, écarte ceux qui sont compilés
//! sans matériel derrière.

use std::sync::OnceLock;

/// Un encodeur AV1 matériel qui a réussi son essai sur cette machine.
#[derive(Clone, Debug)]
pub struct EncodeurMateriel {
    /// ffmpeg qui le porte.
    pub ffmpeg: String,
    /// Nom ffmpeg (`av1_vaapi`, `av1_nvenc`…).
    pub nom: &'static str,
    /// Nœud de rendu, pour VAAPI.
    peripherique: Option<String>,
}

const MATERIELS: &[&str] = if cfg!(target_os = "linux") {
    &["av1_vaapi", "av1_nvenc", "av1_qsv"]
} else {
    &["av1_nvenc", "av1_amf", "av1_qsv"]
};

/// Premier nœud de rendu DRM, pour VAAPI.
fn noeud_de_rendu() -> Option<String> {
    (128..136)
        .map(|n| format!("/dev/dri/renderD{n}"))
        .find(|p| std::path::Path::new(p).exists())
}

impl EncodeurMateriel {
    /// Options d'entrée, filtre vidéo et réglages pour un débit visé.
    fn arguments(&self, entree: &str, kbps: u64) -> (Vec<String>, Vec<String>) {
        let s = |v: &str| v.to_string();
        let mut avant = Vec::new();
        let mut apres = Vec::new();
        if let Some(p) = &self.peripherique {
            avant.extend([s("-vaapi_device"), p.clone()]);
        }
        avant.extend([s("-i"), s(entree)]);
        // Plafond et tampon : pas de pics qui feraient dépasser la limite.
        let debit = [
            s("-b:v"),
            format!("{kbps}k"),
            s("-maxrate"),
            format!("{}k", kbps * 3 / 2),
            s("-bufsize"),
            format!("{}k", kbps * 2),
        ];
        match self.nom {
            "av1_vaapi" => apres.extend([s("-vf"), s("format=nv12,hwupload"), s("-c:v"), s("av1_vaapi")]),
            "av1_nvenc" => apres.extend([s("-pix_fmt"), s("yuv420p"), s("-c:v"), s("av1_nvenc"), s("-preset"), s("p5")]),
            "av1_amf" => apres.extend([s("-pix_fmt"), s("yuv420p"), s("-c:v"), s("av1_amf"), s("-quality"), s("balanced")]),
            _ => apres.extend([s("-pix_fmt"), s("nv12"), s("-c:v"), s(self.nom)]),
        }
        apres.extend(debit);
        (avant, apres)
    }
}

/// Essaie d'encoder une image avec `nom` ; le matériel absent échoue vite.
fn essayer(ffmpeg: &str, nom: &'static str) -> Option<EncodeurMateriel> {
    let peripherique = if nom == "av1_vaapi" { Some(noeud_de_rendu()?) } else { None };
    let enc = EncodeurMateriel { ffmpeg: ffmpeg.to_string(), nom, peripherique };
    let (avant, apres) = enc.arguments("color=c=gray:s=256x256:r=1:d=1", 300);
    let mut cmd = crate::hidden_command(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    // Source synthétique : `-f lavfi` juste avant son `-i`.
    let i = avant.iter().position(|a| a == "-i").unwrap_or(0);
    cmd.args(&avant[..i]).args(["-f", "lavfi"]).args(&avant[i..]);
    cmd.args(["-frames:v", "1"]).args(&apres).args(["-f", "null", "-"]);
    let ok = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok.then_some(enc)
}

/// `nom` figure-t-il dans la liste `ffmpeg -encoders` ? (On n'essaie pas
/// un encodeur qui n'est pas compilé.)
fn porte(liste: &str, nom: &str) -> bool {
    liste.lines().any(|l| l.split_whitespace().nth(1) == Some(nom))
}

/// Encodeurs AV1 matériels qui marchent ici, dans l'ordre de préférence.
/// Cherchés une fois par lancement (quelques dixièmes de seconde).
pub fn materiels(ffmpeg_livre: &str) -> &'static [EncodeurMateriel] {
    static TROUVES: OnceLock<Vec<EncodeurMateriel>> = OnceLock::new();
    TROUVES.get_or_init(|| {
        let mut candidats = vec![ffmpeg_livre.to_string()];
        let systeme = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        if ffmpeg_livre != systeme {
            candidats.push(systeme.to_string());
        }
        let mut trouves = Vec::new();
        for ffmpeg in candidats {
            let liste = crate::hidden_command(&ffmpeg)
                .args(["-hide_banner", "-encoders"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            for &nom in MATERIELS {
                if trouves.iter().any(|e: &EncodeurMateriel| e.nom == nom) || !porte(&liste, nom) {
                    continue;
                }
                if let Some(enc) = essayer(&ffmpeg, nom) {
                    trouves.push(enc);
                }
            }
        }
        log::info!(
            "[Sion][vidéo] encodeurs AV1 matériels : {}",
            if trouves.is_empty() {
                "aucun".to_string()
            } else {
                trouves.iter().map(|e| format!("{} ({})", e.nom, e.ffmpeg)).collect::<Vec<_>>().join(", ")
            }
        );
        trouves
    })
}

/// Une tentative de conversion : quel ffmpeg, quels arguments, pour le
/// journal le nom de l'encodeur.
pub struct Tentative {
    pub ffmpeg: String,
    pub nom: String,
    pub arguments: Vec<String>,
}

/// Tentatives pour tenir `kbps` de vidéo (audio AAC 128k en plus), du plus
/// rapide au plus sûr : matériel, SVT-AV1, libaom en réglage rapide, H.264.
/// `fin` : options de sortie communes (audio, conteneur, progression,
/// fichier), ajoutées à chaque tentative.
pub fn tentatives_au_debit(ffmpeg_livre: &str, entree: &str, kbps: u64, fin: &[String]) -> Vec<Tentative> {
    let s = |v: &str| v.to_string();
    let debit = format!("{kbps}k");
    let mut liste = tentatives_materielles(ffmpeg_livre, entree, kbps, fin);
    let logiciel = |nom: &str, reglages: &[&str]| {
        let mut a = vec![s("-y"), s("-i"), s(entree), s("-c:v"), s(nom)];
        a.extend(reglages.iter().map(|r| s(r)));
        a.extend([s("-b:v"), debit.clone(), s("-pix_fmt"), s("yuv420p")]);
        a.extend(fin.iter().cloned());
        Tentative { ffmpeg: s(ffmpeg_livre), nom: s(nom), arguments: a }
    };
    liste.push(logiciel("libsvtav1", &["-preset", "8", "-g", "240"]));
    // `realtime` + `cpu-used 8` : 7 s par tranche de 10 s en 720p, contre
    // 45 s en 1080p au réglage de qualité d'avant.
    liste.push(logiciel("libaom-av1", &["-usage", "realtime", "-cpu-used", "8", "-row-mt", "1"]));
    liste.push(logiciel("libx264", &["-preset", "veryfast"]));
    liste
}

/// Les seules tentatives matérielles, au débit `kbps` (vide sans carte
/// capable).
pub fn tentatives_materielles(ffmpeg_livre: &str, entree: &str, kbps: u64, fin: &[String]) -> Vec<Tentative> {
    materiels(ffmpeg_livre)
        .iter()
        .map(|enc| {
            let (avant, apres) = enc.arguments(entree, kbps);
            let mut a = vec!["-y".to_string()];
            a.extend(avant);
            a.extend(apres);
            a.extend(fin.iter().cloned());
            Tentative { ffmpeg: enc.ffmpeg.clone(), nom: enc.nom.to_string(), arguments: a }
        })
        .collect()
}

/// Débit d'une conversion sans limite de taille, selon le petit côté de
/// l'image : de quoi rester proche de l'AV1 logiciel en qualité constante.
pub fn debit_selon_resolution(petit_cote: u32) -> u64 {
    match petit_cote {
        0..=480 => 900,
        481..=720 => 1_800,
        721..=1080 => 3_200,
        _ => 6_000,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_encodeur_se_reconnait_dans_la_liste_de_ffmpeg() {
        let liste = " V....D libaom-av1           libaom AV1 (codec av1)\n V....D av1_vaapi            AV1 (VAAPI) (codec av1)\n";
        assert!(porte(liste, "av1_vaapi"));
        assert!(!porte(liste, "av1_nvenc"));
        // Un nom contenu dans un autre ne compte pas.
        assert!(!porte(" V....D av1_vaapi_x  x\n", "av1_vaapi"));
    }

    /// Sur la machine : `SION_ESSAI_FFMPEG=… SION_ESSAI_VIDEO=… cargo test
    /// essai_reel -- --ignored --nocapture`. Encode la vidéo au débit qui
    /// tient 20 Mo et dit quel encodeur l'a emporté, en combien de temps.
    #[test]
    #[ignore = "machine réelle : ffmpeg, vidéo et carte graphique"]
    fn essai_reel_de_la_chaine() {
        let ffmpeg = std::env::var("SION_ESSAI_FFMPEG").expect("SION_ESSAI_FFMPEG");
        let video = std::env::var("SION_ESSAI_VIDEO").expect("SION_ESSAI_VIDEO");
        let sortie = std::env::temp_dir().join("sion_essai_av1.mp4");
        let fin: Vec<String> = ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(sortie.to_string_lossy().into_owned()))
            .collect();
        for t in tentatives_au_debit(&ffmpeg, &video, 752, &fin) {
            let debut = std::time::Instant::now();
            let ok = std::process::Command::new(&t.ffmpeg)
                .args(["-hide_banner", "-loglevel", "error"])
                .args(&t.arguments)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            let taille = std::fs::metadata(&sortie).map(|m| m.len()).unwrap_or(0);
            println!("{} ({}) : {} en {:.1} s, {:.1} Mo", t.nom, t.ffmpeg, if ok { "ok" } else { "échec" }, debut.elapsed().as_secs_f64(), taille as f64 / 1_048_576.0);
            if ok {
                assert!(taille <= 20 * 1_048_576, "au-dessus de 20 Mo");
                return;
            }
        }
        panic!("aucun encodeur n'a abouti");
    }

    #[test]
    fn vaapi_ouvre_son_peripherique_avant_l_entree_et_vise_le_debit() {
        let enc = EncodeurMateriel {
            ffmpeg: "ffmpeg".into(),
            nom: "av1_vaapi",
            peripherique: Some("/dev/dri/renderD128".into()),
        };
        let (avant, apres) = enc.arguments("src.mp4", 700);
        assert_eq!(avant, ["-vaapi_device", "/dev/dri/renderD128", "-i", "src.mp4"]);
        assert!(apres.windows(2).any(|w| w == ["-b:v", "700k"]));
        assert!(apres.windows(2).any(|w| w == ["-maxrate", "1050k"]));
        assert!(apres.windows(2).any(|w| w == ["-vf", "format=nv12,hwupload"]));
    }
}
