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
        let valide = match source {
            SourceMedia::Mxc(m) => m.starts_with("mxc://"),
            SourceMedia::Chiffre(f) => f.get("url").and_then(|u| u.as_str()).is_some_and(|u| u.starts_with("mxc://")),
        };
        if !valide {
            return None;
        }
        let cle = cle(source);
        self.sources.lock().unwrap().insert(cle.clone(), source.clone());
        Some(format!("{}{cle}{}", self.prefixe, if vignette { "?vignette=1" } else { "" }))
    }

    /// Contenu d'un média du registre. La miniature (600×400, comme
    /// `mxcToThumbnail`) n'existe que pour un média en clair : le serveur ne
    /// peut pas redimensionner ce qu'il ne sait pas lire.
    pub async fn contenu(&self, client: &Client, cle: &str, vignette: bool) -> Resultat<Vec<u8>> {
        let source = self
            .sources
            .lock()
            .unwrap()
            .get(cle)
            .cloned()
            .ok_or_else(|| Erreur::Autre(format!("média inconnu : {cle}")))?;
        let (source, format) = match source {
            SourceMedia::Mxc(m) => {
                let format = if vignette {
                    MediaFormat::Thumbnail(MediaThumbnailSettings::new(uint!(600), uint!(400)))
                } else {
                    MediaFormat::File
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
    }
}
