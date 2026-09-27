//! Fonctions propres à Sion (tranche T6), adaptateur : salon de la
//! soundboard (alias `#soundboard:<domaine>`), sons et memes, événements et
//! états `com.sion.*` (transcriptions, éjection vocale, version du client),
//! relais en direct de ces événements, notifications push, URL de médias.
use std::future::IntoFuture;
use std::sync::{Arc, Mutex};

use matrix_sdk::event_handler::Ctx;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::api::client::filter::RoomEventFilter;
use matrix_sdk::ruma::api::client::room::create_room::v3::{Request as CreerSalon, RoomPreset};
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{uint, OwnedRoomAliasId, RoomAliasId};
use matrix_sdk::{Client, Room, RoomMemberships};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::coeur::CoeurMatrix;
use crate::fil::brut;
use crate::gestion::http;
use crate::messages::{EvenementBrut, SourceMedia};
use crate::sion::{self, ChampVoix, Meme, MemeTeleverse, Son, VersionMembre, Voix};
use crate::{Erreur, Resultat};

/// Partie locale de l'alias du salon de la soundboard (`SOUNDBOARD_ALIAS_LOCAL`).
const ALIAS_SOUNDBOARD: &str = "soundboard";
/// Pages de 100 messages au plus pour relire la soundboard (garde du JS).
const PAGES_MAX: usize = 50;

/// Un événement `com.sion.*` du fil, relayé tel quel à l'interface, qui
/// garde sa logique (transcriptions, éjection vocale).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvenementSion {
    pub salon: String,
    pub event_id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub sender: String,
    pub ts: i64,
    pub content: Value,
}

/// Résultat de `createOrSyncSoundboardRoom`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultatSoundboard {
    pub room_id: String,
    pub already_existed: bool,
    pub invited_count: usize,
}

/// Un son tout juste ajouté (`uploadSound`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonAjoute {
    pub event_id: String,
    pub mxc_url: String,
    pub duration: Option<i64>,
}

/// Un état de salon (`getStateEvents(type)`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtatSalon {
    pub state_key: String,
    pub content: Value,
}

/// État propre à T6, tenu par le cœur.
pub(crate) struct Sion {
    diffusion: broadcast::Sender<EvenementSion>,
    /// Salon de la soundboard résolu pour la session (`soundboardRoomCache`).
    soundboard: Mutex<Option<Option<String>>>,
}

impl Sion {
    pub fn nouveau() -> Arc<Self> {
        let (diffusion, _) = broadcast::channel(256);
        Arc::new(Self { diffusion, soundboard: Mutex::new(None) })
    }

    pub fn oublier(&self) {
        self.soundboard.lock().unwrap().take();
    }

    /// Relais des événements `com.sion.*` du fil (déchiffrés par matrix-sdk
    /// avant d'arriver ici).
    pub fn brancher(self: &Arc<Self>, client: &Client) {
        client.add_event_handler_context(self.clone());
        client.add_event_handler(|ev: Raw<AnySyncTimelineEvent>, salon: Room, sion: Ctx<Arc<Sion>>| async move {
            let Ok(json) = serde_json::from_str::<Value>(ev.json().get()) else { return };
            let type_ = json.get("type").and_then(Value::as_str).unwrap_or("");
            if !type_.starts_with("com.sion.") {
                return;
            }
            let chaine = |c: &str| json.get(c).and_then(Value::as_str).unwrap_or("").to_owned();
            let _ = sion.0.diffusion.send(EvenementSion {
                salon: salon.room_id().to_string(),
                event_id: chaine("event_id"),
                type_: type_.to_owned(),
                sender: chaine("sender"),
                ts: json.get("origin_server_ts").and_then(Value::as_i64).unwrap_or(0),
                content: json.get("content").cloned().unwrap_or(Value::Null),
            });
        });
    }
}

/// Événements de certains types d'un salon, du plus ancien au plus récent,
/// par une pagination FILTRÉE côté serveur (`fetchSoundboardMessages`) : le
/// salon de la soundboard est encombré d'adhésions, un défilement brut s'y
/// noierait. Dans un salon chiffré, le serveur ne voit que
/// `m.room.encrypted` : on le demande aussi, et le tri se fait après
/// déchiffrement.
async fn messages_filtres(salon: &Room, types: &[&str]) -> Resultat<Vec<EvenementBrut>> {
    let mut filtre = RoomEventFilter::default();
    filtre.types = Some(types.iter().map(|t| t.to_string()).chain(std::iter::once("m.room.encrypted".to_owned())).collect());
    let mut depuis: Option<String> = None;
    let mut evenements = Vec::new();
    for _ in 0..PAGES_MAX {
        let mut options = MessagesOptions::backward().from(depuis.as_deref());
        options.limit = uint!(100);
        options.filter = filtre.clone();
        let page = salon.messages(options).await?;
        evenements.extend(page.chunk.iter().filter_map(brut));
        match page.end {
            Some(fin) if !page.chunk.is_empty() => depuis = Some(fin),
            _ => break,
        }
    }
    evenements.reverse();
    // Un événement resté indéchiffrable passe pour un `m.room.message` en
    // échec (voir `brut`) : il n'a rien à faire ici.
    evenements.retain(|e| !e.echec_dechiffrement && types.contains(&e.type_.as_str()));
    Ok(evenements)
}

async fn televerser(client: &Client, octets: Vec<u8>, mime: &str) -> Resultat<String> {
    let type_: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
    Ok(Box::pin(client.media().upload(&type_, octets, None).into_future()).await?.content_uri.to_string())
}

// Chaque méthode publique rend un futur en boîte (voir `recursion_limit`
// dans lib.rs) ; le travail est dans sa jumelle suffixée `_`.
impl CoeurMatrix {
    /// Événements `com.sion.*` reçus, en direct.
    pub fn evenements_sion(&self) -> broadcast::Receiver<EvenementSion> {
        self.sion.diffusion.subscribe()
    }

    /// URL `sion-media` d'un média mxc (sons, voix de référence, memes) :
    /// téléchargé authentifié par le cœur (`mxcUrlToHttp` + jeton du JS).
    pub fn url_media(&self, mxc: &str) -> Option<String> {
        self.medias().url(&SourceMedia::Mxc(mxc.to_owned()), false)
    }

    // ── Soundboard ──────────────────────────────────────────────────────────

    /// Salon de la soundboard (`findSoundboardRoom`) : l'alias résolu une fois
    /// par session ; un échec passager n'est pas retenu.
    pub async fn salon_soundboard(&self) -> Resultat<Option<String>> {
        Box::pin(self.salon_soundboard_()).await
    }

    async fn salon_soundboard_(&self) -> Resultat<Option<String>> {
        if let Some(connu) = self.sion.soundboard.lock().unwrap().clone() {
            return Ok(connu);
        }
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let domaine = client.user_id().ok_or(Erreur::PasDeSession)?.server_name().to_string();
        let alias: OwnedRoomAliasId = RoomAliasId::parse(format!("#{ALIAS_SOUNDBOARD}:{domaine}")).map_err(|e| Erreur::Autre(e.to_string()))?;
        let id = match client.resolve_room_alias(&alias).await {
            Ok(r) => Some(r.room_id.to_string()),
            Err(e) if e.client_api_error_kind() == Some(&matrix_sdk::ruma::api::error::ErrorKind::NotFound) => None,
            Err(e) => return Err(matrix_sdk::Error::from(e).into()),
        };
        self.sion.soundboard.lock().unwrap().replace(id.clone());
        Ok(id)
    }

    async fn salon_soundboard_requis(&self) -> Resultat<Room> {
        let id = self.salon_soundboard().await?.ok_or_else(|| Erreur::Autre("Soundboard room not created yet".into()))?;
        self.salon(&id).await
    }

    /// Création (ou mise à jour) du salon de la soundboard
    /// (`createOrSyncSoundboardRoom`) : seuls les modérateurs y publient
    /// (`events_default` 50), et tout le serveur y est ajouté d'office.
    pub async fn creer_ou_synchroniser_soundboard(&self) -> Resultat<ResultatSoundboard> {
        Box::pin(self.creer_ou_synchroniser_soundboard_()).await
    }

    async fn creer_ou_synchroniser_soundboard_(&self) -> Resultat<ResultatSoundboard> {
        if let Some(id) = self.salon_soundboard().await? {
            let n = self.ajouter_tout_le_serveur(&id).await;
            return Ok(ResultatSoundboard { room_id: id, already_existed: true, invited_count: n });
        }
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        let mut utilisateurs = serde_json::Map::new();
        utilisateurs.insert(moi, 100.into());
        for admin in self.admins_serveur().await.unwrap_or_default() {
            utilisateurs.insert(admin, 100.into());
        }
        let mut requete = CreerSalon::new();
        requete.name = Some("Soundboard".into());
        requete.topic = Some("Bibliothèque de sons partagée".into());
        requete.room_alias_name = Some(ALIAS_SOUNDBOARD.into());
        requete.preset = Some(RoomPreset::PublicChat);
        requete.initial_state = vec![
            Raw::from_json_string(json!({ "type": "m.room.history_visibility", "state_key": "", "content": { "history_visibility": "shared" } }).to_string())?,
            Raw::from_json_string(json!({ "type": "m.room.guest_access", "state_key": "", "content": { "guest_access": "forbidden" } }).to_string())?,
        ];
        requete.power_level_content_override = Some(Raw::from_json_string(
            json!({
                "users": utilisateurs, "users_default": 0, "events_default": 50, "state_default": 100,
                "invite": 50, "kick": 50, "ban": 100, "redact": 50,
            })
            .to_string(),
        )?);
        let salon = Box::pin(client.create_room(requete)).await?;
        let id = salon.room_id().to_string();
        self.sion.soundboard.lock().unwrap().take();
        let n = self.ajouter_tout_le_serveur(&id).await;
        Ok(ResultatSoundboard { room_id: id, already_existed: false, invited_count: n })
    }

    /// `inviteAllServerUsers` : ajout d'office par le robot de chaque
    /// utilisateur du serveur pas encore membre.
    async fn ajouter_tout_le_serveur(&self, id: &str) -> usize {
        let Ok(client) = self.client().await.ok_or(Erreur::PasDeSession) else { return 0 };
        let deja: Vec<String> = match self.salon(id).await {
            Ok(s) => s.members_no_sync(RoomMemberships::JOIN).await.unwrap_or_default().iter().map(|m| m.user_id().to_string()).collect(),
            Err(_) => Vec::new(),
        };
        let mut n = 0;
        for cible in self.utilisateurs_du_serveur(&client).await.into_iter().filter(|u| !deja.contains(u)) {
            match self.commande_admin(&format!("!admin users force-join-room {cible} {id}")).await {
                Ok(_) => n += 1,
                Err(e) => log::warn!("[Sion][matrix] {cible} non ajouté à la soundboard : {e}"),
            }
        }
        n
    }

    /// Sons de la soundboard (`listSounds`).
    pub async fn sons(&self) -> Resultat<Vec<Son>> {
        Box::pin(self.sons_()).await
    }

    async fn sons_(&self) -> Resultat<Vec<Son>> {
        let Some(id) = self.salon_soundboard().await? else { return Ok(Vec::new()) };
        let salon = self.salon(&id).await?;
        Ok(sion::sons(&messages_filtres(&salon, &["m.room.message"]).await?))
    }

    /// Memes (`listMemes`), rangés dans le salon de la soundboard.
    pub async fn memes(&self) -> Resultat<Vec<Meme>> {
        Box::pin(self.memes_()).await
    }

    async fn memes_(&self) -> Resultat<Vec<Meme>> {
        let Some(id) = self.salon_soundboard().await? else { return Ok(Vec::new()) };
        let salon = self.salon(&id).await?;
        Ok(sion::memes(&messages_filtres(&salon, &["m.room.message"]).await?))
    }

    /// Ajout d'un son (`uploadSound`), avec les contrôles du JS : un audio,
    /// 1 Mo et 20 s au plus (la durée est mesurée par l'appelant).
    #[allow(clippy::too_many_arguments)]
    pub async fn ajouter_son(
        &self,
        octets: Vec<u8>,
        nom_fichier: &str,
        mime: &str,
        duree: Option<i64>,
        label: &str,
        categorie: &str,
        emoji: Option<&str>,
        gain: f64,
        voix: Option<Voix>,
        modele: Option<&str>,
    ) -> Resultat<SonAjoute> {
        Box::pin(self.ajouter_son_(octets, nom_fichier, mime, duree, label, categorie, emoji, gain, voix, modele)).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn ajouter_son_(
        &self,
        octets: Vec<u8>,
        nom_fichier: &str,
        mime: &str,
        duree: Option<i64>,
        label: &str,
        categorie: &str,
        emoji: Option<&str>,
        gain: f64,
        voix: Option<Voix>,
        modele: Option<&str>,
    ) -> Resultat<SonAjoute> {
        let salon = self.salon_soundboard_requis().await?;
        let taille = octets.len() as u64;
        if taille > sion::TAILLE_MAX_SON {
            return Err(Erreur::Autre(format!("Fichier trop lourd (max {} KB)", sion::TAILLE_MAX_SON / 1024)));
        }
        if !mime.starts_with("audio/") {
            return Err(Erreur::Autre("Le fichier doit être un audio".into()));
        }
        if duree.is_some_and(|d| d > sion::DUREE_MAX_SON_MS) {
            return Err(Erreur::Autre(format!("Son trop long (max {}s)", sion::DUREE_MAX_SON_MS / 1000)));
        }
        let mxc = televerser(&salon.client(), octets, mime).await?;
        let contenu = sion::contenu_nouveau_son(nom_fichier, &mxc, mime, taille, duree, label, categorie, emoji, gain, voix.as_ref(), modele);
        let envoi = Box::pin(salon.send_raw("m.room.message", contenu).into_future()).await?;
        Ok(SonAjoute { event_id: envoi.response.event_id.to_string(), mxc_url: mxc, duration: duree })
    }

    /// Édition des métadonnées d'un son (`editSound`).
    #[allow(clippy::too_many_arguments)]
    pub async fn modifier_son(
        &self,
        event_id: &str,
        label: &str,
        categorie: &str,
        emoji: Option<&str>,
        gain: f64,
        ref_text: ChampVoix,
        avatar: ChampVoix,
    ) -> Resultat<()> {
        Box::pin(self.modifier_son_(event_id, label, categorie, emoji, gain, ref_text, avatar)).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn modifier_son_(
        &self,
        event_id: &str,
        label: &str,
        categorie: &str,
        emoji: Option<&str>,
        gain: f64,
        ref_text: ChampVoix,
        avatar: ChampVoix,
    ) -> Resultat<()> {
        let salon = self.salon_soundboard_requis().await?;
        let original = sion::sons(&messages_filtres(&salon, &["m.room.message"]).await?)
            .into_iter()
            .find(|s| s.event_id == event_id)
            .ok_or_else(|| Erreur::Autre(format!("son inconnu : {event_id}")))?;
        let contenu = sion::contenu_edition_son(&original, label, categorie, emoji, gain, ref_text, avatar);
        Box::pin(salon.send_raw("m.room.message", contenu).into_future()).await?;
        Ok(())
    }

    /// Suppression d'un son ou d'un meme (`deleteSound`, `supprimerMeme`).
    pub async fn supprimer_du_soundboard(&self, event_id: &str) -> Resultat<()> {
        let id = self.salon_soundboard().await?.ok_or_else(|| Erreur::Autre("Soundboard room not created".into()))?;
        self.supprimer(&id, event_id).await
    }

    /// Envoi d'un meme préparé (`envoyerMeme`) : vidéo (ou GIF) et aperçu
    /// téléversés, puis le message `com.sion.meme`.
    #[allow(clippy::too_many_arguments)]
    pub async fn envoyer_meme(
        &self,
        video: Vec<u8>,
        mime: &str,
        largeur: i64,
        hauteur: i64,
        duree_ms: i64,
        apercu: Option<(Vec<u8>, String)>,
        label: &str,
        emoji: Option<&str>,
    ) -> Resultat<String> {
        Box::pin(self.envoyer_meme_(video, mime, largeur, hauteur, duree_ms, apercu, label, emoji)).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn envoyer_meme_(
        &self,
        video: Vec<u8>,
        mime: &str,
        largeur: i64,
        hauteur: i64,
        duree_ms: i64,
        apercu: Option<(Vec<u8>, String)>,
        label: &str,
        emoji: Option<&str>,
    ) -> Resultat<String> {
        let salon = self.salon_soundboard_requis().await?;
        let client = salon.client();
        let nom = sion::nom_fichier_meme(label, mime == "image/gif");
        let taille = video.len() as u64;
        let mxc = televerser(&client, video, mime).await?;
        let apercu_mxc = match &apercu {
            Some((octets, type_)) => Some((televerser(&client, octets.clone(), type_).await?, type_.clone())),
            None => None,
        };
        let t = MemeTeleverse {
            mxc: &mxc,
            mime,
            taille,
            largeur,
            hauteur,
            duree_ms,
            apercu: apercu_mxc.as_ref().map(|(m, t)| (m.as_str(), t.as_str())),
        };
        let contenu = sion::contenu_meme(&t, &nom, label, emoji);
        let envoi = Box::pin(salon.send_raw("m.room.message", contenu).into_future()).await?;
        Ok(envoi.response.event_id.to_string())
    }

    // ── Événements et états propres à Sion ──────────────────────────────────

    /// Événement quelconque (`com.sion.transcript`, `…session`,
    /// `com.sion.voice_kick`…), chiffré d'office dans un salon chiffré.
    pub async fn envoyer_evenement(&self, salon: &str, type_: &str, contenu: Value) -> Resultat<String> {
        Box::pin(self.envoyer_evenement_(salon, type_, contenu)).await
    }

    async fn envoyer_evenement_(&self, salon: &str, type_: &str, contenu: Value) -> Resultat<String> {
        let salon = self.salon(salon).await?;
        let envoi = Box::pin(salon.send_raw(type_, contenu).into_future()).await?;
        Ok(envoi.response.event_id.to_string())
    }

    /// État de salon quelconque.
    pub async fn envoyer_etat(&self, salon: &str, type_: &str, cle: &str, contenu: Value) -> Resultat<()> {
        Box::pin(self.envoyer_etat_(salon, type_, cle, contenu)).await
    }

    async fn envoyer_etat_(&self, salon: &str, type_: &str, cle: &str, contenu: Value) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        Box::pin(salon.send_state_event_raw(type_, cle, contenu)).await?;
        Ok(())
    }

    /// Tous les états d'un type (`currentState.getStateEvents(type)`).
    pub async fn etats(&self, salon: &str, type_: &str) -> Resultat<Vec<EtatSalon>> {
        Box::pin(self.etats_(salon, type_)).await
    }

    async fn etats_(&self, salon: &str, type_: &str) -> Resultat<Vec<EtatSalon>> {
        let salon = self.salon(salon).await?;
        let bruts = salon.get_state_events(type_.into()).await?;
        Ok(bruts
            .into_iter()
            .filter_map(|b| {
                let json = match b {
                    matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Sync(e) => e.json().get().to_owned(),
                    matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Stripped(e) => e.json().get().to_owned(),
                };
                let v: Value = serde_json::from_str(&json).ok()?;
                Some(EtatSalon {
                    state_key: v.get("state_key").and_then(Value::as_str).unwrap_or("").to_owned(),
                    content: v.get("content").cloned().unwrap_or(Value::Null),
                })
            })
            .collect())
    }

    /// Versions annoncées dans un salon (`getRoomClientVersions`).
    pub async fn versions_salon(&self, salon: &str) -> Resultat<Vec<VersionMembre>> {
        let etats = self.etats(salon, sion::EVENEMENT_VERSION).await?;
        Ok(sion::versions(&etats.into_iter().map(|e| (e.state_key, e.content)).collect::<Vec<_>>()))
    }

    /// Annonce la version de ce client dans les salons rejoints, seulement là
    /// où elle a changé (`publishClientVersion`) ; rend le nombre d'annonces.
    pub async fn publier_version(&self, version: &str, os: &str, ts: i64) -> Resultat<usize> {
        Box::pin(self.publier_version_(version, os, ts)).await
    }

    async fn publier_version_(&self, version: &str, os: &str, ts: i64) -> Resultat<usize> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        let mut n = 0;
        for salon in client.joined_rooms() {
            let id = salon.room_id().to_string();
            let actuel = self.etats(&id, sion::EVENEMENT_VERSION).await.unwrap_or_default();
            if actuel.iter().any(|e| e.state_key == moi && e.content.get("version").and_then(Value::as_str) == Some(version)) {
                continue;
            }
            // Droit insuffisant, salon en lecture seule : sans conséquence.
            if self.envoyer_etat(&id, sion::EVENEMENT_VERSION, &moi, json!({ "version": version, "os": os, "ts": ts })).await.is_ok() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Ouvre l'annonce de version à tous les membres des salons où l'on a le
    /// rang (`ouvrirDroitAnnonceVersion`) ; rend le nombre de salons ouverts.
    pub async fn ouvrir_droit_version(&self) -> Resultat<usize> {
        Box::pin(self.ouvrir_droit_version_()).await
    }

    async fn ouvrir_droit_version_(&self) -> Resultat<usize> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let mut n = 0;
        for salon in client.joined_rooms() {
            let id = salon.room_id().to_string();
            let Ok(details) = self.details_salon(&id).await else { continue };
            let Some(niveaux) = self.etats(&id, "m.room.power_levels").await.ok().and_then(|e| e.into_iter().next()) else { continue };
            let Some(nouveau) = sion::niveaux_avec_version_ouverte(&niveaux.content, details.moi) else { continue };
            match self.envoyer_etat(&id, "m.room.power_levels", "", nouveau).await {
                Ok(()) => n += 1,
                Err(e) => log::warn!("[Sion][matrix] droit d'annonce non ouvert dans {id} : {e}"),
            }
        }
        Ok(n)
    }

    /// Nom de l'appareil de cette session, mis à jour s'il a changé
    /// (`refreshDeviceVersionLabel`) ; rend « mis à jour ».
    pub async fn rafraichir_nom_appareil(&self, nom: &str) -> Resultat<bool> {
        Box::pin(self.rafraichir_nom_appareil_(nom)).await
    }

    async fn rafraichir_nom_appareil_(&self, nom: &str) -> Resultat<bool> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let appareil = client.device_id().ok_or(Erreur::PasDeSession)?.to_owned();
        let actuel = client.devices().await.map_err(matrix_sdk::Error::from)?.devices.into_iter().find(|d| d.device_id == appareil);
        if actuel.and_then(|d| d.display_name).as_deref() == Some(nom) {
            return Ok(false);
        }
        client.rename_device(&appareil, nom).await.map_err(matrix_sdk::Error::from)?;
        Ok(true)
    }

    /// Événements d'un salon de certains types, du plus ancien au plus
    /// récent, par pagination filtrée (reprise de l'historique des
    /// transcriptions, `backfillTranscript`).
    pub async fn historique_filtre(&self, salon: &str, types: &[String]) -> Resultat<Vec<EvenementSion>> {
        Box::pin(self.historique_filtre_(salon, types)).await
    }

    async fn historique_filtre_(&self, salon: &str, types: &[String]) -> Resultat<Vec<EvenementSion>> {
        let id = salon.to_owned();
        let salon = self.salon(salon).await?;
        let types: Vec<&str> = types.iter().map(String::as_str).collect();
        Ok(messages_filtres(&salon, &types)
            .await?
            .into_iter()
            .map(|e| EvenementSion { salon: id.clone(), event_id: e.id, type_: e.type_, sender: e.expediteur, ts: e.ts, content: e.contenu })
            .collect())
    }

    // ── Notifications push ──────────────────────────────────────────────────

    /// Déclare (ou retire, `kind: null`) un pousseur (`client.setPusher`),
    /// au format du protocole — celui qu'envoie le JS.
    pub async fn definir_pousseur(&self, pousseur: Value) -> Resultat<()> {
        Box::pin(self.requete_client("POST", "/_matrix/client/v3/pushers/set", Some(pousseur))).await
    }

    /// Supprime une règle de notification (`deletePushRule`).
    pub async fn supprimer_regle_push(&self, portee: &str, genre: &str, regle: &str) -> Resultat<()> {
        let segment = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
        if !segment(portee) || !segment(genre) || !segment(regle) {
            return Err(Erreur::Autre("règle de notification invalide".into()));
        }
        Box::pin(self.requete_client("DELETE", &format!("/_matrix/client/v3/pushrules/{portee}/{genre}/{regle}"), None)).await
    }

    /// Requête authentifiée à l'API client ; une erreur du serveur remonte.
    async fn requete_client(&self, methode: &str, chemin: &str, corps: Option<Value>) -> Resultat<()> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let base = client.homeserver().to_string();
        let r = http(methode, &format!("{}{chemin}", base.trim_end_matches('/')), client.access_token().as_deref(), corps.as_ref()).await?;
        if (200..300).contains(&r.status) {
            Ok(())
        } else {
            Err(Erreur::Autre(format!("{} {}", r.status, r.corps.get("errcode").and_then(Value::as_str).unwrap_or(""))))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evenement_sion_au_format_de_l_interface() {
        let e = EvenementSion {
            salon: "!a:hs".into(),
            event_id: "$e".into(),
            type_: "com.sion.voice_kick".into(),
            sender: "@a:hs".into(),
            ts: 1,
            content: json!({ "kicked_user": "@b:hs" }),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "com.sion.voice_kick");
        assert_eq!(v["eventId"], "$e");
    }

    #[test]
    fn cle_de_media_stable() {
        let m = crate::medias::Medias::nouveau(crate::PREFIXE_PAR_DEFAUT);
        let a = m.url(&SourceMedia::Mxc("mxc://hs/son".into()), false).unwrap();
        assert_eq!(a, m.url(&SourceMedia::Mxc("mxc://hs/son".into()), false).unwrap());
    }

    #[test]
    fn supprime_rien_si_la_regle_est_douteuse() {
        // Le contrôle des segments ne laisse passer ni « / » ni « .. »-chemins.
        let ok = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
        assert!(ok("fr.sionchat.suppress_messages") && !ok("../x") && !ok("a/b"));
    }
}
