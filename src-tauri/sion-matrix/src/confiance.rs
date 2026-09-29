//! Chiffrement et confiance (tranche T5) : vérification par emojis entre
//! deux appareils du compte, récupération par clé, restauration de la
//! sauvegarde des clés, amorçage d'un compte neuf.
//!
//! La vérification suit la machine à états de `useMatrixStore.ts`
//! (`startCrossDeviceVerification`, `VerificationRequestReceived`) et publie
//! les mêmes étapes : `idle`, `requesting`, `waiting`, `comparing`,
//! `confirmed`, `done`, `cancelled`, `error`.
//!
//! QR code (standard Matrix, `m.qr_code.*`) : quand les deux appareils le
//! permettent — l'un affiche, l'autre a une caméra (téléphone) —, l'étape
//! `pret` propose le QR et laisse le choix des emojis ; l'appareil qui a
//! affiché le QR confirme ensuite le scan (`qr-scanne`), l'autre attend
//! (`qr-attente`). Sans QR possible, les emojis partent d'office, comme avant.
//!
//! Invariant : l'amorçage (`amorcer`) REFUSE de s'exécuter si le compte a déjà
//! un stockage de secrets — il remplacerait l'identité de signature croisée et
//! la sauvegarde existantes (voir docs/plan-matrix-rust-sdk.md).
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use matrix_sdk::encryption::verification::{
    QrVerification, QrVerificationData, QrVerificationState, SasState, SasVerification, Verification, VerificationRequest,
    VerificationRequestState,
};
use matrix_sdk::ruma::events::key::verification::VerificationMethod;
use std::sync::atomic::{AtomicBool, Ordering};
use matrix_sdk::deserialized_responses::TimelineEventKind;
use matrix_sdk::event_cache::DecryptionRetryRequest;
use matrix_sdk::event_handler::Ctx;
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::coeur::CoeurMatrix;
use crate::{Erreur, Resultat};

/// Un emoji de la comparaison (`EmojiData` du JS).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EmojiSas {
    pub emoji: String,
    pub name: String,
}

/// État de la vérification publié à l'interface.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct EtatVerification {
    pub etape: &'static str,
    pub emojis: Vec<EmojiSas>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub erreur: Option<String>,
    /// Étape `pret` : QR code à afficher (octets `m.qr_code`, en base64).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr: Option<String>,
    /// Étape `pret` : cet appareil peut scanner le QR de l'autre.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub scanner: bool,
}

impl EtatVerification {
    fn etape(etape: &'static str) -> Self {
        Self { etape, ..Self::default() }
    }

    fn erreur(e: impl ToString) -> Self {
        Self { etape: "error", erreur: Some(e.to_string()), ..Self::default() }
    }

    /// Une vérification est-elle en cours (une nouvelle demande reçue est
    /// alors ignorée, comme le JS) ?
    fn occupe(&self) -> bool {
        !matches!(self.etape, "idle" | "cancelled" | "error" | "done")
    }
}

pub(crate) struct Confiance {
    etat: watch::Sender<EtatVerification>,
    requete: Mutex<Option<VerificationRequest>>,
    sas: Mutex<Option<SasVerification>>,
    qr: Mutex<Option<QrVerification>>,
    /// Cet appareil a une caméra (téléphone) : il peut scanner un QR.
    camera: AtomicBool,
}

impl Confiance {
    pub fn nouvelle() -> Arc<Self> {
        Arc::new(Self {
            etat: watch::Sender::new(EtatVerification::etape("idle")),
            requete: Mutex::default(),
            sas: Mutex::default(),
            qr: Mutex::default(),
            camera: AtomicBool::new(false),
        })
    }

    /// Méthodes annoncées : emojis toujours ; QR affiché partout ; scanné
    /// seulement avec une caméra.
    fn methodes(&self) -> Vec<VerificationMethod> {
        let mut m = vec![VerificationMethod::SasV1, VerificationMethod::QrCodeShowV1, VerificationMethod::ReciprocateV1];
        if self.camera.load(Ordering::Relaxed) {
            m.push(VerificationMethod::QrCodeScanV1);
        }
        m
    }

    fn publier(&self, etat: EtatVerification) {
        self.etat.send_replace(etat);
    }

    pub fn oublier(&self) {
        self.requete.lock().unwrap().take();
        self.sas.lock().unwrap().take();
        self.qr.lock().unwrap().take();
        self.publier(EtatVerification::etape("idle"));
    }

    /// Branche la réception des demandes de vérification sur ce client.
    pub fn brancher(self: &Arc<Self>, client: &Client) {
        client.add_event_handler_context(self.clone());
        client.add_event_handler(
            |ev: ToDeviceKeyVerificationRequestEvent, client: Client, confiance: Ctx<Arc<Confiance>>| async move {
                confiance.0.demande_recue(&client, ev).await;
            },
        );
    }

    /// Demande venue d'un autre appareil du compte (Element, ou une autre
    /// instance de Sion) : acceptée, puis suivie.
    async fn demande_recue(self: &Arc<Self>, client: &Client, ev: ToDeviceKeyVerificationRequestEvent) {
        if Some(ev.sender.as_ref()) != client.user_id() || self.etat.borrow().occupe() {
            return;
        }
        let Some(requete) = client.encryption().get_verification_request(&ev.sender, &ev.content.transaction_id).await else {
            return;
        };
        self.requete.lock().unwrap().replace(requete.clone());
        self.sas.lock().unwrap().take();
        self.qr.lock().unwrap().take();
        self.publier(EtatVerification::etape("waiting"));
        if let Err(e) = requete.accept_with_methods(self.methodes()).await {
            log::error!("[Sion][matrix] vérification entrante non acceptée : {e}");
            self.publier(EtatVerification::erreur(e));
            return;
        }
        tokio::spawn(self.clone().suivre_requete(client.clone(), requete, false));
    }

    /// Suit une demande jusqu'à son issue. Prêts des deux côtés : QR proposé
    /// si l'un affiche et l'autre scanne (`pret`), sinon l'initiateur lance
    /// la comparaison par emojis. Celui qui n'a pas lancé les emojis les
    /// accepte.
    async fn suivre_requete(self: Arc<Self>, client: Client, requete: VerificationRequest, initiateur: bool) {
        // L'état présent d'abord : celui qui accepte une demande est déjà
        // « prêt » au retour de `accept`, avant ce suivi. Abonné avant de le
        // lire, rien ne se perd ; `pret_vu` évite de traiter « prêt » deux fois.
        let changements = requete.changes();
        let mut etats = futures_util::stream::iter([requete.state()]).chain(changements);
        let mut pret_vu = false;
        while let Some(etat) = etats.next().await {
            match etat {
                VerificationRequestState::Ready { .. } if pret_vu => {}
                VerificationRequestState::Ready { .. } => {
                    pret_vu = true;
                    let leurs = requete.their_supported_methods().unwrap_or_default();
                    let scanner =
                        self.camera.load(Ordering::Relaxed) && leurs.contains(&VerificationMethod::QrCodeShowV1);
                    // L'autre sait scanner : on affiche notre QR.
                    let qr = if leurs.contains(&VerificationMethod::QrCodeScanV1) {
                        match requete.generate_qr_code().await {
                            Ok(Some(qr)) => {
                                let octets = qr.to_bytes().ok();
                                self.qr.lock().unwrap().replace(qr.clone());
                                tokio::spawn(self.clone().suivre_qr(client.clone(), qr));
                                octets.map(|o| {
                                    use base64::Engine as _;
                                    base64::engine::general_purpose::STANDARD.encode(o)
                                })
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                    if qr.is_some() || scanner {
                        self.publier(EtatVerification { etape: "pret", qr, scanner, ..EtatVerification::default() });
                    } else if initiateur {
                        if let Err(e) = requete.start_sas().await {
                            self.publier(EtatVerification::erreur(e));
                            return;
                        }
                    }
                }
                VerificationRequestState::Transitioned { verification: Verification::SasV1(sas) } => {
                    if !sas.we_started() {
                        if let Err(e) = sas.accept().await {
                            self.publier(EtatVerification::erreur(e));
                            return;
                        }
                    }
                    self.sas.lock().unwrap().replace(sas.clone());
                    tokio::spawn(self.clone().suivre_sas(client.clone(), sas));
                }
                VerificationRequestState::Transitioned { verification: Verification::QrV1(qr) } => {
                    // Notre QR, déjà suivi, ou celui qu'on vient de scanner.
                    let deja = self.qr.lock().unwrap().as_ref().map(|q| q.we_started() == qr.we_started());
                    if deja != Some(true) {
                        self.qr.lock().unwrap().replace(qr.clone());
                        tokio::spawn(self.clone().suivre_qr(client.clone(), qr));
                    }
                }
                VerificationRequestState::Done => {
                    self.termine(&client).await;
                    return;
                }
                VerificationRequestState::Cancelled(info) => {
                    log::info!("[Sion][matrix] vérification annulée : {}", info.reason());
                    if self.etat.borrow().etape != "done" {
                        self.publier(EtatVerification::etape("cancelled"));
                    }
                    return;
                }
                _ => {}
            }
        }
    }

    /// QR : l'appareil qui l'a affiché confirme le scan (`qr-scanne`) ;
    /// celui qui a scanné attend cette confirmation (`qr-attente`).
    async fn suivre_qr(self: Arc<Self>, client: Client, qr: QrVerification) {
        let mut changements = qr.changes();
        while let Some(etat) = changements.next().await {
            match etat {
                QrVerificationState::Scanned => self.publier(EtatVerification::etape("qr-scanne")),
                QrVerificationState::Reciprocated => self.publier(EtatVerification::etape("qr-attente")),
                QrVerificationState::Done { .. } => {
                    self.termine(&client).await;
                    return;
                }
                QrVerificationState::Cancelled(_) => {
                    if self.etat.borrow().etape != "done" {
                        self.publier(EtatVerification::etape("cancelled"));
                    }
                    return;
                }
                _ => {}
            }
        }
    }

    async fn suivre_sas(self: Arc<Self>, client: Client, sas: SasVerification) {
        let mut changements = sas.changes();
        while let Some(etat) = changements.next().await {
            match etat {
                SasState::KeysExchanged { emojis: Some(e), .. } => {
                    let emojis = e.emojis.iter().map(|x| EmojiSas { emoji: x.symbol.to_owned(), name: x.description.to_owned() }).collect();
                    self.publier(EtatVerification { etape: "comparing", emojis, ..EtatVerification::default() });
                }
                SasState::Done { .. } => {
                    self.termine(&client).await;
                    return;
                }
                SasState::Cancelled(_) => {
                    if self.etat.borrow().etape != "done" {
                        self.publier(EtatVerification::etape("cancelled"));
                    }
                    return;
                }
                _ => {}
            }
        }
    }

    /// Vérification réussie : comme le JS, restauration de la sauvegarde avec
    /// les secrets reçus de l'autre appareil.
    async fn termine(&self, client: &Client) {
        if self.etat.borrow().etape == "done" {
            return;
        }
        self.publier(EtatVerification::etape("done"));
        attendre_la_cle_de_sauvegarde(client).await;
        match telecharger_la_sauvegarde(client).await {
            Ok(n) => log::info!("[Sion][matrix] après vérification : clés de {n} salon(s) restaurées"),
            Err(e) => log::warn!("[Sion][matrix] après vérification : restauration impossible ({e})"),
        }
    }
}

/// La clé de la sauvegarde arrive de l'autre appareil (`m.secret.send`) un peu
/// APRÈS la fin de la vérification : téléchargée aussitôt, la sauvegarde
/// n'était pas encore active et rien n'était restauré (29/09, téléphone :
/// « clés de 0 salon(s) restaurées », historique chiffré illisible).
const ATTENTE_CLE_SAUVEGARDE: std::time::Duration = std::time::Duration::from_secs(30);

async fn attendre_la_cle_de_sauvegarde(client: &Client) {
    let sauvegardes = client.encryption().backups();
    let debut = std::time::Instant::now();
    while !sauvegardes.are_enabled().await {
        if debut.elapsed() >= ATTENTE_CLE_SAUVEGARDE {
            log::warn!("[Sion][matrix] après vérification : clé de la sauvegarde toujours absente après 30 s");
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    log::info!("[Sion][matrix] après vérification : clé de la sauvegarde reçue en {} ms", debut.elapsed().as_millis());
}

/// Télécharge les clés de la sauvegarde pour tous les salons chiffrés
/// rejoints ; rend le nombre de salons traités (0 si la sauvegarde n'est pas
/// utilisable ici). Le cache d'événements re-déchiffre ensuite de lui-même.
async fn telecharger_la_sauvegarde(client: &Client) -> Resultat<usize> {
    let sauvegardes = client.encryption().backups();
    if !sauvegardes.are_enabled().await {
        return Ok(0);
    }
    let mut n = 0;
    for salon in client.joined_rooms() {
        if !salon.latest_encryption_state().await.map(|e| e.is_encrypted()).unwrap_or(false) {
            continue;
        }
        match sauvegardes.download_room_keys_for_room(salon.room_id()).await {
            Ok(()) => {
                n += 1;
                relancer_dechiffrement(client, &salon).await;
            }
            Err(e) => log::warn!("[Sion][matrix] clés de {} non restaurées : {e}", salon.room_id()),
        }
    }
    Ok(n)
}

/// Demande au re-déchiffreur du cache d'événements de retenter les messages
/// indéchiffrables d'un salon. Nécessaire après un import depuis la
/// sauvegarde : la clé est bien là (le déchiffrement direct réussit), mais le
/// re-déchiffreur ne s'en aperçoit pas de lui-même — constaté sur le banc
/// local, le fil restait « 🔒 » indéfiniment.
async fn relancer_dechiffrement(client: &Client, salon: &matrix_sdk::Room) {
    let Ok((cache, _)) = salon.event_cache().await else { return };
    let sessions: BTreeSet<String> = cache
        .events()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|e| matches!(e.kind, TimelineEventKind::UnableToDecrypt { .. }))
        .filter_map(|e| e.raw().get_field::<Value>("content").ok().flatten())
        .filter_map(|c| c.get("session_id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    if sessions.is_empty() {
        return;
    }
    client.event_cache().request_decryption(DecryptionRetryRequest {
        room_id: salon.room_id().to_owned(),
        utd_session_ids: sessions,
        refresh_info_session_ids: BTreeSet::new(),
    });
}

fn recuperation(e: matrix_sdk::encryption::recovery::RecoveryError) -> Erreur {
    Erreur::Autre(e.to_string())
}

/// Le compte a-t-il déjà un stockage de secrets ? Demandé au SERVEUR : le
/// magasin local n'apprend l'account data qu'à la synchro suivante — un
/// second amorçage, juste après le premier, passait (vu sur le banc local).
/// Dans le doute (serveur injoignable), on répond oui : mieux vaut refuser un
/// amorçage que remplacer une identité.
async fn stockage_de_secrets_present(client: &Client) -> bool {
    match client.account().fetch_account_data(GlobalAccountDataEventType::SecretStorageDefaultKey).await {
        Ok(contenu) => contenu.and_then(|brut| brut.get_field::<String>("key").ok().flatten()).is_some(),
        Err(e) => {
            log::warn!("[Sion][matrix] stockage de secrets : serveur injoignable ({e}), supposé présent");
            true
        }
    }
}

/// Le compte a-t-il déjà une identité de signature croisée ? Demandé au
/// serveur, même prudence.
async fn identite_presente(client: &Client) -> bool {
    let Some(moi) = client.user_id() else { return true };
    client.encryption().request_user_identity(moi).await.map(|i| i.is_some()).unwrap_or(true)
}

// Chaque méthode publique rend un futur en boîte (voir `recursion_limit`
// dans lib.rs).
impl CoeurMatrix {
    /// Suit l'état de la vérification.
    pub fn verification(&self) -> watch::Receiver<EtatVerification> {
        self.confiance.etat.subscribe()
    }

    pub fn verification_actuelle(&self) -> EtatVerification {
        self.confiance.etat.borrow().clone()
    }

    /// Lance la vérification de cet appareil par un autre appareil du compte
    /// (`startCrossDeviceVerification`).
    pub async fn demarrer_verification(&self) -> Resultat<()> {
        Box::pin(self.demarrer_verification_()).await
    }

    async fn demarrer_verification_(&self) -> Resultat<()> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_owned();
        self.confiance.requete.lock().unwrap().take();
        self.confiance.sas.lock().unwrap().take();
        self.confiance.qr.lock().unwrap().take();
        self.confiance.publier(EtatVerification::etape("requesting"));
        let resultat = async {
            let chiffrement = client.encryption();
            let connue = chiffrement.get_user_identity(&moi).await.map_err(|e| Erreur::Autre(e.to_string()))?;
            // Juste après une connexion (par QR code), l'identité n'est pas
            // encore arrivée par la synchro : on la demande au serveur.
            let identite = match connue {
                Some(i) => Some(i),
                None => chiffrement.request_user_identity(&moi).await.map_err(|e| Erreur::Autre(e.to_string()))?,
            }
            .ok_or_else(|| Erreur::Autre("ce compte n'a pas d'identité de signature croisée".into()))?;
            identite.request_verification_with_methods(self.confiance.methodes()).await.map_err(|e| Erreur::Autre(e.to_string()))
        }
        .await;
        match resultat {
            Ok(requete) => {
                self.confiance.requete.lock().unwrap().replace(requete.clone());
                self.confiance.publier(EtatVerification::etape("waiting"));
                tokio::spawn(self.confiance.clone().suivre_requete(client, requete, true));
                Ok(())
            }
            Err(e) => {
                self.confiance.publier(EtatVerification::erreur(&e));
                Err(e)
            }
        }
    }

    /// Les emojis concordent (`confirmVerificationEmojis`).
    pub async fn confirmer_emojis(&self) -> Resultat<()> {
        let sas = self.confiance.sas.lock().unwrap().clone();
        let Some(sas) = sas else { return Ok(()) };
        self.confiance.publier(EtatVerification::etape("confirmed"));
        if let Err(e) = Box::pin(sas.confirm()).await {
            self.confiance.publier(EtatVerification::erreur(&e));
            return Err(e.into());
        }
        Ok(())
    }

    /// Les emojis diffèrent (`rejectVerificationEmojis`).
    pub async fn refuser_emojis(&self) -> Resultat<()> {
        let sas = self.confiance.sas.lock().unwrap().take();
        if let Some(sas) = sas {
            Box::pin(sas.mismatch()).await?;
        }
        self.confiance.requete.lock().unwrap().take();
        self.confiance.publier(EtatVerification::etape("cancelled"));
        Ok(())
    }

    /// Cet appareil a une caméra (téléphone) : il annonce qu'il sait scanner
    /// un QR de vérification.
    pub fn definir_camera(&self, camera: bool) {
        self.confiance.camera.store(camera, Ordering::Relaxed);
    }

    /// Étape `pret` : comparer des emojis plutôt que le QR.
    pub async fn verification_emojis(&self) -> Resultat<()> {
        let requete = self.confiance.requete.lock().unwrap().clone();
        let Some(requete) = requete else { return Ok(()) };
        if let Err(e) = Box::pin(requete.start_sas()).await {
            self.confiance.publier(EtatVerification::erreur(&e));
            return Err(e.into());
        }
        Ok(())
    }

    /// Étape `pret` : le QR de l'autre appareil vient d'être scanné.
    pub async fn verification_scanner(&self, octets: &[u8]) -> Resultat<()> {
        let requete = self.confiance.requete.lock().unwrap().clone();
        let Some(requete) = requete else { return Err(Erreur::Autre("aucune vérification en cours".into())) };
        let donnees = QrVerificationData::from_bytes(octets)
            .map_err(|e| Erreur::Autre(format!("ce QR code n'est pas un QR de vérification Matrix ({e})")))?;
        match Box::pin(requete.scan_qr_code(donnees)).await {
            Ok(Some(qr)) => {
                self.confiance.qr.lock().unwrap().replace(qr);
                self.confiance.publier(EtatVerification::etape("qr-attente"));
                Ok(())
            }
            Ok(None) => Err(Erreur::Autre("QR refusé".into())),
            Err(e) => {
                self.confiance.publier(EtatVerification::erreur(&e));
                Err(e.into())
            }
        }
    }

    /// Étape `qr-scanne` : l'autre appareil a bien scanné NOTRE QR (il
    /// l'affiche) — on confirme, la vérification aboutit.
    pub async fn verification_confirmer_qr(&self) -> Resultat<()> {
        let qr = self.confiance.qr.lock().unwrap().clone();
        let Some(qr) = qr else { return Ok(()) };
        self.confiance.publier(EtatVerification::etape("confirmed"));
        if let Err(e) = Box::pin(qr.confirm()).await {
            self.confiance.publier(EtatVerification::erreur(&e));
            return Err(e.into());
        }
        Ok(())
    }

    /// Abandon (`cancelVerification`).
    pub async fn annuler_verification(&self) -> Resultat<()> {
        let requete = self.confiance.requete.lock().unwrap().take();
        self.confiance.sas.lock().unwrap().take();
        self.confiance.qr.lock().unwrap().take();
        if let Some(r) = requete {
            let _ = Box::pin(r.cancel()).await;
        }
        self.confiance.publier(EtatVerification::etape("idle"));
        Ok(())
    }

    /// Cet appareil est-il vérifié (`checkDeviceVerified`) : l'identité de
    /// signature croisée du compte lui est-elle de confiance ?
    pub async fn appareil_verifie(&self) -> Resultat<bool> {
        Box::pin(self.appareil_verifie_()).await
    }

    async fn appareil_verifie_(&self) -> Resultat<bool> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_owned();
        Ok(client.encryption().get_user_identity(&moi).await.ok().flatten().is_some_and(|i| i.is_verified()))
    }

    /// Des messages indéchiffrables dans les fils chargés
    /// (`hasUndecryptableMessages`) ?
    pub fn messages_indechiffrables(&self) -> bool {
        self.fils_actuels().iter().flat_map(|f| &f.messages).any(|m| m.msgtype.as_deref() == Some("m.encrypted"))
    }

    /// Récupération par la clé de récupération (`restoreKeyBackup`) : secrets
    /// importés (l'appareil devient vérifié), puis clés de la sauvegarde.
    /// Rend le nombre de salons dont les clés ont été restaurées.
    pub async fn restaurer_par_cle(&self, cle: &str) -> Resultat<usize> {
        Box::pin(self.restaurer_par_cle_(cle)).await
    }

    async fn restaurer_par_cle_(&self, cle: &str) -> Resultat<usize> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        client.encryption().recovery().recover(cle.trim()).await.map_err(recuperation)?;
        telecharger_la_sauvegarde(&client).await
    }

    /// Restauration avec les secrets déjà reçus d'un autre appareil
    /// (`tryAutoRestoreKeyBackup`).
    pub async fn restaurer_automatiquement(&self) -> Resultat<usize> {
        Box::pin(self.restaurer_automatiquement_()).await
    }

    async fn restaurer_automatiquement_(&self) -> Resultat<usize> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        telecharger_la_sauvegarde(&client).await
    }

    /// Le compte doit-il être amorcé (`checkNeedsBootstrap`) ? Jamais s'il a
    /// déjà un stockage de secrets : c'est alors un nouvel appareil, qui se
    /// vérifie, il ne se réamorce pas.
    pub async fn a_besoin_amorcage(&self) -> Resultat<bool> {
        Box::pin(self.a_besoin_amorcage_()).await
    }

    async fn a_besoin_amorcage_(&self) -> Resultat<bool> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        if stockage_de_secrets_present(&client).await || identite_presente(&client).await {
            return Ok(false);
        }
        let signature_complete = client.encryption().cross_signing_status().await.is_some_and(|s| s.is_complete());
        Ok(!signature_complete || client.encryption().recovery().state() != matrix_sdk::encryption::recovery::RecoveryState::Enabled)
    }

    /// Amorçage d'un compte neuf (`bootstrapAll`) : signature croisée
    /// (authentifiée par le mot de passe), stockage de secrets et sauvegarde.
    /// Rend la clé de récupération. REFUSE si un stockage de secrets existe.
    pub async fn amorcer(&self, mot_de_passe: Option<&str>) -> Resultat<String> {
        Box::pin(self.amorcer_(mot_de_passe)).await
    }

    async fn amorcer_(&self, mot_de_passe: Option<&str>) -> Resultat<String> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        if stockage_de_secrets_present(&client).await || identite_presente(&client).await {
            return Err(Erreur::Autre(
                "ce compte a déjà une identité ou un stockage de secrets : l'amorcer les remplacerait (refusé)".into(),
            ));
        }
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        if let Err(e) = client.encryption().bootstrap_cross_signing(None).await {
            let Some(session) = e.as_uiaa_response().and_then(|i| i.session.clone()) else { return Err(e.into()) };
            let mut auth = json!({ "type": "m.login.password", "identifier": { "type": "m.id.user", "user": moi }, "session": session });
            if let Some(m) = mot_de_passe {
                auth["password"] = m.into();
            }
            client.encryption().bootstrap_cross_signing(Some(serde_json::from_value(auth)?)).await?;
        }
        client.encryption().recovery().enable().await.map_err(recuperation)
    }

    /// Nouvelle clé de récupération (`regenerateRecoveryKey`). Le JS
    /// recréait aussi la sauvegarde ; ici les secrets et la sauvegarde sont
    /// gardés, seule la clé qui les protège change.
    pub async fn nouvelle_cle_recuperation(&self) -> Resultat<String> {
        Box::pin(self.nouvelle_cle_recuperation_()).await
    }

    async fn nouvelle_cle_recuperation_(&self) -> Resultat<String> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        client.encryption().recovery().reset_key().await.map_err(recuperation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn une_verification_en_cours_bloque_les_nouvelles_demandes() {
        for etape in ["requesting", "waiting", "comparing", "confirmed"] {
            assert!(EtatVerification::etape(etape).occupe(), "{etape}");
        }
        for etape in ["idle", "cancelled", "done"] {
            assert!(!EtatVerification::etape(etape).occupe(), "{etape}");
        }
        assert!(!EtatVerification::erreur("x").occupe());
    }

    #[test]
    fn etat_serialise_comme_le_store_js() {
        let e = EtatVerification { etape: "comparing", emojis: vec![EmojiSas { emoji: "🐶".into(), name: "Dog".into() }], ..EtatVerification::default() };
        assert_eq!(serde_json::to_value(&e).unwrap(), json!({ "etape": "comparing", "emojis": [{ "emoji": "🐶", "name": "Dog" }] }));
    }

    #[test]
    fn etat_pret_avec_qr_et_scanner() {
        let e = EtatVerification { etape: "pret", qr: Some("TUFUUklY".into()), scanner: true, ..EtatVerification::default() };
        assert_eq!(serde_json::to_value(&e).unwrap(), json!({ "etape": "pret", "emojis": [], "qr": "TUFUUklY", "scanner": true }));
        // Sans QR ni caméra, rien de plus que les champs d'origine.
        assert_eq!(serde_json::to_value(EtatVerification::etape("waiting")).unwrap(), json!({ "etape": "waiting", "emojis": [] }));
    }
}
