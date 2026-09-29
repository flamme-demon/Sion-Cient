//! Médias servis à l'interface par `sion-media://` : téléchargés — et
//! déchiffrés — par Rust.
//!
//! Chaque média rencontré en construisant les messages est rangé dans un
//! registre sous une clé opaque ; l'interface ne reçoit que
//! `<préfixe><clé>`. Les clés de déchiffrement d'un fichier chiffré ne
//! quittent donc jamais Rust, et le téléchargement peut s'authentifier (un
//! `<img src>` ne sait pas envoyer l'en-tête qu'exigent les médias
//! authentifiés — constaté le 20/09).
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::events::room::{EncryptedFile, MediaSource};
use matrix_sdk::ruma::media::Method;
use matrix_sdk::ruma::{uint, OwnedMxcUri};
use matrix_sdk::Client;

use crate::messages::SourceMedia;
use crate::{Erreur, Resultat};

/// Préfixe par défaut (Linux, macOS). Sous Windows et Android, Tauri sert
/// les protocoles personnalisés en `http://<protocole>.localhost/` :
/// l'application fournit alors le sien.
pub const PREFIXE_PAR_DEFAUT: &str = "sion-media://localhost/";

/// Type MIME d'après les premiers octets. Le `mimetype` annoncé par
/// l'expéditeur n'est pas fiable, et WebKit refuse de lire un `<audio>` ou
/// une `<video>` servis sans type.
pub fn type_mime(octets: &[u8]) -> &'static str {
    let debut = |signature: &[u8]| octets.starts_with(signature);
    let a = |position: usize, signature: &[u8]| octets.get(position..position + signature.len()) == Some(signature);
    if debut(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if debut(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if debut(b"GIF87a") || debut(b"GIF89a") {
        "image/gif"
    } else if debut(b"RIFF") && a(8, b"WEBP") {
        "image/webp"
    } else if debut(b"RIFF") && a(8, b"WAVE") {
        "audio/wav"
    } else if a(4, b"ftypavif") || a(4, b"ftypavis") {
        "image/avif"
    } else if a(4, b"ftypM4A") {
        "audio/mp4"
    } else if a(4, b"ftyp") {
        "video/mp4"
    } else if debut(&[0x1A, 0x45, 0xDF, 0xA3]) {
        // Matroska : WebM (vidéo ou son seul) ; le lecteur tranche.
        "video/webm"
    } else if debut(b"OggS") {
        "audio/ogg"
    } else if debut(b"fLaC") {
        "audio/flac"
    } else if debut(b"ID3") || (octets.len() > 1 && octets[0] == 0xFF && octets[1] & 0xE0 == 0xE0) {
        "audio/mpeg"
    } else if debut(b"%PDF") {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

/// Plage d'octets demandée par un en-tête HTTP `Range` (`bytes=a-b`,
/// `bytes=a-`, `bytes=-n`), bornes incluses, limitée à `morceau_max` octets :
/// le lecteur vidéo en redemande la suite. `None` si la plage est
/// insatisfiable (réponse 416). Plusieurs plages : seule la première compte.
pub fn plage_http(entete: &str, total: u64, morceau_max: u64) -> Option<(u64, u64)> {
    let spec = entete.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (debut, fin) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    let (debut, fin) = match (debut.trim(), fin.trim()) {
        ("", "") => return None,
        // Les n derniers octets.
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 {
                return None;
            }
            (total.saturating_sub(n), total - 1)
        }
        (a, "") => (a.parse().ok()?, total - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(total - 1)),
    };
    if debut >= total || fin < debut {
        return None;
    }
    Some((debut, fin.min(debut + morceau_max.max(1) - 1)))
}

/// Ce qu'on demande d'un média.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormatMedia {
    Original,
    /// Miniature 600×400 du serveur (`mxcToThumbnail`), pour le fil.
    Vignette,
    /// Miniature 96×96 recadrée, pour un avatar ou l'icône d'un salon.
    Avatar,
}

impl FormatMedia {
    /// Le format demandé par la requête d'une URL `sion-media`.
    pub fn depuis_requete(requete: Option<&str>) -> Self {
        let a = |cle: &str| requete.is_some_and(|q| q.split('&').any(|p| p == cle));
        if a("avatar=1") {
            Self::Avatar
        } else if a("vignette=1") {
            Self::Vignette
        } else {
            Self::Original
        }
    }
}

pub(crate) struct Medias {
    prefixe: String,
    sources: Mutex<HashMap<String, SourceMedia>>,
}

fn cle(source: &SourceMedia) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    match source {
        SourceMedia::Mxc(m) => ("mxc", m.as_str()).hash(&mut h),
        SourceMedia::Chiffre(f) => ("chiffre", f.to_string()).hash(&mut h),
    }
    format!("{:016x}", h.finish())
}

impl Medias {
    pub fn nouveau(prefixe: impl Into<String>) -> Self {
        Self { prefixe: prefixe.into(), sources: Mutex::new(HashMap::new()) }
    }

    /// URL `sion-media` d'un média, `None` si la source est inexploitable.
    pub fn url(&self, source: &SourceMedia, vignette: bool) -> Option<String> {
        self.url_format(source, if vignette { FormatMedia::Vignette } else { FormatMedia::Original })
    }

    /// URL `sion-media` d'un avatar ou d'une icône de salon. Ces images
    /// passent par le cœur comme les autres : le serveur refuse les médias
    /// non authentifiés (« Unauthenticated media is disabled », constaté le
    /// 27/09 sur sionchat.fr), et un `<img>` ne sait pas s'authentifier.
    pub fn url_avatar(&self, mxc: &str) -> Option<String> {
        self.url_format(&SourceMedia::Mxc(mxc.to_owned()), FormatMedia::Avatar)
    }

    pub fn url_format(&self, source: &SourceMedia, format: FormatMedia) -> Option<String> {
        let valide = match source {
            SourceMedia::Mxc(m) => m.starts_with("mxc://"),
            SourceMedia::Chiffre(f) => f.get("url").and_then(|u| u.as_str()).is_some_and(|u| u.starts_with("mxc://")),
        };
        if !valide {
            return None;
        }
        let cle = cle(source);
        self.sources.lock().unwrap().insert(cle.clone(), source.clone());
        let suffixe = match format {
            FormatMedia::Original => "",
            FormatMedia::Vignette => "?vignette=1",
            FormatMedia::Avatar => "?avatar=1",
        };
        Some(format!("{}{cle}{suffixe}", self.prefixe))
    }

    /// Contenu d'un média du registre. La miniature (600×400, comme
    /// `mxcToThumbnail`) n'existe que pour un média en clair : le serveur ne
    /// peut pas redimensionner ce qu'il ne sait pas lire.
    pub async fn contenu(&self, client: &Client, cle: &str, format: FormatMedia) -> Resultat<Vec<u8>> {
        let source = self
            .sources
            .lock()
            .unwrap()
            .get(cle)
            .cloned()
            .ok_or_else(|| Erreur::Autre(format!("média inconnu : {cle}")))?;
        let (source, format) = match source {
            SourceMedia::Mxc(m) => {
                let format = match format {
                    FormatMedia::Original => MediaFormat::File,
                    FormatMedia::Vignette => MediaFormat::Thumbnail(MediaThumbnailSettings::new(uint!(600), uint!(400))),
                    FormatMedia::Avatar => MediaFormat::Thumbnail(MediaThumbnailSettings::with_method(Method::Crop, uint!(96), uint!(96))),
                };
                (MediaSource::Plain(OwnedMxcUri::from(m)), format)
            }
            SourceMedia::Chiffre(f) => {
                let fichier: EncryptedFile = serde_json::from_value(f)?;
                (MediaSource::Encrypted(Box::new(fichier)), MediaFormat::File)
            }
        };
        Ok(client
            .media()
            .get_media_content(&MediaRequestParameters { source, format }, true)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn plages_http() {
        assert_eq!(plage_http("bytes=0-", 1000, 10_000), Some((0, 999)));
        assert_eq!(plage_http("bytes=100-199", 1000, 10_000), Some((100, 199)));
        assert_eq!(plage_http("bytes=900-5000", 1000, 10_000), Some((900, 999)));
        assert_eq!(plage_http("bytes=-100", 1000, 10_000), Some((900, 999)));
        // Bornée : le lecteur redemande la suite.
        assert_eq!(plage_http("bytes=0-", 1000, 256), Some((0, 255)));
        assert_eq!(plage_http("bytes=0-1,5-9", 1000, 10_000), Some((0, 1)));
        assert_eq!(plage_http("bytes=1000-", 1000, 10_000), None);
        assert_eq!(plage_http("bytes=5-2", 1000, 10_000), None);
        assert_eq!(plage_http("octets=0-", 1000, 10_000), None);
        assert_eq!(plage_http("bytes=0-", 0, 10_000), None);
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn meme_source_meme_url_et_la_cle_ne_fuit_pas() {
        let m = Medias::nouveau(PREFIXE_PAR_DEFAUT);
        let chiffre = SourceMedia::Chiffre(json!({ "url": "mxc://hs/a", "key": { "k": "SECRET" }, "iv": "x" }));
        let a = m.url(&chiffre, false).unwrap();
        assert_eq!(a, m.url(&chiffre, false).unwrap());
        assert!(a.starts_with("sion-media://localhost/") && !a.contains("SECRET"));
    }

    #[test]
    fn types_reconnus() {
        assert_eq!(type_mime(b"\x89PNG\r\n\x1a\n...."), "image/png");
        assert_eq!(type_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(type_mime(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(type_mime(b"\0\0\0\x20ftypisom"), "video/mp4");
        assert_eq!(type_mime(&[0x1A, 0x45, 0xDF, 0xA3, 0x01]), "video/webm");
        assert_eq!(type_mime(b"ID3\x04"), "audio/mpeg");
        assert_eq!(type_mime(b"texte"), "application/octet-stream");
        assert_eq!(type_mime(b""), "application/octet-stream");
    }

    #[test]
    fn vignette_et_sources_invalides() {
        let m = Medias::nouveau("http://sion-media.localhost/");
        let u = m.url(&SourceMedia::Mxc("mxc://hs/b".into()), true).unwrap();
        assert!(u.starts_with("http://sion-media.localhost/") && u.ends_with("?vignette=1"));
        assert_eq!(m.url(&SourceMedia::Mxc("https://ailleurs/b".into()), false), None);
        assert_eq!(m.url(&SourceMedia::Chiffre(json!({ "key": {} })), false), None);
        assert!(m.url_avatar("mxc://hs/a").unwrap().ends_with("?avatar=1"));
    }

    #[test]
    fn format_lu_dans_la_requete() {
        assert_eq!(FormatMedia::depuis_requete(Some("avatar=1")), FormatMedia::Avatar);
        assert_eq!(FormatMedia::depuis_requete(Some("x=2&vignette=1")), FormatMedia::Vignette);
        assert_eq!(FormatMedia::depuis_requete(None), FormatMedia::Original);
    }
}
