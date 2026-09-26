//! Classement d'un salon — port de `mapRoomToChannel`
//! (src/stores/useMatrixStore.ts). Pur : l'adaptateur (`synchro.rs`) lit le
//! salon matrix-sdk, ce module décide. Chaque règle a son test.
use std::collections::HashMap;

use serde::Serialize;

use crate::appels::{self, EvenementAppel, UtilisateurVocal};

/// Miroir de `Channel` (src/types/matrix.ts) : l'interface le consomme tel
/// quel.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Salon {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub has_voice: bool,
    pub voice_users: Vec<UtilisateurVocal>,
    pub created_at: i64,
    pub last_activity: i64,
    #[serde(rename = "isDM")]
    pub is_dm: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dm_user_id: Option<String>,
    pub is_soundboard: bool,
}

/// Ce que l'adaptateur a lu d'un salon.
#[derive(Clone, Debug, Default)]
pub(crate) struct EntreesSalon {
    pub id: String,
    /// Nom calculé (nom, alias, héros) ; vide si le salon n'en a aucun.
    pub nom: String,
    pub sujet: Option<String>,
    /// URL http de l'avatar, déjà convertie depuis le mxc.
    pub icone: Option<String>,
    /// `type` du contenu de `m.room.create`.
    pub type_creation: String,
    /// `type` de l'état personnalisé `m.room.type` — celui que Sion pose sur
    /// ses salons vocaux (`m.voice_channel`).
    pub type_personnalise: String,
    /// Présence d'un état `org.matrix.msc3401.call`.
    pub a_evenement_appel: bool,
    pub membres_appel: Vec<EvenementAppel>,
    pub alias: Option<String>,
    pub cree_a: i64,
    pub derniere_activite: i64,
    /// Correspondants de ce salon d'après `m.direct`.
    pub cibles_directes: Vec<String>,
    pub moi: String,
    /// Membres ayant rejoint (`join`).
    pub membres_joints: Vec<String>,
    /// Tous les membres connus, avec « encore là » (`join` ou `invite`).
    pub membres_historiques: Vec<(String, bool)>,
    /// Nom affiché et avatar http par utilisateur, pour les participants
    /// vocaux.
    pub profils: HashMap<String, (Option<String>, Option<String>)>,
}

/// Règle « vocal » du moteur JS, à l'identique.
fn est_vocal(e: &EntreesSalon) -> bool {
    let sujet = e.sujet.as_deref().unwrap_or("").to_lowercase();
    e.type_creation.contains("voice")
        || e.type_personnalise.contains("voice")
        || sujet.contains("voice")
        || e.type_creation == "org.matrix.msc3417.call"
        || e.membres_appel.iter().any(appels::a_contenu_appel)
        || e.a_evenement_appel
}

/// Règle « MP » et correspondant : `m.direct`, sinon un salon à deux sans
/// type, sinon un MP orphelin (le correspondant est parti, il ne reste que
/// moi, et le salon n'a jamais compté plus de deux membres).
fn conversation_privee(e: &EntreesSalon) -> Option<String> {
    let mut directes = e.cibles_directes.clone();
    directes.sort();
    if let Some(cible) = directes.into_iter().next() {
        return Some(cible);
    }
    let sans_type = e.type_creation.is_empty() && e.type_personnalise.is_empty();
    if !sans_type {
        return None;
    }
    if e.membres_joints.len() == 2 {
        if let Some(autre) = e.membres_joints.iter().find(|m| **m != e.moi) {
            return Some(autre.clone());
        }
    }
    let encore_la: Vec<&String> = e.membres_historiques.iter().filter(|(_, la)| *la).map(|(m, _)| m).collect();
    if encore_la.len() == 1 && *encore_la[0] == e.moi && e.membres_historiques.len() <= 2 {
        return e.membres_historiques.iter().map(|(m, _)| m).find(|m| **m != e.moi).cloned();
    }
    None
}

pub(crate) fn classer(e: &EntreesSalon, maintenant_serveur: i64) -> Salon {
    let dm = conversation_privee(e);
    let nom = if !e.nom.is_empty() {
        e.nom.clone()
    } else {
        e.alias.clone().unwrap_or_else(|| e.id.clone())
    };
    Salon {
        id: e.id.clone(),
        name: nom,
        topic: e.sujet.clone().filter(|s| !s.is_empty()),
        icon: e.icone.clone(),
        has_voice: est_vocal(e),
        voice_users: appels::participants(&e.membres_appel, maintenant_serveur, |id| {
            e.profils.get(id).cloned().unwrap_or((None, None))
        }),
        created_at: e.cree_a,
        last_activity: e.derniere_activite,
        is_dm: dm.is_some(),
        dm_user_id: dm,
        // Masqués de la barre latérale : on y accède par le panneau dédié.
        is_soundboard: e.alias.as_deref().is_some_and(|a| a.starts_with("#soundboard:")),
    }
}

/// `mxc://serveur/id` → URL http de téléchargement, comme `mxcUrlToHttp` du
/// moteur JS. Les médias passeront par `sion-media://` en T2.
pub(crate) fn mxc_vers_http(base: &str, mxc: &str) -> Option<String> {
    let (serveur, id) = mxc.strip_prefix("mxc://")?.split_once('/')?;
    if serveur.is_empty() || id.is_empty() {
        return None;
    }
    Some(format!("{}/_matrix/media/v3/download/{serveur}/{id}", base.trim_end_matches('/')))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> EntreesSalon {
        EntreesSalon {
            id: "!salon:hs".into(),
            nom: "Général".into(),
            moi: "@moi:hs".into(),
            membres_joints: vec!["@moi:hs".into(), "@a:hs".into(), "@b:hs".into()],
            membres_historiques: vec![("@moi:hs".into(), true), ("@a:hs".into(), true), ("@b:hs".into(), true)],
            ..Default::default()
        }
    }

    #[test]
    fn salon_texte_ordinaire() {
        let s = classer(&base(), 0);
        assert!(!s.has_voice && !s.is_dm && !s.is_soundboard);
        assert_eq!(s.name, "Général");
    }

    #[test]
    fn vocal_par_type_personnalise_meme_sujet_modifie() {
        // La raison du choix de la synchro classique : le sujet peut changer,
        // `m.room.type` reste.
        let e = EntreesSalon { type_personnalise: "m.voice_channel".into(), sujet: Some("Salon des potes".into()), ..base() };
        assert!(classer(&e, 0).has_voice);
    }

    #[test]
    fn vocal_par_sujet_type_de_creation_ou_evenement_d_appel() {
        assert!(classer(&EntreesSalon { sujet: Some("Voice".into()), ..base() }, 0).has_voice);
        assert!(classer(&EntreesSalon { type_creation: "org.matrix.msc3417.call".into(), ..base() }, 0).has_voice);
        assert!(classer(&EntreesSalon { a_evenement_appel: true, ..base() }, 0).has_voice);
        let appel = EvenementAppel {
            expediteur: "@a:hs".into(),
            cle_etat: "_@a:hs_d_m.call".into(),
            contenu: json!({ "application": "m.call", "device_id": "d" }),
            ts: 1,
        };
        assert!(classer(&EntreesSalon { membres_appel: vec![appel], ..base() }, 0).has_voice);
    }

    #[test]
    fn mp_par_m_direct() {
        let e = EntreesSalon { cibles_directes: vec!["@picsou:hs".into()], ..base() };
        let s = classer(&e, 0);
        assert!(s.is_dm);
        assert_eq!(s.dm_user_id.as_deref(), Some("@picsou:hs"));
    }

    #[test]
    fn mp_par_repli_a_deux_sans_type() {
        let e = EntreesSalon {
            membres_joints: vec!["@moi:hs".into(), "@narkow:hs".into()],
            membres_historiques: vec![("@moi:hs".into(), true), ("@narkow:hs".into(), true)],
            ..base()
        };
        assert_eq!(classer(&e, 0).dm_user_id.as_deref(), Some("@narkow:hs"));
        // Un salon vocal à deux n'est pas un MP.
        let vocal = EntreesSalon { type_personnalise: "m.voice_channel".into(), ..e };
        assert!(!classer(&vocal, 0).is_dm);
    }

    #[test]
    fn mp_orphelin_correspondant_parti() {
        let e = EntreesSalon {
            membres_joints: vec!["@moi:hs".into()],
            membres_historiques: vec![("@moi:hs".into(), true), ("@parti:hs".into(), false)],
            ..base()
        };
        assert_eq!(classer(&e, 0).dm_user_id.as_deref(), Some("@parti:hs"));
        // Trois membres dans l'histoire : ce n'était pas un MP.
        let e3 = EntreesSalon {
            membres_joints: vec!["@moi:hs".into()],
            membres_historiques: vec![("@moi:hs".into(), true), ("@a:hs".into(), false), ("@b:hs".into(), false)],
            ..base()
        };
        assert!(!classer(&e3, 0).is_dm);
    }

    #[test]
    fn soundboard_par_alias() {
        let e = EntreesSalon { alias: Some("#soundboard:sionchat.fr".into()), ..base() };
        assert!(classer(&e, 0).is_soundboard);
    }

    #[test]
    fn nom_absent_on_prend_l_alias_puis_l_identifiant() {
        let e = EntreesSalon { nom: String::new(), alias: Some("#general:hs".into()), ..base() };
        assert_eq!(classer(&e, 0).name, "#general:hs");
        let e = EntreesSalon { nom: String::new(), ..base() };
        assert_eq!(classer(&e, 0).name, "!salon:hs");
    }

    #[test]
    fn serialisation_conforme_au_type_channel() {
        let v = serde_json::to_value(classer(&base(), 0)).unwrap();
        for cle in ["id", "name", "hasVoice", "voiceUsers", "createdAt", "lastActivity", "isDM", "isSoundboard"] {
            assert!(v.get(cle).is_some(), "clé {cle} absente : {v}");
        }
    }

    #[test]
    fn mxc_converti_comme_le_moteur_js() {
        assert_eq!(
            mxc_vers_http("https://sionchat.fr/", "mxc://sionchat.fr/abc").as_deref(),
            Some("https://sionchat.fr/_matrix/media/v3/download/sionchat.fr/abc")
        );
        assert_eq!(mxc_vers_http("https://hs", "https://pas-un-mxc"), None);
    }
}
