//! Boucle de synchronisation et publication de la liste des salons.
//!
//! Synchro CLASSIQUE (`/v3/sync`, état complet) et non glissante : la liste
//! de salons d'Element X (matrix-sdk-ui) ne demande qu'une liste d'états figée
//! dans son code, sans `m.room.type` — le marqueur des salons vocaux de Sion.
//! Un salon vocal dont on aurait changé le sujet y deviendrait un salon texte.
//! Voir docs/plan-matrix-rust-sdk.md, T1.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::deserialized_responses::{ProcessedToDeviceEvent, RawAnySyncOrStrippedState, SyncOrStrippedState};
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::api::client::membership::joined_rooms;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::{uint, OwnedRoomId};
use matrix_sdk::{Client, Room, RoomDisplayName, RoomMemberships};
use serde_json::Value;
use tokio::sync::{broadcast, watch};

use crate::appels::EvenementAppel;
use crate::fil::Fils;
use crate::horloge::Horloge;
use crate::medias::Medias;
use crate::salons::{self, EntreesSalon, Salon};
use crate::session::FICHIER_ACTIVITE;
use crate::voix::EvenementRtc;
use crate::EtatConnexion;

/// Réglages de synchro : 20 événements par salon, comme le
/// `initialSyncLimit: 20` du moteur JS — les deux moteurs voient alors la
/// même fenêtre (et l'outil de parité compare ce qui est comparable).
pub(crate) fn reglages(attente: Duration) -> SyncSettings {
    use matrix_sdk::ruma::api::client::filter::FilterDefinition;
    let mut filtre = FilterDefinition::default();
    filtre.room.timeline.limit = Some(uint!(20));
    SyncSettings::default().timeout(attente).filter(filtre.into())
}

/// Ce que la boucle publie.
#[derive(Clone)]
pub(crate) struct Publication {
    pub salons: watch::Sender<Vec<Salon>>,
    pub etat: watch::Sender<EtatConnexion>,
    pub horloge: Arc<Horloge>,
    pub fils: Fils,
    /// Vers la session vocale : synchros et clés d'appel reçues.
    pub rtc: broadcast::Sender<EvenementRtc>,
}

/// Salons rejoints selon le magasin local, moins les fantômes.
fn rejoints(client: &Client, fantomes: &HashSet<OwnedRoomId>) -> Vec<Room> {
    client.joined_rooms().into_iter().filter(|s| !fantomes.contains(s.room_id())).collect()
}

/// Salons que le magasin croit rejoints mais que le serveur ne compte plus
/// (`/joined_rooms`) : quittés PUIS oubliés depuis un autre appareil pendant
/// que celui-ci était éteint — le serveur ne renvoie jamais un salon oublié
/// dans la synchro, cet appareil ne l'apprenait donc jamais (vu le 27/09 : deux
/// salons de test restés affichés). On tente de le quitter (matrix-sdk le
/// marque alors quitté pour de bon) ; sinon, il est seulement écarté. En cas
/// d'échec de la requête, l'ensemble précédent est gardé.
async fn chercher_fantomes(client: &Client, precedents: HashSet<OwnedRoomId>) -> HashSet<OwnedRoomId> {
    let Ok(reponse) = client.send(joined_rooms::v3::Request::new()).await else { return precedents };
    let serveur: HashSet<OwnedRoomId> = reponse.joined_rooms.into_iter().collect();
    let mut fantomes = HashSet::new();
    for salon in client.joined_rooms() {
        if serveur.contains(salon.room_id()) {
            continue;
        }
        match salon.leave().await {
            Ok(()) => log::info!("[Sion][matrix] salon fantôme {} marqué quitté", salon.room_id()),
            Err(e) => {
                log::info!("[Sion][matrix] salon fantôme {} écarté ({e})", salon.room_id());
                fantomes.insert(salon.room_id().to_owned());
            }
        }
    }
    fantomes
}

/// Un fil suivi par salon rejoint ; un salon quitté cesse d'être suivi. Les
/// tâches vivent dans un `JoinSet` : elles s'arrêtent avec la boucle.
fn suivre_les_salons(
    client: &Client,
    fantomes: &HashSet<OwnedRoomId>,
    fils: &Fils,
    taches: &mut tokio::task::JoinSet<()>,
    suivis: &mut HashMap<OwnedRoomId, tokio::task::AbortHandle>,
) {
    let rejoints_ids: HashSet<OwnedRoomId> = rejoints(client, fantomes).iter().map(|s| s.room_id().to_owned()).collect();
    suivis.retain(|id, tache| {
        let garde = rejoints_ids.contains(id);
        if !garde {
            tache.abort();
            fils.oublier(id.as_str());
        }
        garde
    });
    for salon in rejoints(client, fantomes) {
        if !suivis.contains_key(salon.room_id()) {
            let id = salon.room_id().to_owned();
            suivis.insert(id, taches.spawn(fils.clone().suivre(salon)));
        }
    }
}

// ── Dernière activité par salon, gardée d'un lancement à l'autre ─────────────
//
// La synchro reprend là où elle s'était arrêtée : un salon calme ne renvoie
// aucun événement, et son activité tomberait à 0 à chaque lancement.

struct Activites {
    chemin: PathBuf,
    carte: HashMap<String, i64>,
}

impl Activites {
    fn charger(chemin: PathBuf) -> Self {
        let carte = std::fs::read(&chemin).ok().and_then(|o| serde_json::from_slice(&o).ok()).unwrap_or_default();
        Self { chemin, carte }
    }

    fn noter(&mut self, salon: &str, ts: i64) -> bool {
        let actuel = self.carte.entry(salon.to_owned()).or_insert(0);
        if ts > *actuel {
            *actuel = ts;
            true
        } else {
            false
        }
    }

    fn get(&self, salon: &str) -> i64 {
        self.carte.get(salon).copied().unwrap_or(0)
    }

    fn enregistrer(&self) {
        if let Ok(o) = serde_json::to_vec(&self.carte) {
            let _ = std::fs::write(&self.chemin, o);
        }
    }
}

// ── Lecture d'un salon matrix-sdk ─────────────────────────────────────────────

fn json_etat(brut: &RawAnySyncOrStrippedState) -> Option<Value> {
    let texte = match brut {
        RawAnySyncOrStrippedState::Sync(r) => r.json().get(),
        RawAnySyncOrStrippedState::Stripped(r) => r.json().get(),
    };
    serde_json::from_str(texte).ok()
}

/// Les appartenances à l'appel du salon (`call.member`), par clé d'état.
pub(crate) async fn evenements_appel(salon: &Room) -> matrix_sdk::Result<Vec<EvenementAppel>> {
    let mut liste: Vec<EvenementAppel> = salon
        .get_state_events(StateEventType::CallMember)
        .await?
        .iter()
        .filter_map(json_etat)
        .map(|v| EvenementAppel {
            expediteur: chaine(v.get("sender")),
            cle_etat: chaine(v.get("state_key")),
            ts: v.get("origin_server_ts").and_then(Value::as_i64).unwrap_or(0),
            contenu: v.get("content").cloned().unwrap_or(Value::Null),
        })
        .collect();
    liste.sort_by(|a, b| a.cle_etat.cmp(&b.cle_etat));
    Ok(liste)
}

async fn etat_unique(salon: &Room, type_: StateEventType) -> Option<Value> {
    salon.get_state_event(type_, "").await.ok().flatten().as_ref().and_then(json_etat)
}

fn chaine(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_owned()
}

async fn lire(salon: &Room, moi: &str, medias: &Medias, activite: i64, horloge: &Horloge) -> matrix_sdk::Result<EntreesSalon> {
    let nom = match salon.display_name().await {
        Ok(RoomDisplayName::Empty) | Err(_) => String::new(),
        Ok(n) => n.to_string(),
    };
    let creation = etat_unique(salon, StateEventType::RoomCreate).await;
    let type_personnalise = etat_unique(salon, StateEventType::from("m.room.type")).await;

    let membres_appel = evenements_appel(salon).await?;
    for ev in &membres_appel {
        horloge.noter_horodatage(ev.ts);
    }

    let membres = salon.members_no_sync(RoomMemberships::all()).await?;
    Ok(EntreesSalon {
        id: salon.room_id().to_string(),
        nom,
        sujet: salon.topic(),
        icone: salon.avatar_url().and_then(|m| medias.url_avatar(m.as_str())),
        type_creation: chaine(creation.as_ref().and_then(|v| v.pointer("/content/type"))),
        type_personnalise: chaine(type_personnalise.as_ref().and_then(|v| v.pointer("/content/type"))),
        a_evenement_appel: etat_unique(salon, StateEventType::from("org.matrix.msc3401.call")).await.is_some(),
        membres_appel,
        alias: salon.canonical_alias().map(|a| a.to_string()),
        cree_a: creation.as_ref().and_then(|v| v.get("origin_server_ts")).and_then(Value::as_i64).unwrap_or(0),
        derniere_activite: activite,
        cibles_directes: salon.direct_targets().iter().map(|c| c.to_string()).collect(),
        moi: moi.to_owned(),
        membres_joints: membres
            .iter()
            .filter(|m| *m.membership() == MembershipState::Join)
            .map(|m| m.user_id().to_string())
            .collect(),
        membres_historiques: membres
            .iter()
            .map(|m| (m.user_id().to_string(), matches!(m.membership(), MembershipState::Join | MembershipState::Invite)))
            .collect(),
        profils: membres
            .iter()
            .map(|m| {
                let avatar = m.avatar_url().and_then(|u| medias.url_avatar(u.as_str()));
                (m.user_id().to_string(), (Some(m.name().to_owned()), avatar))
            })
            .collect(),
    })
}

/// La liste des salons rejoints. Un salon illisible est sauté (avec trace)
/// plutôt que de vider toute la barre latérale — comme `safeMapRoomToChannel`.
async fn tous_les_salons(client: &Client, fantomes: &HashSet<OwnedRoomId>, activites: &Activites, horloge: &Horloge, medias: &Medias) -> Vec<Salon> {
    let moi = client.user_id().map(|u| u.to_string()).unwrap_or_default();
    let maintenant = horloge.maintenant_serveur();
    let mut liste = Vec::new();
    for salon in rejoints(client, fantomes) {
        match lire(&salon, &moi, medias, activites.get(salon.room_id().as_str()), horloge).await {
            Ok(entrees) => liste.push(salons::classer(&entrees, maintenant)),
            Err(e) => log::error!("[Sion][matrix] salon ignoré ({}) : {e}", salon.room_id()),
        }
    }
    liste.sort_by(|a, b| a.id.cmp(&b.id));
    liste
}

/// Invitations acceptées d'office, comme le moteur JS. Une invitation en MP
/// met aussi `m.direct` à jour : sans cela, le prochain « écrire à… » créerait
/// un MP en double.
///
/// Une seule tentative par invitation et par session, comme le JS : une
/// invitation vers un salon banni du serveur (403) échoue à coup sûr, et la
/// retenter à chaque synchro martelait le serveur (vu le 26/09).
async fn accepter_invitations(client: &Client, tentees: &mut HashSet<OwnedRoomId>) {
    for salon in client.invited_rooms() {
        if !tentees.insert(salon.room_id().to_owned()) {
            continue;
        }
        // L'état d'un salon où l'on est seulement invité est « dépouillé ».
        let directe = salon
            .invite_details()
            .await
            .ok()
            .and_then(|i| match &**i.invitee.event() {
                SyncOrStrippedState::Stripped(ev) => ev.content.is_direct,
                SyncOrStrippedState::Sync(ev) => ev.as_original().and_then(|o| o.content.is_direct),
            })
            .unwrap_or(false);
        match salon.join().await {
            Ok(()) => {
                log::info!("[Sion][matrix] invitation acceptée : {}", salon.room_id());
                if directe {
                    if let Err(e) = salon.set_is_direct(true).await {
                        log::warn!("[Sion][matrix] m.direct non mis à jour pour {} : {e}", salon.room_id());
                    }
                }
            }
            Err(e) => log::error!("[Sion][matrix] invitation {} non acceptée : {e}", salon.room_id()),
        }
    }
}

/// Dernière activité des salons que la carte ne connaît pas encore (premier
/// lancement du moteur sur une session existante) : un seul événement chacun.
async fn amorcer_activites(client: &Client, activites: &mut Activites) {
    let mut change = false;
    for salon in client.joined_rooms() {
        if activites.get(salon.room_id().as_str()) != 0 {
            continue;
        }
        let mut options = MessagesOptions::backward();
        options.limit = uint!(1);
        if let Ok(lot) = salon.messages(options).await {
            for ev in &lot.chunk {
                if let Ok(Some(ts)) = ev.raw().get_field::<i64>("origin_server_ts") {
                    change |= activites.noter(salon.room_id().as_str(), ts);
                }
            }
        }
    }
    if change {
        activites.enregistrer();
    }
}

async fn publier(client: &Client, fantomes: &HashSet<OwnedRoomId>, activites: &Activites, publication: &Publication) {
    let liste = tous_les_salons(client, fantomes, activites, &publication.horloge, &publication.fils.medias).await;
    publication.salons.send_if_modified(|actuelle| {
        if *actuelle == liste {
            false
        } else {
            *actuelle = liste;
            true
        }
    });
}

fn connecte(client: &Client) -> EtatConnexion {
    EtatConnexion::Connecte {
        utilisateur: client.user_id().map(|u| u.to_string()).unwrap_or_default(),
        appareil: client.device_id().map(|d| d.to_string()).unwrap_or_default(),
    }
}

/// Lance la boucle de synchro. Elle vit jusqu'à `abort()` (déconnexion).
/// Clés d'appel reçues, puis le signal « synchro arrivée », vers la session
/// vocale. Seules les clés DÉCHIFFRÉES comptent : en clair, n'importe qui
/// pourrait en glisser une.
fn transmettre_rtc(to_device: &[ProcessedToDeviceEvent], rtc: &broadcast::Sender<EvenementRtc>) {
    for ev in to_device {
        let brut = ev.as_raw();
        if brut.get_field::<String>("type").ok().flatten().as_deref() != Some(crate::rtc::TYPE_CLES) {
            continue;
        }
        match ev {
            ProcessedToDeviceEvent::Decrypted { raw, encryption_info } => {
                let contenu = raw.get_field::<Value>("content").ok().flatten().unwrap_or(Value::Null);
                let _ = rtc.send(EvenementRtc::Cle {
                    expediteur: encryption_info.sender.to_string(),
                    appareil: encryption_info.sender_device.as_ref().map(|d| d.to_string()),
                    contenu,
                });
            }
            _ => log::warn!("[Sion][voix] clé d'appel non chiffrée ou indéchiffrable, ignorée"),
        }
    }
    let _ = rtc.send(EvenementRtc::Synchro);
}

pub(crate) fn demarrer(client: Client, dossier: PathBuf, publication: Publication) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut activites = Activites::charger(dossier.join(FICHIER_ACTIVITE));
        let base = client.homeserver().to_string();
        publication.horloge.sonder(&base).await;
        let mut invitations_tentees = HashSet::new();
        accepter_invitations(&client, &mut invitations_tentees).await;
        let mut fantomes = chercher_fantomes(&client, HashSet::new()).await;
        crate::voix::liberer_appartenances_orphelines(&client, &rejoints(&client, &fantomes)).await;
        amorcer_activites(&client, &mut activites).await;
        publier(&client, &fantomes, &activites, &publication).await;
        let mut taches = tokio::task::JoinSet::new();
        let mut suivis = HashMap::new();
        suivre_les_salons(&client, &fantomes, &publication.fils, &mut taches, &mut suivis);

        let mut flux = Box::pin(client.sync_stream(reglages(Duration::from_secs(30))).await);
        while let Some(reponse) = flux.next().await {
            match reponse {
                Ok(reponse) => {
                    if !matches!(*publication.etat.borrow(), EtatConnexion::Connecte { .. }) {
                        publication.etat.send_replace(connecte(&client));
                    }
                    let mut change = false;
                    for (salon, maj) in &reponse.rooms.joined {
                        for ev in &maj.timeline.events {
                            if let Ok(Some(ts)) = ev.raw().get_field::<i64>("origin_server_ts") {
                                change |= activites.noter(salon.as_str(), ts);
                            }
                        }
                    }
                    if change {
                        activites.enregistrer();
                    }
                    transmettre_rtc(&reponse.to_device, &publication.rtc);
                    accepter_invitations(&client, &mut invitations_tentees).await;
                    if publication.horloge.perimee() {
                        publication.horloge.sonder(&base).await;
                        // Même cadence (10 min) pour les salons fantômes.
                        fantomes = chercher_fantomes(&client, fantomes).await;
                    }
                    publier(&client, &fantomes, &activites, &publication).await;
                    suivre_les_salons(&client, &fantomes, &publication.fils, &mut taches, &mut suivis);
                }
                Err(e) => {
                    log::warn!("[Sion][matrix] synchro : {e}");
                    publication.etat.send_replace(EtatConnexion::Erreur { message: e.to_string() });
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    })
}
