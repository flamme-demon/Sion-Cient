//! Fils de messages : un abonnement au cache d'événements de matrix-sdk par
//! salon, traduit en `ChatMessage` par le port pur (`messages.rs`).
//!
//! Le cache d'événements garde le fil en SQLite d'un lancement à l'autre et
//! re-déchiffre lui-même (« R2D2 ») un message dont la clé arrive en retard —
//! par to-device ou par la sauvegarde : sa mise à jour déclenche ici une
//! nouvelle publication. Les messages de TOUS les salons sont publiés,
//! comme le moteur JS : l'interface en tire les badges de non-lus.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use matrix_sdk::deserialized_responses::{TimelineEvent, TimelineEventKind};
use matrix_sdk::event_cache::{RoomEventCache, RoomEventCacheUpdate};
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::events::receipt::{ReceiptThread, ReceiptType as TypeAccuse};
use matrix_sdk::ruma::{EventId, OwnedUserId};
use matrix_sdk::{Room, RoomMemberships};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::epingles::{self, ResumeEpingle};
use crate::lectures::{self, Jalon};
use crate::medias::Medias;
use crate::membres;
use crate::messages::{self, Contexte, EvenementBrut, Message};
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

/// Un membre tel que l'interface l'affiche (nom et avatar du salon).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Personne {
    pub id: String,
    pub nom: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

/// « Vu par » d'un salon : pour chaque message affiché, les membres dont la
/// lecture s'arrête là (voir `lectures::placer`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LecturesSalon {
    pub salon: String,
    pub lectures: BTreeMap<String, Vec<Personne>>,
}

/// Qui est en train d'écrire dans un salon (moi et les ignorés exceptés).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Frappe {
    pub salon: String,
    pub personnes: Vec<Personne>,
}

#[derive(Clone)]
pub(crate) struct Fils {
    pub medias: Arc<Medias>,
    instantane: Arc<Mutex<HashMap<String, FilSalon>>>,
    diffusion: broadcast::Sender<FilSalon>,
    lectures: Arc<Mutex<HashMap<String, LecturesSalon>>>,
    diffusion_lectures: broadcast::Sender<LecturesSalon>,
    diffusion_frappes: broadcast::Sender<Frappe>,
}

/// Un événement du cache, en entrée du port pur. Un échec de déchiffrement
/// devient un `m.room.message` en échec, comme le présente matrix-js-sdk.
pub(crate) fn brut(ev: &TimelineEvent) -> Option<EvenementBrut> {
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
        let (diffusion_lectures, _) = broadcast::channel(256);
        let (diffusion_frappes, _) = broadcast::channel(256);
        Self { medias, instantane: Arc::default(), diffusion, lectures: Arc::default(), diffusion_lectures, diffusion_frappes }
    }

    pub fn abonner(&self) -> broadcast::Receiver<FilSalon> {
        self.diffusion.subscribe()
    }

    pub fn abonner_lectures(&self) -> broadcast::Receiver<LecturesSalon> {
        self.diffusion_lectures.subscribe()
    }

    pub fn abonner_frappes(&self) -> broadcast::Receiver<Frappe> {
        self.diffusion_frappes.subscribe()
    }

    pub fn toutes_lectures(&self) -> Vec<LecturesSalon> {
        let mut liste: Vec<_> = self.lectures.lock().unwrap().values().cloned().collect();
        liste.sort_by(|a, b| a.salon.cmp(&b.salon));
        liste
    }

    pub fn tous(&self) -> Vec<FilSalon> {
        let mut fils: Vec<_> = self.instantane.lock().unwrap().values().cloned().collect();
        fils.sort_by(|a, b| a.salon.cmp(&b.salon));
        fils
    }

    pub fn oublier(&self, salon: &str) {
        self.instantane.lock().unwrap().remove(salon);
        self.lectures.lock().unwrap().remove(salon);
    }

    pub fn vider(&self) {
        self.instantane.lock().unwrap().clear();
        self.lectures.lock().unwrap().clear();
    }

    fn nombre_de_messages(&self, salon: &str) -> usize {
        self.instantane.lock().unwrap().get(salon).map_or(0, |f| f.messages.len())
    }

    /// Les messages affichables ; ceux des utilisateurs ignorés sont écartés
    /// (le cache peut encore en contenir, reçus avant qu'on les ignore).
    async fn construire(&self, salon: &Room, evenements: &[TimelineEvent]) -> Vec<Message> {
        let membres = profils(salon, &self.medias).await;
        let ignores = ignores(salon);
        let bruts: Vec<EvenementBrut> = evenements.iter().filter_map(brut).filter(|e| !ignores.contains(&e.expediteur)).collect();
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

    /// Suit un salon jusqu'à ce que la tâche soit arrêtée : son fil, ses
    /// accusés de lecture, qui y écrit, et la liste des ignorés.
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
        let (_garde_frappes, mut frappes) = salon.subscribe_to_typing_notifications();
        let mut liste_ignores = salon.client().subscribe_to_ignore_user_list_changes();
        let mut frappes_ouvertes = true;
        self.publier(&salon, &evenements, None).await;
        self.publier_lectures(&salon, &evenements).await;
        loop {
            enum Quoi {
                Fil,
                Lectures,
                Rien,
                Fin,
            }
            let quoi = tokio::select! {
                maj = abonnement.recv() => match maj {
                    Ok(RoomEventCacheUpdate::UpdateTimelineEvents(_)) | Ok(RoomEventCacheUpdate::UpdateMembers { .. }) => Quoi::Fil,
                    Ok(RoomEventCacheUpdate::AddReadReceiptEvent { .. }) => Quoi::Lectures,
                    Ok(_) => Quoi::Rien,
                    // En retard sur les mises à jour : on relit simplement tout.
                    Err(RecvError::Lagged(_)) => Quoi::Fil,
                    Err(RecvError::Closed) => Quoi::Fin,
                },
                ids = frappes.recv(), if frappes_ouvertes => {
                    match ids {
                        Ok(ids) => self.publier_frappe(&salon, ids).await,
                        Err(RecvError::Closed) => frappes_ouvertes = false,
                        Err(RecvError::Lagged(_)) => {}
                    }
                    Quoi::Rien
                },
                // Un utilisateur ignoré (ou qui ne l'est plus) : ses messages
                // disparaissent (ou reviennent) ; matrix-sdk vide aussi son cache
                // d'événements, qui revient ici vide (voir plus bas).
                Some(_) = liste_ignores.next() => Quoi::Fil,
            };
            match quoi {
                Quoi::Fin => break,
                Quoi::Rien => {}
                Quoi::Lectures => {
                    if let Ok(evenements) = cache.events().await {
                        self.publier_lectures(&salon, &evenements).await;
                    }
                }
                Quoi::Fil => {
                    let Ok(mut evenements) = cache.events().await else { continue };
                    let deja = self.nombre_de_messages(salon.room_id().as_str());
                    if evenements.is_empty() && deja > 0 {
                        // Cache vidé par matrix-sdk (liste des ignorés changée,
                        // ici ou sur un autre appareil) : le fil est rechargé
                        // AVANT d'être republié, sans quoi l'interface verrait
                        // le salon se vider puis ses messages revenir comme
                        // nouveaux (et sonner).
                        match self.recharger(&salon, &cache, deja).await {
                            Some(e) => evenements = e,
                            None => continue,
                        }
                    }
                    self.publier(&salon, &evenements, None).await;
                    self.publier_lectures(&salon, &evenements).await;
                }
            }
        }
    }

    /// Recharge un fil vidé jusqu'à `cible` messages affichables (ou le début
    /// du salon), sans rien publier en route.
    async fn recharger(&self, salon: &Room, cache: &RoomEventCache, cible: usize) -> Option<Vec<TimelineEvent>> {
        log::info!("[Sion][matrix] fil de {} vidé par le cache : rechargement", salon.room_id());
        for _ in 0..PAGES_MAX {
            let issue = match cache.pagination().run_backwards_once(TAILLE_PAGE).await {
                Ok(i) => i,
                Err(e) => {
                    log::warn!("[Sion][matrix] rechargement du fil de {} : {e}", salon.room_id());
                    return None;
                }
            };
            let evenements = cache.events().await.ok()?;
            if issue.reached_start || self.construire(salon, &evenements).await.len() >= cible.min(MAX_HISTORIQUE) {
                return Some(evenements);
            }
        }
        cache.events().await.ok()
    }

    /// « Vu par » du salon, republié s'il a changé.
    async fn publier_lectures(&self, salon: &Room, evenements: &[TimelineEvent]) {
        let id = salon.room_id().to_string();
        let affiches: Vec<String> = match self.instantane.lock().unwrap().get(&id) {
            Some(fil) => fil.messages.iter().map(|m| m.event_id.clone()).collect(),
            None => return,
        };
        let moi = salon.own_user_id().to_string();
        let joints: Vec<String> = salon
            .members_no_sync(RoomMemberships::JOIN)
            .await
            .unwrap_or_default()
            .iter()
            .map(|m| m.user_id().to_string())
            .filter(|m| *m != moi)
            .collect();
        let mut accuses: HashMap<String, Vec<String>> = HashMap::new();
        for membre in &joints {
            let Ok(uid) = OwnedUserId::try_from(membre.as_str()) else { continue };
            let mut evs = Vec::new();
            for fil in [ReceiptThread::Unthreaded, ReceiptThread::Main] {
                if let Ok(Some((ev, _))) = salon.load_user_receipt(TypeAccuse::Read, &fil, &uid).await {
                    evs.push(ev.to_string());
                }
            }
            accuses.insert(membre.clone(), evs);
        }
        let expediteurs: Vec<(String, String)> = evenements
            .iter()
            .filter_map(|e| {
                let id = e.event_id()?.to_string();
                let expediteur = e.raw().get_field::<String>("sender").ok().flatten()?;
                Some((id, expediteur))
            })
            .collect();
        let jalons: Vec<Jalon> = expediteurs.iter().map(|(id, expediteur)| Jalon { id, expediteur }).collect();
        let affiches: HashSet<&str> = affiches.iter().map(String::as_str).collect();
        let places = lectures::placer(&jalons, &affiches, &accuses, &joints, &moi, &ignores(salon));
        let profils = profils(salon, &self.medias).await;
        let lectures = LecturesSalon {
            salon: id.clone(),
            lectures: places.into_iter().map(|(ev, ids)| (ev, ids.iter().map(|i| personne(&profils, i)).collect())).collect(),
        };
        {
            let mut instantane = self.lectures.lock().unwrap();
            if instantane.get(&id) == Some(&lectures) {
                return;
            }
            instantane.insert(id, lectures.clone());
        }
        let _ = self.diffusion_lectures.send(lectures);
    }

    async fn publier_frappe(&self, salon: &Room, ids: Vec<OwnedUserId>) {
        let ignores = ignores(salon);
        let profils = profils(salon, &self.medias).await;
        let personnes = ids
            .iter()
            .map(|i| i.to_string())
            .filter(|i| !ignores.contains(i))
            .map(|i| personne(&profils, &i))
            .collect();
        let _ = self.diffusion_frappes.send(Frappe { salon: salon.room_id().to_string(), personnes });
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

/// Utilisateurs ignorés du compte (`m.ignored_user_list`).
fn ignores(salon: &Room) -> HashSet<String> {
    salon.client().subscribe_to_ignore_user_list_changes().get().into_iter().collect()
}

fn personne(profils: &HashMap<String, (Option<String>, Option<String>)>, id: &str) -> Personne {
    let (nom, avatar) = profils.get(id).cloned().unwrap_or((None, None));
    let nom = nom.unwrap_or_else(|| id.trim_start_matches('@').split(':').next().unwrap_or(id).to_owned());
    Personne { id: id.to_owned(), nom, avatar }
}

/// Nom affiché et avatar (URL `sion-media`) de chaque membre.
async fn profils(salon: &Room, medias: &Medias) -> HashMap<String, (Option<String>, Option<String>)> {
    let tous = salon.members_no_sync(RoomMemberships::all()).await.unwrap_or_default();
    let mut noms = membres::noms_du_salon(&tous);
    tous.iter()
        .map(|m| {
            let avatar = m.avatar_url().and_then(|u| medias.url_avatar(u.as_str()));
            let id = m.user_id().to_string();
            let nom = noms.remove(&id);
            (id, (nom, avatar))
        })
        .collect()
}

impl Fils {
    /// Un message précis, même hors du fil chargé — demandé au serveur et
    /// déchiffré s'il le faut : l'aperçu d'un épinglé ou d'une réponse trop
    /// ancienne pour être atteinte en remontant (plafond de `MAX_HISTORIQUE`).
    pub async fn message(&self, salon: &Room, id: &EventId) -> Option<Message> {
        let ev = match salon.load_or_fetch_event(id, None).await {
            Ok(ev) => ev,
            Err(e) => {
                log::debug!("[Sion][matrix] message {id} illisible : {e}");
                return None;
            }
        };
        let evenement = brut(&ev)?;
        let membres = profils(salon, &self.medias).await;
        let profil = |uid: &str| membres.get(uid).cloned().unwrap_or((None, None));
        let url = |source: &messages::SourceMedia, vignette: bool| self.medias.url(source, vignette);
        messages::extraire(&[evenement], &Contexte { profil: &profil, url: &url })
            .into_iter()
            .find(|m| m.event_id == id.as_str())
    }

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
        let membres = profils(salon, &self.medias).await;
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
