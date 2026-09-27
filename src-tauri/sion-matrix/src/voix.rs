//! La voix côté Matrix (étape 3) : ce que `MatrixRTCSession` faisait pour le
//! moteur JS. Rejoindre l'appel d'un salon — jeton du serveur média,
//! appartenance —, la tenir à jour (renouvellement, mute et sourdine), et
//! échanger les clés des médias (`rtc.rs`).
//!
//! Le média reste au moteur LiveKit natif de l'appli : il reçoit d'ici
//! l'adresse et le jeton, puis les clés directement, sans passer par
//! l'interface.
use std::sync::{Arc, Mutex as MutexSync};
use std::time::Duration;

use matrix_sdk_crypto::CollectStrategy;
use matrix_sdk::ruma::events::AnyToDeviceEventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedUserId};
use matrix_sdk::{Client, Room, RoomMemberships};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

use crate::coeur::CoeurMatrix;
use crate::gestion::http;
use crate::horloge::{maintenant_local, Horloge};
use crate::rtc::{self, Annonce, Appartenance, CleMedia, Distribution, Foyer, GestionCles};
use crate::synchro::evenements_appel;
use crate::{Erreur, Resultat};

/// Ce que la synchro transmet à la session vocale.
#[derive(Clone, Debug)]
pub(crate) enum EvenementRtc {
    /// Une réponse de synchro est arrivée : l'état des salons a pu changer.
    Synchro,
    /// Envoi de clé déchiffré (`io.element.call.encryption_keys`) ;
    /// l'expéditeur est celui que garantit le chiffrement.
    Cle { expediteur: String, appareil: Option<String>, contenu: Value },
}

/// Pour rejoindre le média : où, avec quel jeton, et sous quelle identité.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnexionVoix {
    pub salon: String,
    /// `wss://…` du serveur média.
    pub url: String,
    pub jeton: String,
    /// Salon chiffré : les médias le sont aussi, avec les clés d'ici.
    pub chiffre: bool,
    /// Notre identité sur le serveur média (`@moi:serveur:APPAREIL`).
    pub identite: String,
}

enum Commande {
    Etat { muet: bool, sourd: bool },
    Republier,
    Quitter(oneshot::Sender<()>),
}

struct Session {
    salon: String,
    commandes: mpsc::UnboundedSender<Commande>,
    gestion: Arc<MutexSync<GestionCles>>,
    tache: tokio::task::JoinHandle<()>,
}

pub(crate) struct Voix {
    evenements: broadcast::Sender<EvenementRtc>,
    cles: broadcast::Sender<CleMedia>,
    session: Mutex<Option<Session>>,
}

impl Voix {
    pub fn nouvelle() -> Arc<Self> {
        Arc::new(Self {
            evenements: broadcast::Sender::new(256),
            cles: broadcast::Sender::new(256),
            session: Mutex::new(None),
        })
    }

    /// Canal que la synchro alimente.
    pub fn evenements(&self) -> broadcast::Sender<EvenementRtc> {
        self.evenements.clone()
    }

    /// Termine la session en cours : départ publié, tâche arrêtée.
    async fn terminer(&self) {
        let Some(session) = self.session.lock().await.take() else { return };
        let (fait, attente) = oneshot::channel();
        if session.commandes.send(Commande::Quitter(fait)).is_ok() {
            // Le départ ne doit pas bloquer une fermeture : 3 s au plus.
            let _ = tokio::time::timeout(Duration::from_secs(3), attente).await;
        }
        session.tache.abort();
    }
}

/// Le service LiveKit du salon (`getMatrixRTCToken`) : celui qu'annoncent
/// les participants du salon, sinon ceux d'autres salons, sinon celui du
/// serveur (`.well-known`, `org.matrix.msc4143.rtc_foci`). La salle porte
/// le nom annoncé dans le salon, sinon l'identifiant du salon.
async fn trouver_foyer(client: &Client, salon: &Room) -> Resultat<Foyer> {
    let id = salon.room_id().to_string();
    for ev in evenements_appel(salon).await? {
        if let Some((service, alias)) = rtc::foyer_annonce(&ev.contenu) {
            return Ok(Foyer { service: rtc::service_nu(&service).to_owned(), alias: alias.unwrap_or(id) });
        }
    }
    for autre in client.joined_rooms() {
        if autre.room_id() == salon.room_id() {
            continue;
        }
        for ev in evenements_appel(&autre).await.unwrap_or_default() {
            if let Some((service, _)) = rtc::foyer_annonce(&ev.contenu) {
                return Ok(Foyer { service: rtc::service_nu(&service).to_owned(), alias: id });
            }
        }
    }
    let serveur = client.homeserver().to_string();
    let connu = http("GET", &format!("{}/.well-known/matrix/client", serveur.trim_end_matches('/')), None, None).await?;
    let service = connu.corps["org.matrix.msc4143.rtc_foci"]
        .as_array()
        .and_then(|foci| {
            foci.iter().find_map(|f| {
                (f["type"] == "livekit").then(|| f["livekit_service_url"].as_str()).flatten().filter(|s| !s.is_empty())
            })
        })
        .ok_or_else(|| Erreur::Autre("aucun service LiveKit connu pour ce salon".into()))?;
    Ok(Foyer { service: rtc::service_nu(service).to_owned(), alias: id })
}

/// Jeton du serveur média, contre un jeton OpenID du compte (`/sfu/get`,
/// sinon `/get_token`, comme le moteur JS).
async fn jeton_media(client: &Client, foyer: &Foyer) -> Resultat<(String, String)> {
    let openid = client.account().request_openid_token().await?;
    let jeton_openid = json!({
        "access_token": openid.access_token,
        "token_type": serde_json::to_value(&openid.token_type)?,
        "matrix_server_name": openid.matrix_server_name.to_string(),
        "expires_in": openid.expires_in.as_secs(),
    });
    let appareil = client.device_id().map(|d| d.to_string()).unwrap_or_default();
    let service = foyer.service.trim_end_matches('/');
    let corps = json!({ "room": foyer.alias, "openid_token": jeton_openid, "device_id": appareil });
    for chemin in ["/sfu/get", "/get_token"] {
        match http("POST", &format!("{service}{chemin}"), None, Some(&corps)).await {
            Ok(r) if (200..300).contains(&r.status) => {
                if let Some(jwt) = r.corps.get("jwt").and_then(Value::as_str) {
                    return Ok((rtc::adresse_media(service), jwt.to_owned()));
                }
                log::warn!("[Sion][voix] {service}{chemin} : réponse sans jeton");
            }
            Ok(r) => log::warn!("[Sion][voix] {service}{chemin} : HTTP {}", r.status),
            Err(e) => log::warn!("[Sion][voix] {service}{chemin} : {e}"),
        }
    }
    Err(Erreur::Autre("le service LiveKit n'a délivré aucun jeton".into()))
}

fn aleatoire() -> [u8; 16] {
    let mut cle = [0u8; 16];
    getrandom::fill(&mut cle).expect("générateur aléatoire du système");
    cle
}

/// Ce que la session sait d'elle-même.
struct Etat {
    client: Client,
    salon: Room,
    moi: String,
    appareil: String,
    cle_etat: String,
    foyer: Foyer,
    chiffre: bool,
    muet: bool,
    sourd: bool,
    /// Nombre de périodes d'une heure couvertes par `expires`.
    periodes: i64,
    /// Date de notre jonction, lue dans l'état une fois l'événement revenu.
    cree: Option<i64>,
    membres: Vec<Appartenance>,
    gestion: Arc<MutexSync<GestionCles>>,
    cles: broadcast::Sender<CleMedia>,
    horloge: Arc<Horloge>,
}

impl Etat {
    async fn annoncer(&self) {
        let contenu = rtc::contenu_appartenance(&Annonce {
            moi: &self.moi,
            appareil: &self.appareil,
            foyer: &self.foyer,
            expires: rtc::EXPIRATION_MS * self.periodes,
            cree: self.cree,
            muet: self.muet,
            sourd: self.sourd,
        });
        if let Err(e) = self.salon.send_state_event_raw("org.matrix.msc3401.call.member", &self.cle_etat, contenu).await {
            log::warn!("[Sion][voix] appartenance non publiée : {e}");
        }
    }

    async fn partir(&self) {
        if let Err(e) = self.salon.send_state_event_raw("org.matrix.msc3401.call.member", &self.cle_etat, json!({})).await {
            log::warn!("[Sion][voix] départ non publié : {e}");
        }
    }

    async fn lire_membres(&self) -> Vec<Appartenance> {
        let evenements = evenements_appel(&self.salon).await.unwrap_or_default();
        let joints: std::collections::HashSet<String> = match self.salon.members_no_sync(RoomMemberships::JOIN).await {
            Ok(m) => m.iter().map(|m| m.user_id().to_string()).collect(),
            Err(_) => return self.membres.clone(),
        };
        rtc::appartenances(&evenements, |u| joints.contains(u), self.horloge.maintenant_serveur())
    }

    fn remettre(&self, m: CleMedia) {
        let _ = self.cles.send(m);
    }

    /// Envoie une clé à ses destinataires ; renvoie ceux qui l'ont eue.
    async fn envoyer(&self, d: &Distribution) -> Distribution {
        let chiffrement = self.client.encryption();
        let mut appareils = Vec::new();
        for cible in &d.cibles {
            let Ok(u) = OwnedUserId::try_from(cible.utilisateur.as_str()) else { continue };
            let a = OwnedDeviceId::from(cible.appareil.as_str());
            let mut appareil = chiffrement.get_device(&u, &a).await.ok().flatten();
            if appareil.is_none() {
                // Appareil tout neuf : ses clés ne sont pas encore connues.
                let _ = chiffrement.request_user_identity(&u).await;
                appareil = chiffrement.get_device(&u, &a).await.ok().flatten();
            }
            match appareil {
                Some(x) => appareils.push(x),
                None => log::warn!("[Sion][voix] appareil {u} {a} inconnu : clé non envoyée"),
            }
        }
        let contenu = rtc::contenu_cle(self.salon.room_id().as_str(), &self.moi, &self.appareil, d.index, &d.cle, maintenant_local());
        let brut: Raw<AnyToDeviceEventContent> = match serde_json::value::to_raw_value(&contenu) {
            Ok(r) => Raw::from_json(r),
            Err(_) => return Distribution { cibles: Vec::new(), ..d.clone() },
        };
        let references: Vec<_> = appareils.iter().collect();
        let echecs = match chiffrement.encrypt_and_send_raw_to_device(references, rtc::TYPE_CLES, brut, CollectStrategy::AllDevices).await {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[Sion][voix] clé {} non envoyée : {e}", d.index);
                return Distribution { cibles: Vec::new(), ..d.clone() };
            }
        };
        let recues: Vec<_> = d
            .cibles
            .iter()
            .filter(|c| {
                appareils.iter().any(|x| x.user_id().as_str() == c.utilisateur && x.device_id().as_str() == c.appareil)
                    && !echecs.iter().any(|(u, a)| u.as_str() == c.utilisateur && a.as_str() == c.appareil)
            })
            .cloned()
            .collect();
        log::info!("[Sion][voix] clé {} envoyée à {}/{} appareil(s)", d.index, recues.len(), d.cibles.len());
        Distribution { cibles: recues, ..d.clone() }
    }

    /// Les participants ont (peut-être) changé.
    async fn suivre_membres(&mut self, force: bool) {
        let membres = self.lire_membres().await;
        if self.cree.is_none() {
            self.cree = membres.iter().find(|m| m.utilisateur == self.moi && m.appareil == self.appareil).map(|m| m.cree);
        }
        if !force && membres == self.membres {
            return;
        }
        self.membres = membres;
        if !self.chiffre {
            return;
        }
        let (premiere, envoi, liberees) = {
            let mut g = self.gestion.lock().unwrap();
            let (premiere, envoi) = g.planifier(&self.membres, maintenant_local(), &mut aleatoire);
            (premiere, envoi, g.liberer(&self.membres))
        };
        if let Some(m) = premiere {
            log::info!("[Sion][voix] première clé {} créée", m.index);
            self.remettre(m);
        }
        for m in liberees {
            self.remettre(m);
        }
        if let Some(d) = envoi {
            let recue = if d.cibles.is_empty() { d.clone() } else { self.envoyer(&d).await };
            self.gestion.lock().unwrap().distribuee(&recue);
            if d.nouvelle {
                // Laisser à la clé le temps d'arriver avant de chiffrer avec.
                let (gestion, cles) = (self.gestion.clone(), self.cles.clone());
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(rtc::DELAI_CLE_MS)).await;
                    let m = gestion.lock().unwrap().utiliser(d.index, &d.cle);
                    let _ = cles.send(m);
                });
            }
        }
        // Comme `reemitEncryptionKeys` à chaque changement de participants.
        let toutes = self.gestion.lock().unwrap().toutes();
        for m in toutes {
            self.remettre(m);
        }
    }

    fn recevoir(&self, expediteur: &str, appareil: Option<&str>, contenu: &Value) {
        if !self.chiffre {
            return;
        }
        let Some(cle) = rtc::lire_cle(expediteur, contenu, self.salon.room_id().as_str()) else { return };
        if appareil.is_some_and(|a| a != cle.appareil) {
            log::warn!("[Sion][voix] clé de {expediteur} : appareil déclaré {} ≠ appareil réel, ignorée", cle.appareil);
            return;
        }
        let index = cle.index;
        let media = self.gestion.lock().unwrap().recevoir(cle, maintenant_local(), &self.membres);
        match media {
            Some(m) => {
                log::info!("[Sion][voix] clé {index} reçue de {}", m.identite);
                self.remettre(m);
            }
            None => log::info!("[Sion][voix] clé {index} de {expediteur} mise de côté (appartenance pas encore vue)"),
        }
    }
}

async fn session(mut etat: Etat, mut commandes: mpsc::UnboundedReceiver<Commande>, mut evenements: broadcast::Receiver<EvenementRtc>) {
    etat.annoncer().await;
    let debut = tokio::time::Instant::now();
    etat.suivre_membres(true).await;
    loop {
        let echeance = rtc::EXPIRATION_MS * etat.periodes - rtc::MARGE_RENOUVELLEMENT_MS;
        let renouvellement = debut + Duration::from_millis(echeance.max(0) as u64);
        tokio::select! {
            _ = tokio::time::sleep_until(renouvellement) => {
                // Comme `updateExpiryOnJoinedEvent` : une heure de plus,
                // même date de jonction.
                etat.periodes += 1;
                etat.annoncer().await;
            }
            commande = commandes.recv() => match commande {
                Some(Commande::Etat { muet, sourd }) => {
                    etat.muet = muet;
                    etat.sourd = sourd;
                    etat.annoncer().await;
                }
                Some(Commande::Republier) => {
                    etat.annoncer().await;
                    etat.gestion.lock().unwrap().tout_repartager();
                    etat.suivre_membres(true).await;
                }
                Some(Commande::Quitter(fait)) => {
                    etat.partir().await;
                    let _ = fait.send(());
                    return;
                }
                None => return,
            },
            ev = evenements.recv() => match ev {
                Ok(EvenementRtc::Synchro) | Err(broadcast::error::RecvError::Lagged(_)) => etat.suivre_membres(false).await,
                Ok(EvenementRtc::Cle { expediteur, appareil, contenu }) => etat.recevoir(&expediteur, appareil.as_deref(), &contenu),
                Err(broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

impl CoeurMatrix {
    /// Rejoint l'appel d'un salon : jeton du serveur média, appartenance
    /// publiée, clés échangées. La session précédente est quittée.
    pub async fn rejoindre_voix(&self, salon: &str) -> Resultat<ConnexionVoix> {
        Box::pin(self.rejoindre_voix_(salon, None)).await
    }

    /// Comme `rejoindre_voix`, sans jeton du serveur média (`url` et `jeton`
    /// vides) et avec le service donné : pour éprouver l'appartenance et les
    /// clés sans LiveKit.
    pub async fn rejoindre_appel_seul(&self, salon: &str, service: &str) -> Resultat<ConnexionVoix> {
        Box::pin(self.rejoindre_voix_(salon, Some(service))).await
    }

    async fn rejoindre_voix_(&self, salon: &str, service_impose: Option<&str>) -> Resultat<ConnexionVoix> {
        self.voix.terminer().await;
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let room = self.salon(salon).await?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        let appareil = client.device_id().ok_or(Erreur::PasDeSession)?.to_string();
        let (foyer, url, jeton) = match service_impose {
            Some(service) => (Foyer { service: service.to_owned(), alias: salon.to_owned() }, String::new(), String::new()),
            None => {
                let foyer = trouver_foyer(&client, &room).await?;
                let (url, jeton) = jeton_media(&client, &foyer).await?;
                (foyer, url, jeton)
            }
        };
        let chiffre = room.latest_encryption_state().await?.is_encrypted();
        let version = room.version().map(|v| v.to_string()).unwrap_or_default();
        let gestion = Arc::new(MutexSync::new(GestionCles::nouveau(&moi, &appareil)));
        let identite = rtc::identite(&moi, &appareil);
        log::info!("[Sion][voix] appel de {salon} rejoint ({} ; {})", foyer.service, if chiffre { "chiffré" } else { "en clair" });
        let etat = Etat {
            cle_etat: rtc::cle_etat(&moi, &appareil, &version),
            client,
            salon: room,
            moi,
            appareil,
            foyer,
            chiffre,
            muet: false,
            sourd: false,
            periodes: 1,
            cree: None,
            membres: Vec::new(),
            gestion: gestion.clone(),
            cles: self.voix.cles.clone(),
            horloge: self.horloge.clone(),
        };
        let (commandes, reception) = mpsc::unbounded_channel();
        let tache = tokio::spawn(session(etat, reception, self.voix.evenements.subscribe()));
        *self.voix.session.lock().await = Some(Session { salon: salon.to_owned(), commandes, gestion, tache });
        Ok(ConnexionVoix { salon: salon.to_owned(), url, jeton, chiffre, identite })
    }

    /// Quitte l'appel en cours (départ publié dans l'état du salon).
    pub async fn quitter_voix(&self) {
        self.voix.terminer().await;
    }

    /// Salon de l'appel en cours.
    pub async fn salon_voix(&self) -> Option<String> {
        self.voix.session.lock().await.as_ref().map(|s| s.salon.clone())
    }

    /// Mute et sourdine, annoncés dans l'appartenance (visibles depuis les
    /// autres salons, voir `buildCallMemberContent`).
    pub async fn etat_voix(&self, muet: bool, sourd: bool) -> bool {
        self.commande_voix(Commande::Etat { muet, sourd }).await
    }

    /// « On ne m'entend pas » : appartenance republiée, clé renouvelée et
    /// renvoyée à tous. `false` hors appel.
    pub async fn republier_voix(&self) -> bool {
        self.commande_voix(Commande::Republier).await
    }

    async fn commande_voix(&self, c: Commande) -> bool {
        self.voix.session.lock().await.as_ref().is_some_and(|s| s.commandes.send(c).is_ok())
    }

    /// Les clés des médias, à remettre au moteur LiveKit à mesure.
    pub fn cles_voix(&self) -> broadcast::Receiver<CleMedia> {
        self.voix.cles.subscribe()
    }

    /// Toutes les clés connues de l'appel en cours, pour un moteur média
    /// qui vient de démarrer.
    pub async fn cles_voix_connues(&self) -> Vec<CleMedia> {
        match self.voix.session.lock().await.as_ref() {
            Some(s) => s.gestion.lock().unwrap().toutes(),
            None => Vec::new(),
        }
    }
}
