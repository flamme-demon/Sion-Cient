//! Participants vocaux lus dans l'état `org.matrix.msc3401.call.member` :
//! visibles dans la barre latérale sans avoir rejoint l'appel.
//!
//! Port fidèle de `extractVoiceUsers` (src/stores/useMatrixStore.ts), tests
//! compris : deux formats (l'ancien avec `memberships[]`, le nouveau par
//! appareil de MSC4143), expiration absolue ou relative, mute / sourdine
//! propres à Sion. Pur : l'heure du SERVEUR est passée par l'appelant — une
//! horloge locale fausse vidait sinon la liste des participants.
use serde::Serialize;
use serde_json::Value;

/// Un événement d'état `call.member` tel que lu dans le salon.
#[derive(Clone, Debug)]
pub(crate) struct EvenementAppel {
    pub expediteur: String,
    pub cle_etat: String,
    pub contenu: Value,
    /// `origin_server_ts` (ms).
    pub ts: i64,
}

/// Miroir de `VoiceChannelUser` (src/types/matrix.ts).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UtilisateurVocal {
    pub id: String,
    pub name: String,
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub speaking: bool,
    pub muted: bool,
    pub deafened: bool,
}

/// Vérité au sens de JavaScript : `null`, `false`, `0`, `""` sont faux.
fn vrai(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn nombre(v: Option<&Value>) -> Option<i64> {
    v.and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))).filter(|&x| x != 0)
}

/// Une adhésion (entrée de `memberships[]`, ou le contenu entier au nouveau
/// format) est-elle encore valable à l'instant `maintenant` ?
fn valable(adhesion: &Value, ts_origine: i64, maintenant: i64) -> bool {
    if let Some(fin) = nombre(adhesion.get("expires_ts")) {
        return fin > maintenant;
    }
    if let (Some(duree), true) = (nombre(adhesion.get("expires")), ts_origine != 0) {
        return ts_origine + duree > maintenant;
    }
    true // aucune expiration connue : présumé actif
}

/// Participant actif (expiration comprise) — pour la liste des participants.
pub(crate) fn est_actif(ev: &EvenementAppel, maintenant: i64) -> bool {
    match ev.contenu.get("memberships") {
        Some(Value::Array(adhesions)) => adhesions.iter().any(|a| valable(a, ev.ts, maintenant)),
        Some(v) if !v.is_null() => false,
        _ => {
            vrai(ev.contenu.get("application"))
                && vrai(ev.contenu.get("device_id"))
                && valable(&ev.contenu, ev.ts, maintenant)
        }
    }
}

/// Contenu d'appel non vide, SANS regarder l'expiration : c'est ce qui fait
/// d'un salon un salon vocal (`hasCallMembers` du moteur JS).
pub(crate) fn a_contenu_appel(ev: &EvenementAppel) -> bool {
    let Some(objet) = ev.contenu.as_object() else { return false };
    if objet.is_empty() {
        return false;
    }
    match objet.get("memberships") {
        Some(Value::Array(adhesions)) => !adhesions.is_empty(),
        Some(v) if !v.is_null() => false,
        _ => vrai(objet.get("application")) && vrai(objet.get("device_id")),
    }
}

/// Identifiant du participant : l'expéditeur, sinon la clé d'état
/// `_@utilisateur:serveur_appareil_m.call`.
fn utilisateur(ev: &EvenementAppel) -> Option<String> {
    if !ev.expediteur.is_empty() {
        return Some(ev.expediteur.clone());
    }
    let reste = ev.cle_etat.strip_prefix('_')?;
    if !reste.starts_with('@') {
        return None;
    }
    Some(reste.split('_').next()?.to_owned())
}

/// Partie locale d'un identifiant (`@alice:hs` → `alice`), dernier repli du nom.
pub(crate) fn partie_locale(id: &str) -> String {
    id.strip_prefix('@')
        .and_then(|r| r.split(':').next())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_owned())
}

/// Participants actifs, dédoublonnés par utilisateur (première occurrence).
/// `profil(id)` donne le nom affiché et l'URL d'avatar, s'ils sont connus.
pub(crate) fn participants(
    evenements: &[EvenementAppel],
    maintenant: i64,
    profil: impl Fn(&str) -> (Option<String>, Option<String>),
) -> Vec<UtilisateurVocal> {
    let mut vus = std::collections::HashSet::new();
    let mut liste = Vec::new();
    for ev in evenements {
        if !est_actif(ev, maintenant) {
            continue;
        }
        let Some(id) = utilisateur(ev) else { continue };
        if !vus.insert(id.clone()) {
            continue;
        }
        let (nom, avatar) = profil(&id);
        liste.push(UtilisateurVocal {
            name: nom.unwrap_or_else(|| partie_locale(&id)),
            avatar_url: avatar,
            role: "user",
            speaking: false,
            // Champs propres à Sion : absents chez un client non-Sion.
            muted: ev.contenu.get("sion_muted") == Some(&Value::Bool(true)),
            deafened: ev.contenu.get("sion_deafened") == Some(&Value::Bool(true)),
            id,
        });
    }
    liste
}

#[cfg(test)]
mod tests {
    //! Les 9 cas de `src/stores/extractVoiceUsers.test.ts`, à l'identique.
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000_000;

    fn ev(expediteur: &str, contenu: Value) -> EvenementAppel {
        EvenementAppel {
            expediteur: expediteur.into(),
            cle_etat: format!("_{expediteur}_dev1_m.call"),
            contenu,
            ts: NOW,
        }
    }

    fn liste(evs: &[EvenementAppel]) -> Vec<UtilisateurVocal> {
        participants(evs, NOW, |_| (None, None))
    }

    #[test]
    fn membre_actif_nouveau_format_sans_expiration() {
        assert_eq!(
            liste(&[ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1" }))]),
            vec![UtilisateurVocal {
                id: "@alice:hs".into(),
                name: "alice".into(),
                role: "user",
                avatar_url: None,
                speaking: false,
                muted: false,
                deafened: false,
            }]
        );
    }

    #[test]
    fn nouveau_format_expire_exclu() {
        let mut e = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1", "expires_ts": NOW - 1000 }));
        e.ts = NOW - 5000;
        assert!(liste(&[e]).is_empty());
    }

    #[test]
    fn nouveau_format_expiration_future_garde() {
        let e = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1", "expires_ts": NOW + 60_000 }));
        assert_eq!(liste(&[e]).len(), 1);
    }

    #[test]
    fn expiration_relative_nouveau_format() {
        let mut expire = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1", "expires": 1000 }));
        expire.ts = NOW - 5000;
        assert!(liste(&[expire]).is_empty());
        let mut actif = ev("@bob:hs", json!({ "application": "m.call", "device_id": "dev1", "expires": 60_000 }));
        actif.ts = NOW - 1000;
        assert_eq!(liste(&[actif]).len(), 1);
    }

    #[test]
    fn ancien_format_une_entree_active_suffit() {
        let e = ev("@alice:hs", json!({ "memberships": [{ "expires_ts": NOW - 1000 }, { "expires_ts": NOW + 60_000 }] }));
        assert_eq!(liste(&[e]).len(), 1);
    }

    #[test]
    fn contenu_vide_depart_absent() {
        assert!(liste(&[ev("@alice:hs", json!({}))]).is_empty());
    }

    #[test]
    fn multi_appareils_dedoublonne() {
        let mut a = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1" }));
        a.cle_etat = "_@alice:hs_dev1_m.call".into();
        let mut b = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev2" }));
        b.cle_etat = "_@alice:hs_dev2_m.call".into();
        assert_eq!(liste(&[a, b]).len(), 1);
    }

    #[test]
    fn mute_et_sourdine_propres_a_sion() {
        let e = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1", "sion_muted": true, "sion_deafened": true }));
        let l = liste(&[e]);
        assert!(l[0].muted && l[0].deafened);
    }

    #[test]
    fn client_non_sion_ni_mute_ni_sourdine() {
        let l = liste(&[ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1" }))]);
        assert!(!l[0].muted && !l[0].deafened);
    }

    // Au-delà du port : cas propres au Rust.

    #[test]
    fn sans_expediteur_on_lit_la_cle_d_etat() {
        let mut e = ev("", json!({ "application": "m.call", "device_id": "dev1" }));
        e.cle_etat = "_@carol:hs_dev9_m.call".into();
        assert_eq!(liste(&[e])[0].id, "@carol:hs");
    }

    #[test]
    fn salon_vocal_meme_si_la_presence_a_expire() {
        let mut e = ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1", "expires_ts": NOW - 1 }));
        e.ts = NOW - 10;
        assert!(a_contenu_appel(&e));
        assert!(!a_contenu_appel(&ev("@alice:hs", json!({}))));
        assert!(!a_contenu_appel(&ev("@alice:hs", json!({ "memberships": [] }))));
    }

    #[test]
    fn le_profil_fournit_nom_et_avatar() {
        let l = participants(
            &[ev("@alice:hs", json!({ "application": "m.call", "device_id": "dev1" }))],
            NOW,
            |_| (Some("Alice".into()), Some("https://hs/a.png".into())),
        );
        assert_eq!((l[0].name.as_str(), l[0].avatar_url.as_deref()), ("Alice", Some("https://hs/a.png")));
    }
}
