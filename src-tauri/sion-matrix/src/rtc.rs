//! MatrixRTC, le protocole de la voix : port de `matrix-js-sdk/src/matrixrtc`
//! (Apache-2.0), limité à ce que Sion emploie.
//!
//! - **Appartenance** : état `org.matrix.msc3401.call.member` du salon, à la
//!   clé `_@moi:serveur_APPAREIL_m.call` (ancien format de MSC4143 : le
//!   serveur n'a ni événements « collants » ni événements différés). Même
//!   contenu que `MembershipManager.makeMyMembership` plus les champs de Sion
//!   (`sion_muted`, `sion_deafened`, voir `buildCallMemberContent`).
//! - **Identité LiveKit** d'un participant : `@utilisateur:serveur:APPAREIL`.
//! - **Clés des médias** : to-device chiffré `io.element.call.encryption_keys`,
//!   gérées comme `RTCEncryptionManager` — clé partagée aux arrivants,
//!   renouvelée au départ d'un participant, utilisée une seconde après sa
//!   distribution.
//!
//! Pur : ni réseau ni horloge ; `voix.rs` fait les entrées-sorties.
use std::collections::{BTreeMap, HashMap};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::appels::EvenementAppel;

pub(crate) const TYPE_CLES: &str = "io.element.call.encryption_keys";
/// Validité annoncée d'une appartenance (`membershipEventExpiryMs` de Sion).
pub(crate) const EXPIRATION_MS: i64 = 3_600_000;
/// Validité supposée quand `expires` manque (`DEFAULT_EXPIRE_DURATION`).
const EXPIRATION_PAR_DEFAUT_MS: i64 = 4 * 3_600_000;
/// Renouvellement un peu avant l'échéance (`membershipEventExpiryHeadroomMs`).
pub(crate) const MARGE_RENOUVELLEMENT_MS: i64 = 5_000;
/// Délai avant de chiffrer avec une clé renouvelée, le temps qu'elle arrive
/// chez les autres (`useKeyDelay`).
pub(crate) const DELAI_CLE_MS: u64 = 1_000;
/// Une clé plus jeune est simplement partagée aux arrivants, sans rotation
/// (`keyRotationGracePeriodMs`).
const GRACE_ROTATION_MS: i64 = 10_000;
/// Clés gardées par participant : l'émetteur peut chiffrer avec un index en
/// retard (même borne que le `MatrixKeyProvider` du moteur JS).
const TAILLE_ANNEAU: usize = 16;

/// Clé d'état de notre appartenance (`makeMembershipStateKey`).
pub(crate) fn cle_etat(utilisateur: &str, appareil: &str, version_salon: &str) -> String {
    let cle = format!("{utilisateur}_{appareil}_m.call");
    if version_salon.starts_with("org.matrix.msc3757") || version_salon.starts_with("org.matrix.msc3779") {
        cle
    } else {
        format!("_{cle}")
    }
}

/// Identité d'un participant sur le serveur média (`rtcBackendIdentity`).
pub(crate) fn identite(utilisateur: &str, appareil: &str) -> String {
    format!("{utilisateur}:{appareil}")
}

/// Le service LiveKit d'un salon et le nom de la salle sur ce service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Foyer {
    pub service: String,
    pub alias: String,
}

/// Notre appartenance, telle qu'écrite dans l'état du salon.
pub(crate) struct Annonce<'a> {
    pub moi: &'a str,
    pub appareil: &'a str,
    pub foyer: &'a Foyer,
    /// Échéance relative à `created_ts` (ms).
    pub expires: i64,
    /// Date de la jonction, pour une mise à jour (absente à la jonction).
    pub cree: Option<i64>,
    pub muet: bool,
    pub sourd: bool,
}

/// Système de cet appareil (`sion_platform`) : la liste des participants
/// distingue téléphone et ordinateur, par exemple quand on est en appel des
/// deux (29/09). L'interface JS publie la même valeur (`plateformeLocale`).
pub(crate) const PLATEFORME: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "ios") {
    "ios"
} else if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

pub(crate) fn contenu_appartenance(a: &Annonce) -> Value {
    let mut contenu = json!({
        "application": "m.call",
        "call_id": "",
        "scope": "m.room",
        "device_id": a.appareil,
        "membershipID": identite(a.moi, a.appareil),
        "expires": a.expires,
        "m.call.intent": "audio",
        "focus_active": { "type": "livekit", "focus_selection": "oldest_membership" },
        "foci_preferred": [
            { "livekit_alias": a.foyer.alias, "livekit_service_url": a.foyer.service, "type": "livekit" }
        ],
        "sion_muted": a.muet,
        "sion_deafened": a.sourd,
        "sion_platform": PLATEFORME,
    });
    if let Some(ts) = a.cree {
        contenu["created_ts"] = json!(ts);
    }
    contenu
}

/// Un participant de l'appel, d'après son appartenance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Appartenance {
    pub utilisateur: String,
    pub appareil: String,
    /// `created_ts`, sinon la date de l'événement.
    pub cree: i64,
    pub identite: String,
}

fn chaine(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// Contenu d'appartenance valable au sens de `checkSessionsMembershipData`,
/// pour l'appel du salon (`m.call`, `call_id` vide).
fn appartenance_valable(c: &serde_json::Map<String, Value>) -> bool {
    let cles = c.keys().filter(|k| *k != "msc4354_sticky_key").count();
    if cles <= 1 || !c.contains_key("application") {
        return false;
    }
    let foci_valables = match c.get("foci_preferred") {
        None => true,
        Some(Value::Array(foci)) => foci.iter().all(|f| f.get("type").is_some_and(Value::is_string)),
        Some(_) => false,
    };
    chaine(c.get("application")) == Some("m.call")
        && chaine(c.get("call_id")) == Some("")
        && c.get("device_id").is_some_and(Value::is_string)
        && c.get("focus_active").and_then(|f| f.get("type")).is_some_and(Value::is_string)
        && foci_valables
        && c.get("created_ts").is_none_or(Value::is_number)
}

/// Participants de l'appel du salon, du plus ancien au plus récent
/// (`sessionMembershipsForSlot`) : appartenance valable, non expirée, d'un
/// membre présent dans le salon.
pub(crate) fn appartenances(evenements: &[EvenementAppel], present: impl Fn(&str) -> bool, maintenant: i64) -> Vec<Appartenance> {
    let mut liste: Vec<Appartenance> = evenements
        .iter()
        .filter_map(|ev| {
            let c = ev.contenu.as_object()?;
            if ev.expediteur.is_empty() || !appartenance_valable(c) || !present(&ev.expediteur) {
                return None;
            }
            let cree = c.get("created_ts").and_then(Value::as_i64).unwrap_or(ev.ts);
            let duree = c.get("expires").and_then(Value::as_i64).unwrap_or(EXPIRATION_PAR_DEFAUT_MS);
            if cree + duree <= maintenant {
                return None;
            }
            let appareil = chaine(c.get("device_id"))?.to_owned();
            Some(Appartenance {
                identite: identite(&ev.expediteur, &appareil),
                utilisateur: ev.expediteur.clone(),
                appareil,
                cree,
            })
        })
        .collect();
    liste.sort_by_key(|a| a.cree);
    liste
}

/// Service LiveKit annoncé dans un contenu d'appartenance
/// (`extractFocus` de `livekitTokenService.ts`) : `service`, `alias`.
pub(crate) fn foyer_annonce(contenu: &Value) -> Option<(String, Option<String>)> {
    let livekit = |f: &Value| {
        let service = chaine(f.get("livekit_service_url")).filter(|s| !s.is_empty())?;
        (chaine(f.get("type")) == Some("livekit"))
            .then(|| (service.to_owned(), chaine(f.get("livekit_alias")).map(str::to_owned)))
    };
    if let Some(Value::Array(adhesions)) = contenu.get("memberships") {
        for a in adhesions {
            if let Some(Value::Array(foci)) = a.get("foci_active") {
                if let Some(f) = foci.iter().find_map(livekit) {
                    return Some(f);
                }
            }
        }
    }
    match contenu.get("foci_preferred") {
        Some(Value::Array(foci)) => foci.iter().find_map(livekit),
        _ => None,
    }
}

/// `livekit:https://…` ou `https://…` → `https://…`.
pub(crate) fn service_nu(service: &str) -> &str {
    service.strip_prefix("livekit:").unwrap_or(service)
}

/// Adresse WebSocket publique du serveur média, déduite du service (et non
/// l'`url` renvoyée avec le jeton, parfois interne : `ws://127.0.0.1:7880`).
pub(crate) fn adresse_media(service: &str) -> String {
    let s = service_nu(service);
    if let Some(reste) = s.strip_prefix("https://") {
        format!("wss://{reste}")
    } else if let Some(reste) = s.strip_prefix("http://") {
        format!("ws://{reste}")
    } else {
        s.to_owned()
    }
}

/// Contenu d'un envoi de clé (`ToDeviceKeyTransport.sendKey`).
pub(crate) fn contenu_cle(salon: &str, moi: &str, appareil: &str, index: u8, cle: &[u8], envoye: i64) -> Value {
    json!({
        "keys": { "index": index, "key": base64::engine::general_purpose::STANDARD.encode(cle) },
        "room_id": salon,
        "member": { "claimed_device_id": appareil, "id": identite(moi, appareil) },
        "session": { "call_id": "", "application": "m.call", "scope": "m.room" },
        "sent_ts": envoye,
    })
}

/// Clé reçue d'un autre appareil.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CleRecue {
    pub utilisateur: String,
    pub appareil: String,
    pub index: u8,
    pub cle: Vec<u8>,
}

/// Lit un envoi de clé (`getValidEventContent`) ; `None` s'il est mal formé
/// ou d'un autre salon.
pub(crate) fn lire_cle(expediteur: &str, contenu: &Value, salon: &str) -> Option<CleRecue> {
    if expediteur.is_empty() || chaine(contenu.get("room_id")) != Some(salon) {
        return None;
    }
    let cles = contenu.get("keys")?;
    let texte = chaine(cles.get("key")).filter(|k| !k.is_empty())?;
    let index = cles.get("index").and_then(Value::as_u64)?;
    let appareil = chaine(contenu.pointer("/member/claimed_device_id")).filter(|d| !d.is_empty())?;
    let moteur = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    Some(CleRecue {
        utilisateur: expediteur.to_owned(),
        appareil: appareil.to_owned(),
        index: u8::try_from(index % 256).ok()?,
        cle: moteur.decode(texte).ok()?,
    })
}

/// Une clé à remettre au moteur média : `identite` chiffre (ou déchiffre)
/// avec `cle` sous `index`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleMedia {
    pub identite: String,
    pub index: u8,
    pub cle: Vec<u8>,
}

/// Un appareil avec lequel la clé courante a été partagée.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Destinataire {
    pub utilisateur: String,
    pub appareil: String,
    pub cree: i64,
}

impl Destinataire {
    fn meme_appareil(&self, autre: &Destinataire) -> bool {
        self.utilisateur == autre.utilisateur && self.appareil == autre.appareil
    }
}

/// Un envoi de notre clé à faire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Distribution {
    pub index: u8,
    pub cle: Vec<u8>,
    pub cibles: Vec<Destinataire>,
    /// Clé neuve : à n'utiliser qu'après `DELAI_CLE_MS`.
    pub nouvelle: bool,
}

struct Sortante {
    index: u8,
    cle: Vec<u8>,
    cree: i64,
    partagee: Vec<Destinataire>,
}

/// Les clés d'un appel : la nôtre, sa rotation, et celles des autres
/// (`RTCEncryptionManager`).
pub(crate) struct GestionCles {
    moi: String,
    appareil: String,
    sortante: Option<Sortante>,
    anneaux: BTreeMap<String, Vec<(u8, Vec<u8>)>>,
    /// Clés arrivées avant l'appartenance de leur émetteur.
    en_attente: Vec<CleRecue>,
    /// Réception la plus récente par appareil et par index (`OutdatedKeyFilter`).
    receptions: HashMap<(String, String), HashMap<u8, i64>>,
}

impl GestionCles {
    pub fn nouveau(moi: &str, appareil: &str) -> Self {
        Self {
            moi: moi.to_owned(),
            appareil: appareil.to_owned(),
            sortante: None,
            anneaux: BTreeMap::new(),
            en_attente: Vec::new(),
            receptions: HashMap::new(),
        }
    }

    pub fn identite_propre(&self) -> String {
        identite(&self.moi, &self.appareil)
    }

    /// Anneau d'un participant, dans l'ordre d'arrivée : la dernière clé est
    /// la plus récente, même quand l'index a bouclé (255 → 0).
    fn noter(&mut self, m: &CleMedia) {
        let anneau = self.anneaux.entry(m.identite.clone()).or_default();
        anneau.retain(|(i, _)| *i != m.index);
        anneau.push((m.index, m.cle.clone()));
        if anneau.len() > TAILLE_ANNEAU {
            anneau.remove(0);
        }
    }

    /// Notre clé, à remettre au moteur média (aussitôt pour la première,
    /// après `DELAI_CLE_MS` pour une clé renouvelée).
    pub fn utiliser(&mut self, index: u8, cle: &[u8]) -> CleMedia {
        let m = CleMedia { identite: self.identite_propre(), index, cle: cle.to_vec() };
        self.noter(&m);
        m
    }

    /// Ce que les participants actuels demandent (`rolloutOutboundKey`) : la
    /// première clé si l'on n'en a pas (à utiliser aussitôt), puis l'envoi à
    /// faire — la clé courante aux seuls arrivants si elle est récente, une
    /// clé neuve à tous si quelqu'un est parti ou si elle a vieilli.
    pub fn planifier(
        &mut self,
        membres: &[Appartenance],
        maintenant: i64,
        aleatoire: &mut dyn FnMut() -> [u8; 16],
    ) -> (Option<CleMedia>, Option<Distribution>) {
        let premiere = if self.sortante.is_none() {
            let cle = aleatoire().to_vec();
            self.sortante = Some(Sortante { index: 0, cle: cle.clone(), cree: maintenant, partagee: Vec::new() });
            Some(self.utiliser(0, &cle))
        } else {
            None
        };
        let a_partager: Vec<Destinataire> = membres
            .iter()
            .filter(|m| !(m.utilisateur == self.moi && m.appareil == self.appareil))
            .map(|m| Destinataire { utilisateur: m.utilisateur.clone(), appareil: m.appareil.clone(), cree: m.cree })
            .collect();
        let sortante = self.sortante.as_mut().expect("clé sortante créée ci-dessus");
        // Un participant revenu (autre date de jonction) a perdu notre clé.
        sortante.partagee.retain(|x| !a_partager.iter().any(|o| x.meme_appareil(o) && x.cree != o.cree));
        let partis = sortante.partagee.iter().any(|x| !a_partager.contains(x));
        let arrivants: Vec<Destinataire> = a_partager.iter().filter(|x| !sortante.partagee.contains(x)).cloned().collect();
        let rotation = if partis {
            true
        } else if !arrivants.is_empty() {
            maintenant - sortante.cree >= GRACE_ROTATION_MS
        } else {
            return (premiere, None);
        };
        if rotation {
            let index = sortante.index.wrapping_add(1);
            *sortante = Sortante { index, cle: aleatoire().to_vec(), cree: maintenant, partagee: Vec::new() };
        }
        // Tout le monde parti : `cibles` vide, mais la clé neuve doit tout de
        // même devenir la nôtre — elle sera partagée telle quelle au prochain
        // arrivant dans la période de grâce.
        let cibles = if rotation { a_partager } else { arrivants };
        let d = Distribution { index: sortante.index, cle: sortante.cle.clone(), cibles, nouvelle: rotation };
        (premiere, Some(d))
    }

    /// L'envoi a réussi : ses destinataires ont la clé.
    pub fn distribuee(&mut self, d: &Distribution) {
        if let Some(s) = self.sortante.as_mut().filter(|s| s.index == d.index && s.cle == d.cle) {
            s.partagee.extend(d.cibles.iter().cloned());
        }
    }

    /// Oublie à qui la clé a été partagée : le prochain `planifier` la
    /// renouvelle pour tous (republication manuelle, « on ne m'entend pas »).
    pub fn tout_repartager(&mut self) {
        if let Some(s) = self.sortante.as_mut() {
            s.partagee.clear();
            s.cree = i64::MIN / 2;
        }
    }

    fn attribuer(&mut self, cle: CleRecue, membres: &[Appartenance]) -> Option<CleMedia> {
        let Some(m) = membres.iter().find(|m| m.utilisateur == cle.utilisateur && m.appareil == cle.appareil) else {
            self.en_attente.push(cle);
            return None;
        };
        let media = CleMedia { identite: m.identite.clone(), index: cle.index, cle: cle.cle };
        self.noter(&media);
        Some(media)
    }

    /// Clé reçue d'un participant (`onNewKeyReceived`) ; `None` si elle est
    /// périmée, ou mise en attente de l'appartenance de son émetteur.
    pub fn recevoir(&mut self, cle: CleRecue, recue_a: i64, membres: &[Appartenance]) -> Option<CleMedia> {
        let par_index = self.receptions.entry((cle.utilisateur.clone(), cle.appareil.clone())).or_default();
        if par_index.get(&cle.index).is_some_and(|&ts| ts > recue_a) {
            return None;
        }
        par_index.insert(cle.index, recue_a);
        self.attribuer(cle, membres)
    }

    /// Les participants ont changé : les clés en attente de leur émetteur
    /// trouvent preneur (`checkKeysWithoutMatchingRTCMembership`).
    pub fn liberer(&mut self, membres: &[Appartenance]) -> Vec<CleMedia> {
        std::mem::take(&mut self.en_attente).into_iter().filter_map(|c| self.attribuer(c, membres)).collect()
    }

    /// Les clés à remettre à un moteur média qui (re)démarre, ou à chaque
    /// changement de participants (`reemitEncryptionKeys`) : celles des
    /// autres dans leur ordre d'arrivée, et de la nôtre SEULEMENT celle en
    /// usage. Le moteur chiffre avec la dernière clé qu'il reçoit pour nous :
    /// rejouer les anciennes le ferait chiffrer un instant avec une clé que
    /// les arrivants n'ont jamais eue (constaté le 27/09 : bascule 0 → 1 à
    /// chaque arrivée), et l'ordre des index se trompe quand ils bouclent.
    pub fn toutes(&self) -> Vec<CleMedia> {
        let propre = self.identite_propre();
        let mut liste = Vec::new();
        for (identite, anneau) in &self.anneaux {
            let cles = if *identite == propre { &anneau[anneau.len().saturating_sub(1)..] } else { &anneau[..] };
            liste.extend(cles.iter().map(|(index, cle)| CleMedia { identite: identite.clone(), index: *index, cle: cle.clone() }));
        }
        liste
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_790_000_000_000;

    fn ev(expediteur: &str, contenu: Value, ts: i64) -> EvenementAppel {
        EvenementAppel { expediteur: expediteur.into(), cle_etat: String::new(), contenu, ts }
    }

    fn foyer() -> Foyer {
        Foyer { service: "https://livekit.exemple".into(), alias: "!salon:hs".into() }
    }

    fn annonce(moi: &str, appareil: &str, cree: Option<i64>) -> Value {
        contenu_appartenance(&Annonce { moi, appareil, foyer: &foyer(), expires: EXPIRATION_MS, cree, muet: false, sourd: false })
    }

    fn membre(u: &str, d: &str, cree: i64) -> Appartenance {
        Appartenance { utilisateur: u.into(), appareil: d.into(), cree, identite: identite(u, d) }
    }

    #[test]
    fn cle_d_etat_comme_le_sdk() {
        assert_eq!(cle_etat("@a:hs", "DEV", "11"), "_@a:hs_DEV_m.call");
        assert_eq!(cle_etat("@a:hs", "DEV", "org.matrix.msc3757.10"), "@a:hs_DEV_m.call");
    }

    #[test]
    fn contenu_comme_make_my_membership_plus_sion() {
        let c = contenu_appartenance(&Annonce {
            moi: "@a:hs",
            appareil: "DEV",
            foyer: &foyer(),
            expires: 2 * EXPIRATION_MS,
            cree: Some(T),
            muet: true,
            sourd: false,
        });
        assert_eq!(
            c,
            json!({
                "application": "m.call", "call_id": "", "scope": "m.room", "device_id": "DEV",
                "membershipID": "@a:hs:DEV", "expires": 7_200_000, "m.call.intent": "audio",
                "focus_active": { "type": "livekit", "focus_selection": "oldest_membership" },
                "foci_preferred": [{ "livekit_alias": "!salon:hs", "livekit_service_url": "https://livekit.exemple", "type": "livekit" }],
                "sion_muted": true, "sion_deafened": false, "sion_platform": PLATEFORME, "created_ts": T,
            })
        );
        // À la jonction, pas de `created_ts` : c'est la date de l'événement.
        assert!(annonce("@a:hs", "DEV", None).get("created_ts").is_none());
    }

    #[test]
    fn appartenances_valables_triees_par_anciennete() {
        let evs = vec![
            ev("@b:hs", annonce("@b:hs", "B", None), T - 1000),
            ev("@a:hs", annonce("@a:hs", "A", Some(T - 5000)), T - 100),
            // Départ : contenu vide.
            ev("@c:hs", json!({}), T),
            // Ancien format (`memberships`) : ignoré, comme le SDK.
            ev("@d:hs", json!({ "memberships": [{ "application": "m.call" }] }), T),
            // Expiré : 1 h après sa jonction.
            ev("@e:hs", annonce("@e:hs", "E", None), T - EXPIRATION_MS - 1),
            // Autre appel que celui du salon.
            ev("@f:hs", { let mut c = annonce("@f:hs", "F", None); c["call_id"] = json!("autre"); c }, T),
            // Plus membre du salon.
            ev("@g:hs", annonce("@g:hs", "G", None), T),
        ];
        let liste = appartenances(&evs, |u| u != "@g:hs", T);
        assert_eq!(liste, vec![membre("@a:hs", "A", T - 5000), membre("@b:hs", "B", T - 1000)]);
        assert_eq!(liste[0].identite, "@a:hs:A");
    }

    #[test]
    fn expiration_par_defaut_de_quatre_heures() {
        let mut c = annonce("@a:hs", "A", None);
        c.as_object_mut().unwrap().remove("expires");
        assert_eq!(appartenances(&[ev("@a:hs", c.clone(), T - 3 * EXPIRATION_MS)], |_| true, T).len(), 1);
        assert!(appartenances(&[ev("@a:hs", c, T - 4 * EXPIRATION_MS)], |_| true, T).is_empty());
    }

    #[test]
    fn foyer_lu_dans_les_deux_formats() {
        assert_eq!(
            foyer_annonce(&annonce("@a:hs", "A", None)),
            Some(("https://livekit.exemple".into(), Some("!salon:hs".into())))
        );
        let ancien = json!({ "memberships": [{ "foci_active": [{ "type": "livekit", "livekit_service_url": "livekit:https://lk" }] }] });
        assert_eq!(foyer_annonce(&ancien), Some(("livekit:https://lk".into(), None)));
        assert_eq!(foyer_annonce(&json!({})), None);
        assert_eq!(service_nu("livekit:https://lk"), "https://lk");
        assert_eq!(adresse_media("https://livekit.sionchat.fr"), "wss://livekit.sionchat.fr");
    }

    #[test]
    fn cle_aller_retour() {
        let c = contenu_cle("!s:hs", "@a:hs", "A", 3, &[7; 16], T);
        assert_eq!(c["member"], json!({ "claimed_device_id": "A", "id": "@a:hs:A" }));
        assert_eq!(c["session"], json!({ "call_id": "", "application": "m.call", "scope": "m.room" }));
        assert_eq!(
            lire_cle("@a:hs", &c, "!s:hs"),
            Some(CleRecue { utilisateur: "@a:hs".into(), appareil: "A".into(), index: 3, cle: vec![7; 16] })
        );
        assert_eq!(lire_cle("@a:hs", &c, "!autre:hs"), None);
        let mut sans_appareil = c.clone();
        sans_appareil["member"] = json!({});
        assert_eq!(lire_cle("@a:hs", &sans_appareil, "!s:hs"), None);
        // Base64 sans remplissage (autres clients) accepté.
        let mut nu = c;
        nu["keys"]["key"] = json!(base64::engine::general_purpose::STANDARD_NO_PAD.encode([7u8; 16]));
        assert_eq!(lire_cle("@a:hs", &nu, "!s:hs").unwrap().cle, vec![7; 16]);
    }

    fn generateur() -> impl FnMut() -> [u8; 16] {
        let mut n = 0u8;
        move || {
            n += 1;
            [n; 16]
        }
    }

    #[test]
    fn premiere_cle_puis_partage_aux_arrivants_puis_rotation_au_depart() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        let mut alea = generateur();
        let moi = membre("@moi:hs", "M", T);
        let b = membre("@b:hs", "B", T + 1);

        // Seul : la première clé, utilisée aussitôt, personne à qui l'envoyer.
        let (premiere, envoi) = g.planifier(std::slice::from_ref(&moi), T, &mut alea);
        assert_eq!(premiere, Some(CleMedia { identite: "@moi:hs:M".into(), index: 0, cle: vec![1; 16] }));
        assert_eq!(envoi, None);

        // Un arrivant, clé récente : la même clé, à lui seul, sans rotation.
        let (premiere, envoi) = g.planifier(&[moi.clone(), b.clone()], T + 2000, &mut alea);
        assert_eq!(premiere, None);
        let envoi = envoi.unwrap();
        assert_eq!((envoi.index, envoi.cle.clone(), envoi.nouvelle), (0, vec![1; 16], false));
        assert_eq!(envoi.cibles, vec![Destinataire { utilisateur: "@b:hs".into(), appareil: "B".into(), cree: T + 1 }]);
        g.distribuee(&envoi);
        assert_eq!(g.planifier(&[moi.clone(), b.clone()], T + 3000, &mut alea).1, None);

        // Un second arrivant après la période de grâce : clé neuve pour tous.
        let c = membre("@c:hs", "C", T + 20_000);
        let envoi = g.planifier(&[moi.clone(), b.clone(), c.clone()], T + 20_000, &mut alea).1.unwrap();
        assert_eq!((envoi.index, envoi.cle.clone(), envoi.nouvelle, envoi.cibles.len()), (1, vec![2; 16], true, 2));
        g.distribuee(&envoi);

        // Départ de B : rotation, envoyée aux restants seulement.
        let envoi = g.planifier(&[moi.clone(), c.clone()], T + 21_000, &mut alea).1.unwrap();
        assert_eq!((envoi.index, envoi.nouvelle), (2, true));
        assert_eq!(envoi.cibles.iter().map(|d| d.utilisateur.as_str()).collect::<Vec<_>>(), vec!["@c:hs"]);
        // Utilisée après le délai : notée comme les autres.
        assert_eq!(g.utiliser(envoi.index, &envoi.cle).identite, "@moi:hs:M");
    }

    #[test]
    fn tous_partis_la_cle_neuve_devient_la_notre() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        let mut alea = generateur();
        let b = membre("@b:hs", "B", T);
        let d = g.planifier(std::slice::from_ref(&b), T, &mut alea).1.unwrap();
        g.distribuee(&d);
        let d = g.planifier(&[], T + 1000, &mut alea).1.unwrap();
        assert!(d.cibles.is_empty() && d.nouvelle && d.index == 1);
        // Un arrivant aussitôt après reçoit CETTE clé, celle qu'on utilise.
        let c = membre("@c:hs", "C", T + 2000);
        let d2 = g.planifier(std::slice::from_ref(&c), T + 2000, &mut alea).1.unwrap();
        assert_eq!((d2.index, d2.cle, d2.nouvelle), (1, d.cle, false));
    }

    #[test]
    fn un_participant_revenu_recoit_une_cle_neuve() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        let mut alea = generateur();
        let b = membre("@b:hs", "B", T);
        let d = g.planifier(std::slice::from_ref(&b), T, &mut alea).1.unwrap();
        g.distribuee(&d);
        // Même appareil, autre date de jonction (déconnexion-reconnexion) :
        // traité en arrivant, clé récente donc renvoyée telle quelle.
        let d = g.planifier(&[membre("@b:hs", "B", T + 500)], T + 600, &mut alea).1.unwrap();
        assert_eq!((d.index, d.nouvelle, d.cibles[0].cree), (0, false, T + 500));
    }

    #[test]
    fn index_de_cle_boucle_a_256() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        let mut alea = || [0u8; 16];
        g.planifier(&[], T, &mut alea);
        g.sortante.as_mut().unwrap().index = 255;
        g.tout_repartager();
        let d = g.planifier(&[membre("@b:hs", "B", T)], T, &mut alea).1.unwrap();
        assert_eq!((d.index, d.nouvelle), (0, true));
    }

    #[test]
    fn cles_recues_attribuees_a_l_identite_du_participant() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        let recue = CleRecue { utilisateur: "@b:hs".into(), appareil: "B".into(), index: 4, cle: vec![9; 16] };
        // Avant son appartenance : mise de côté.
        assert_eq!(g.recevoir(recue.clone(), T, &[]), None);
        let membres = [membre("@b:hs", "B", T)];
        assert_eq!(g.liberer(&membres), vec![CleMedia { identite: "@b:hs:B".into(), index: 4, cle: vec![9; 16] }]);
        assert!(g.liberer(&membres).is_empty());
        // Réception plus ancienne que la dernière pour cet index : ignorée.
        assert_eq!(g.recevoir(recue.clone(), T - 1, &membres), None);
        assert!(g.recevoir(recue, T + 1, &membres).is_some());
    }

    #[test]
    fn anneau_borne_et_rejoue_dans_l_ordre_d_arrivee() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        let membres = [membre("@b:hs", "B", T)];
        for i in (0..20u8).rev() {
            let c = CleRecue { utilisateur: "@b:hs".into(), appareil: "B".into(), index: i, cle: vec![i; 16] };
            g.recevoir(c, T + i64::from(20 - i), &membres);
        }
        let toutes = g.toutes();
        assert_eq!(toutes.len(), TAILLE_ANNEAU);
        // Les plus anciennes reçues (index élevés) ont été évincées ; les
        // autres dans l'ordre où elles sont arrivées.
        assert_eq!(toutes.iter().map(|c| c.index).collect::<Vec<_>>(), (0..16).rev().collect::<Vec<_>>());
        // Une clé renvoyée à l'identique passe en dernier.
        let c = CleRecue { utilisateur: "@b:hs".into(), appareil: "B".into(), index: 9, cle: vec![9; 16] };
        g.recevoir(c, T + 100, &membres);
        assert_eq!(g.toutes().last().map(|c| c.index), Some(9));
    }

    #[test]
    fn de_la_notre_seule_la_cle_en_usage_est_rejouee() {
        let mut g = GestionCles::nouveau("@moi:hs", "M");
        g.utiliser(0, &[1; 16]);
        g.utiliser(1, &[2; 16]);
        assert_eq!(g.toutes(), vec![CleMedia { identite: "@moi:hs:M".into(), index: 1, cle: vec![2; 16] }]);
        // L'index boucle : 0 vient APRÈS 255, c'est lui qui est en usage.
        g.utiliser(255, &[3; 16]);
        g.utiliser(0, &[4; 16]);
        assert_eq!(g.toutes(), vec![CleMedia { identite: "@moi:hs:M".into(), index: 0, cle: vec![4; 16] }]);
    }
}
