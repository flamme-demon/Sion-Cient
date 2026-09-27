//! Fils de messages : un abonnement au cache d'événements de matrix-sdk par
//! salon, traduit en `ChatMessage` par le port pur (`messages.rs`).
//!
//! Le cache d'événements garde le fil en SQLite d'un lancement à l'autre et
//! re-déchiffre lui-même (« R2D2 ») un message dont la clé arrive en retard —
//! par to-device ou par la sauvegarde : sa mise à jour déclenche ici une
//! nouvelle publication. Les messages de TOUS les salons sont publiés,
//! comme le moteur JS : l'interface en tire les badges de non-lus.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use matrix_sdk::deserialized_responses::{TimelineEvent, TimelineEventKind};
use matrix_sdk::event_cache::RoomEventCacheUpdate;
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::events::receipt::ReceiptThread;
use matrix_sdk::{Room, RoomMemberships};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::epingles::{self, ResumeEpingle};
use crate::medias::Medias;
use crate::membres;
use crate::messages::{self, Contexte, EvenementBrut, Message};
use crate::salons::mxc_vers_http;
use crate::{Erreur, Resultat};

/// Au-delà, on ne pagine plus (`MAX_HISTORY_PER_ROOM` du moteur JS).
pub(crate) const MAX_HISTORIQUE: usize = 300;
/// Chaque remontée ajoute ~30 messages affichables (`MESSAGES_PER_CALL`)…
const MESSAGES_PAR_CRAN: usize = 30;
/// …par pages courtes de 30 événements…
const TAILLE_PAGE: u16 = 30;
/// …et au plus 50 pages : un salon vocal peut empiler des milliers
/// d'événements de signalisation entre deux messages (`MAX_ITERATIONS`).
const PAGES_MAX: usize = 50;

/// Les messages d'un salon, tels que publiés à l'interface.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilSalon {
    pub salon: String,
    pub messages: Vec<Message>,
    /// Reste-t-il de l'historique à charger (`roomHasMore`) ?
    pub a_plus: bool,
    /// Identifiants des messages épinglés (`getPinnedEventIds`). Un
    /// changement d'épinglage arrive par le fil, qui est alors republié.
    pub epingles: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct Fils {
    pub medias: Arc<Medias>,
    instantane: Arc<Mutex<HashMap<String, FilSalon>>>,
    diffusion: broadcast::Sender<FilSalon>,
}

/// Un événement du cache, en entrée du port pur. Un échec de déchiffrement
/// devient un `m.room.message` en échec, comme le présente matrix-js-sdk.
fn brut(ev: &TimelineEvent) -> Option<EvenementBrut> {
    let json: Value = serde_json::from_str(ev.raw().json().get()).ok()?;
    Some(depuis_json(&json, matches!(ev.kind, TimelineEventKind::UnableToDecrypt { .. })))
}

/// L'édition groupée par le serveur (`unsigned.m.relations.m.replace`) est
/// lue comme un événement à part ; matrix-sdk l'a déjà déchiffrée s'il le
/// pouvait.
fn depuis_json(json: &Value, echec: bool) -> EvenementBrut {
    let chaine = |cle: &str| json.get(cle).and_then(Value::as_str).unwrap_or("").to_owned();
    EvenementBrut {
        type_: if echec { "m.room.message".into() } else { chaine("type") },
        contenu: if echec { Value::Object(Default::default()) } else { json.get("content").cloned().unwrap_or(Value::Null) },
        id: chaine("event_id"),
        expediteur: chaine("sender"),
        ts: json.get("origin_server_ts").and_then(Value::as_i64).unwrap_or(0),
        echec_dechiffrement: echec,
        edition_groupee: json
            .pointer("/unsigned/m.relations/m.replace")
            .filter(|e| e.get("content").is_some())
            .map(|e| Box::new(depuis_json(e, false))),
    }
}

impl Fils {
    pub fn nouveau(medias: Arc<Medias>) -> Self {
        let (diffusion, _) = broadcast::channel(256);
        Self { medias, instantane: Arc::default(), diffusion }
    }

    pub fn abonner(&self) -> broadcast::Receiver<FilSalon> {
        self.diffusion.subscribe()
    }

    pub fn tous(&self) -> Vec<FilSalon> {
        let mut fils: Vec<_> = self.instantane.lock().unwrap().values().cloned().collect();
        fils.sort_by(|a, b| a.salon.cmp(&b.salon));
        fils
    }

    pub fn oublier(&self, salon: &str) {
        self.instantane.lock().unwrap().remove(salon);
    }

    pub fn vider(&self) {
        self.instantane.lock().unwrap().clear();
    }

    fn nombre_de_messages(&self, salon: &str) -> usize {
        self.instantane.lock().unwrap().get(salon).map_or(0, |f| f.messages.len())
    }

    async fn construire(&self, salon: &Room, evenements: &[TimelineEvent]) -> Vec<Message> {
        let membres = profils(salon).await;
        let bruts: Vec<EvenementBrut> = evenements.iter().filter_map(brut).collect();
        let profil = |id: &str| membres.get(id).cloned().unwrap_or((None, None));
        let url = |source: &messages::SourceMedia, vignette: bool| self.medias.url(source, vignette);
        messages::extraire(&bruts, &Contexte { profil: &profil, url: &url })
    }

    /// Reconstruit et publie les messages d'un salon, s'ils ont changé.
    async fn publier(&self, salon: &Room, evenements: &[TimelineEvent], a_plus: Option<bool>) {
        let messages = self.construire(salon, evenements).await;
        let id = salon.room_id().to_string();
        let fil = {
            let mut instantane = self.instantane.lock().unwrap();
            let precedent = instantane.get(&id);
            let fil = FilSalon {
                salon: id.clone(),
                messages,
                a_plus: a_plus.or(precedent.map(|f| f.a_plus)).unwrap_or(true),
                epingles: salon.pinned_event_ids().unwrap_or_default().iter().map(|e| e.to_string()).collect(),
            };
            if precedent == Some(&fil) {
                return;
            }
            instantane.insert(id, fil.clone());
            fil
        };
        let _ = self.diffusion.send(fil);
    }

    /// Suit un salon jusqu'à ce que la tâche soit arrêtée.
    pub async fn suivre(self, salon: Room) {
        let (cache, _poignees) = match salon.event_cache().await {
            Ok(c) => c,
            Err(e) => {
                log::error!("[Sion][matrix] fil de {} indisponible : {e}", salon.room_id());
                return;
            }
        };
        let (evenements, mut abonnement) = match cache.subscribe().await {
            Ok(a) => a,
            Err(e) => {
                log::error!("[Sion][matrix] abonnement au fil de {} impossible : {e}", salon.room_id());
                return;
            }
        };
        self.publier(&salon, &evenements, None).await;
        loop {
            let reconstruire = match abonnement.recv().await {
                Ok(RoomEventCacheUpdate::UpdateTimelineEvents(_)) | Ok(RoomEventCacheUpdate::UpdateMembers { .. }) => true,
                Ok(_) => false,
                // En retard sur les mises à jour : on relit simplement tout.
                Err(RecvError::Lagged(_)) => true,
                Err(RecvError::Closed) => break,
            };
            if reconstruire {
                if let Ok(evenements) = cache.events().await {
                    self.publier(&salon, &evenements, None).await;
                }
            }
        }
    }

    /// Remonte l'historique comme `loadRoomHistory` : ~30 messages
    /// affichables de plus, par pages de 30 événements, au plus 50 pages,
    /// jusqu'à 300 messages chargés. Envoie aussi l'accusé de lecture, comme
    /// le JS à l'ouverture d'un salon. Renvoie « il en reste ».
    pub async fn charger_historique(&self, salon: &Room) -> Resultat<bool> {
        marquer_lu(salon).await;
        let id = salon.room_id().to_string();
        if self.nombre_de_messages(&id) >= MAX_HISTORIQUE {
            if let Ok((cache, _)) = salon.event_cache().await {
                if let Ok(evenements) = cache.events().await {
                    self.publier(salon, &evenements, Some(false)).await;
                }
            }
            return Ok(false);
        }
        let (cache, _poignees) = salon.event_cache().await.map_err(|e| Erreur::Autre(e.to_string()))?;
        let cible = self.nombre_de_messages(&id) + MESSAGES_PAR_CRAN;
        let mut reste = true;
        for _ in 0..PAGES_MAX {
            let issue = cache
                .pagination()
                .run_backwards_once(TAILLE_PAGE)
                .await
                .map_err(|e| Erreur::Autre(e.to_string()))?;
            let evenements = cache.events().await.map_err(|e| Erreur::Autre(e.to_string()))?;
            reste = !issue.reached_start;
            self.publier(salon, &evenements, Some(reste)).await;
            if !reste || self.nombre_de_messages(&id) >= cible {
                break;
            }
        }
        Ok(reste)
    }
}

/// Nom affiché et avatar (URL http, comme le JS) de chaque membre.
async fn profils(salon: &Room) -> HashMap<String, (Option<String>, Option<String>)> {
    let base = salon.client().homeserver().to_string();
    let tous = salon.members_no_sync(RoomMemberships::all()).await.unwrap_or_default();
    let mut noms = membres::noms_du_salon(&tous);
    tous.iter()
        .map(|m| {
            let avatar = m.avatar_url().and_then(|u| mxc_vers_http(&base, u.as_str()));
            let id = m.user_id().to_string();
            let nom = noms.remove(&id);
            (id, (nom, avatar))
        })
        .collect()
}

impl Fils {
    /// Résumés des épinglés, du plus récent au plus ancien. Un épinglé hors
    /// du fil chargé est lu dans le cache ou demandé au serveur ; illisible
    /// ou supprimé, il est omis sans faire échouer la liste.
    pub async fn epingles(&self, salon: &Room) -> Vec<ResumeEpingle> {
        let ids = salon.pinned_event_ids().unwrap_or_default();
        if ids.is_empty() {
            return Vec::new();
        }
        let charges: Vec<EvenementBrut> = match salon.event_cache().await {
            Ok((cache, _)) => cache.events().await.unwrap_or_default().iter().filter_map(brut).collect(),
            Err(_) => Vec::new(),
        };
        let membres = profils(salon).await;
        let nom = |id: &str| membres.get(id).and_then(|(n, _)| n.clone());
        let url = |s: &messages::SourceMedia| self.medias.url(s, false);
        let mut resumes = Vec::new();
        for id in ids {
            if let Some(ev) = charges.iter().find(|e| e.id == id.as_str()) {
                let contenu = messages::contenu_affiche(&charges, ev);
                resumes.push(epingles::resumer(ev, &contenu, nom(&ev.expediteur), true, &url));
                continue;
            }
            match salon.load_or_fetch_event(&id, None).await {
                Ok(t) => {
                    if let Some(ev) = brut(&t) {
                        resumes.push(epingles::resumer(&ev, &ev.contenu, nom(&ev.expediteur), false, &url));
                    }
                }
                Err(e) => log::debug!("[Sion][matrix] épinglé {id} illisible : {e}"),
            }
        }
        resumes.sort_by_key(|r| std::cmp::Reverse(r.ts));
        resumes
    }
}

/// Accusé de lecture sur le dernier événement du fil (`markRoomAsRead`).
pub(crate) async fn marquer_lu(salon: &Room) {
    let Ok((cache, _)) = salon.event_cache().await else { return };
    let Ok(evenements) = cache.events().await else { return };
    let Some(dernier) = evenements.iter().rev().find_map(|e| e.event_id().map(|id| id.to_owned())) else { return };
    if let Err(e) = salon.send_single_receipt(ReceiptType::Read, ReceiptThread::Unthreaded, dernier).await {
        log::warn!("[Sion][matrix] accusé de lecture non envoyé ({}) : {e}", salon.room_id());
    }
}
