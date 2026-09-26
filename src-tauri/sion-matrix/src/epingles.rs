//! Messages épinglés d'un salon (`getPinnedSummaries` du moteur JS) : de
//! quoi afficher la barre des épinglés, y compris un épinglé trop ancien pour
//! être dans le fil chargé (l'adaptateur le demande alors au serveur).
//!
//! Écart VOULU : le média d'un épinglé chiffré est servi (déchiffré) par
//! `sion-media` ; le JS n'en donnait aucune URL.
use serde::Serialize;
use serde_json::Value;

use crate::messages::{EvenementBrut, SourceMedia};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeEpingle {
    pub event_id: String,
    pub sender: String,
    pub ts: i64,
    pub text: String,
    /// Faux quand l'événement a dû être demandé au serveur : le rejoindre
    /// demandera de paginer.
    pub loaded: bool,
    /// « image », « video », « audio », « file » ; `None` pour un texte.
    pub media: Option<&'static str>,
    /// Vignette si le message en a une, sinon le média lui-même.
    pub media_url: Option<String>,
    /// Le média lui-même, jamais sa vignette.
    pub source_url: Option<String>,
}

fn source(url: Option<&Value>, fichier: Option<&Value>) -> Option<SourceMedia> {
    url.and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .map(|u| SourceMedia::Mxc(u.to_owned()))
        .or_else(|| fichier.filter(|f| f.is_object()).map(|f| SourceMedia::Chiffre(f.clone())))
}

/// Résumé d'un épinglé ; `contenu` est son contenu affiché (éditions
/// appliquées s'il est chargé), `nom` le nom de l'expéditeur s'il est connu.
pub(crate) fn resumer(
    ev: &EvenementBrut,
    contenu: &Value,
    nom: Option<String>,
    charge: bool,
    url: &dyn Fn(&SourceMedia) -> Option<String>,
) -> ResumeEpingle {
    let info = contenu.get("info");
    let media = match contenu.get("msgtype").and_then(Value::as_str) {
        Some("m.image") => Some("image"),
        Some("m.video") => Some("video"),
        Some("m.audio") => Some("audio"),
        Some("m.file") => Some("file"),
        _ => None,
    };
    let original = source(contenu.get("url"), contenu.get("file"));
    let vignette = info.and_then(|i| source(i.get("thumbnail_url"), i.get("thumbnail_file")));
    ResumeEpingle {
        event_id: ev.id.clone(),
        sender: nom.filter(|n| !n.is_empty()).unwrap_or_else(|| ev.expediteur.clone()),
        ts: ev.ts,
        text: contenu.get("body").and_then(Value::as_str).unwrap_or("").to_owned(),
        loaded: charge,
        media,
        media_url: vignette.or_else(|| original.clone()).as_ref().and_then(url),
        source_url: original.as_ref().and_then(url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(contenu: Value) -> EvenementBrut {
        EvenementBrut {
            type_: "m.room.message".into(),
            contenu,
            id: "$p".into(),
            expediteur: "@alice:hs".into(),
            ts: 42,
            ..Default::default()
        }
    }
    fn url(s: &SourceMedia) -> Option<String> {
        Some(match s {
            SourceMedia::Mxc(m) => format!("clair:{m}"),
            SourceMedia::Chiffre(f) => format!("chiffre:{}", f["url"].as_str()?),
        })
    }

    #[test]
    fn texte_et_expediteur() {
        let e = ev(json!({ "msgtype": "m.text", "body": "à retenir" }));
        let r = resumer(&e, &e.contenu, None, true, &url);
        assert_eq!((r.sender.as_str(), r.text.as_str(), r.media, r.loaded), ("@alice:hs", "à retenir", None, true));
        let r = resumer(&e, &e.contenu, Some("Alice".into()), false, &url);
        assert_eq!((r.sender.as_str(), r.loaded), ("Alice", false));
    }

    #[test]
    fn image_claire_avec_vignette() {
        let e = ev(json!({ "msgtype": "m.image", "body": "p.png", "url": "mxc://hs/o", "info": { "thumbnail_url": "mxc://hs/v" } }));
        let r = resumer(&e, &e.contenu, None, true, &url);
        assert_eq!(r.media, Some("image"));
        assert_eq!(r.media_url.as_deref(), Some("clair:mxc://hs/v"));
        assert_eq!(r.source_url.as_deref(), Some("clair:mxc://hs/o"));
    }

    #[test]
    fn video_chiffree_servie_dechiffree() {
        let e = ev(json!({ "msgtype": "m.video", "body": "v.mp4", "file": { "url": "mxc://hs/c", "key": {} } }));
        let r = resumer(&e, &e.contenu, None, true, &url);
        assert_eq!((r.media_url.as_deref(), r.source_url.as_deref()), (Some("chiffre:mxc://hs/c"), Some("chiffre:mxc://hs/c")));
    }
}
