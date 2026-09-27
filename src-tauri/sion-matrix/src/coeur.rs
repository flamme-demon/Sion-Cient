//! Le client Matrix et son cycle de vie : connexion d'un nouvel appareil,
//! reprise de session, déconnexion, et un état de connexion observable.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::{OwnedDeviceId, RoomId, UserId};
use matrix_sdk::{Client, SessionMeta, SessionTokens};
use serde::Serialize;
use tokio::sync::{watch, Mutex};

use crate::fil::{self, FilSalon, Fils};
use crate::epingles::ResumeEpingle;
use crate::horloge::Horloge;
use crate::medias::{Medias, PREFIXE_PAR_DEFAUT};
use crate::salons::Salon;
use crate::session::{self, Secrets, Session, DOSSIER_MAGASIN};
use crate::synchro::{self, Publication};
use crate::{Coffre, Erreur, Resultat};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "etat", rename_all = "kebab-case")]
pub enum EtatConnexion {
    Deconnecte,
    Connexion,
    Connecte { utilisateur: String, appareil: String },
    /// Session conservée mais serveur injoignable, ou connexion refusée.
    Erreur { message: String },
}

pub struct CoeurMatrix {
    dossier: PathBuf,
    nom_appareil: String,
    coffre: Arc<dyn Coffre>,
    client: Mutex<Option<Client>>,
    etat: watch::Sender<EtatConnexion>,
    salons: watch::Sender<Vec<Salon>>,
    horloge: Arc<Horloge>,
    fils: Fils,
    /// Boucle de synchro : elle tient les magasins SQLite ouverts, elle doit
    /// donc s'arrêter AVANT tout effacement ou nouvelle connexion.
    synchro: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Rien d'automatique : le cœur ne doit jamais créer une nouvelle identité
/// de signature croisée ni une nouvelle sauvegarde sur un compte qui en a
/// déjà une. Seul un amorçage explicite (tranche T5) le fera.
fn reglages_chiffrement() -> EncryptionSettings {
    EncryptionSettings {
        auto_enable_cross_signing: false,
        backup_download_strategy: BackupDownloadStrategy::Manual,
        auto_enable_backups: false,
    }
}

fn synchro_immediate() -> SyncSettings {
    synchro::reglages(Duration::ZERO)
}

impl CoeurMatrix {
    /// `dossier` : réservé au cœur (session + magasins SQLite).
    pub fn nouveau(dossier: PathBuf, nom_appareil: impl Into<String>, coffre: Arc<dyn Coffre>) -> Self {
        Self {
            dossier,
            nom_appareil: nom_appareil.into(),
            coffre,
            client: Mutex::new(None),
            etat: watch::Sender::new(EtatConnexion::Deconnecte),
            salons: watch::Sender::new(Vec::new()),
            horloge: Arc::new(Horloge::default()),
            fils: Fils::nouveau(Arc::new(Medias::nouveau(PREFIXE_PAR_DEFAUT))),
            synchro: std::sync::Mutex::new(None),
        }
    }

    /// Préfixe des URL de médias (`sion-media://localhost/` par défaut ;
    /// `http://sion-media.localhost/` sous Windows et Android).
    pub fn avec_prefixe_medias(mut self, prefixe: impl Into<String>) -> Self {
        self.fils = Fils::nouveau(Arc::new(Medias::nouveau(prefixe)));
        self
    }

    /// Messages d'un salon, publiés à chaque changement.
    pub fn messages(&self) -> tokio::sync::broadcast::Receiver<FilSalon> {
        self.fils.abonner()
    }

    /// Dernière version publiée de tous les fils (chargement initial).
    pub fn fils_actuels(&self) -> Vec<FilSalon> {
        self.fils.tous()
    }

    pub(crate) async fn salon(&self, id: &str) -> Resultat<matrix_sdk::Room> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let id = RoomId::parse(id).map_err(|e| Erreur::Autre(e.to_string()))?;
        client.get_room(&id).ok_or_else(|| Erreur::Autre(format!("salon inconnu : {id}")))
    }

    /// Remonte l'historique d'un salon ; renvoie « il en reste ».
    pub async fn charger_historique(&self, salon: &str) -> Resultat<bool> {
        let salon = self.salon(salon).await?;
        // En boîte : voir `recursion_limit` dans lib.rs.
        Box::pin(self.fils.charger_historique(&salon)).await
    }

    /// Résumés des messages épinglés d'un salon, du plus récent au plus ancien.
    pub async fn epingles(&self, salon: &str) -> Resultat<Vec<ResumeEpingle>> {
        let salon = self.salon(salon).await?;
        Ok(Box::pin(self.fils.epingles(&salon)).await)
    }

    /// Accusé de lecture sur le dernier événement du salon.
    pub async fn marquer_lu(&self, salon: &str) -> Resultat<()> {
        Box::pin(fil::marquer_lu(&self.salon(salon).await?)).await;
        Ok(())
    }

    /// Contenu d'un média servi par `sion-media` (déchiffré s'il le faut).
    pub async fn media(&self, cle: &str, vignette: bool) -> Resultat<Vec<u8>> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        self.fils.medias.contenu(&client, cle, vignette).await
    }

    /// Liste des salons rejoints, republiée à chaque changement.
    pub fn salons(&self) -> watch::Receiver<Vec<Salon>> {
        self.salons.subscribe()
    }

    pub fn salons_actuels(&self) -> Vec<Salon> {
        self.salons.borrow().clone()
    }

    /// Écart de l'horloge locale avec le serveur, en minutes (0 sous 5 min).
    pub fn ecart_horloge_minutes(&self) -> i64 {
        self.horloge.ecart_minutes()
    }

    fn lancer_synchro(&self, client: Client) {
        let publication = Publication {
            salons: self.salons.clone(),
            etat: self.etat.clone(),
            horloge: self.horloge.clone(),
            fils: self.fils.clone(),
        };
        let tache = synchro::demarrer(client, self.dossier.clone(), publication);
        if let Some(ancienne) = self.synchro.lock().unwrap().replace(tache) {
            ancienne.abort();
        }
    }

    /// Arrête la boucle de synchro et attend qu'elle ait lâché le client.
    async fn arreter_synchro(&self) {
        let tache = self.synchro.lock().unwrap().take();
        if let Some(tache) = tache {
            tache.abort();
            let _ = tache.await;
        }
    }

    /// Fermeture de l'appli : la session est gardée pour la reprise suivante.
    pub async fn fermer(&self) {
        self.arreter_synchro().await;
        *self.client.lock().await = None;
    }

    pub fn etat(&self) -> watch::Receiver<EtatConnexion> {
        self.etat.subscribe()
    }

    pub fn etat_actuel(&self) -> EtatConnexion {
        self.etat.borrow().clone()
    }

    pub async fn client(&self) -> Option<Client> {
        self.client.lock().await.clone()
    }

    async fn construire(&self, serveur: &str, phrase: &str, url_connue: bool) -> Resultat<Client> {
        let constructeur = Client::builder();
        let constructeur = if url_connue {
            constructeur.homeserver_url(serveur)
        } else {
            constructeur.server_name_or_homeserver_url(serveur)
        };
        let client = constructeur
            .sqlite_store(self.dossier.join(DOSSIER_MAGASIN), Some(phrase))
            .with_encryption_settings(reglages_chiffrement())
            .build()
            .await?;
        // Le cache d'événements n'écoute que les synchros qui suivent son
        // activation : dès la construction, sinon le fil de la première
        // synchro lui échappe.
        client.event_cache().subscribe().map_err(|e| Erreur::Autre(e.to_string()))?;
        Ok(client)
    }

    fn publier_connecte(&self, client: &Client) {
        self.etat.send_replace(EtatConnexion::Connecte {
            utilisateur: client.user_id().map(|u| u.to_string()).unwrap_or_default(),
            appareil: client.device_id().map(|d| d.to_string()).unwrap_or_default(),
        });
    }

    /// Connexion par mot de passe, toujours comme **nouvel appareil** avec des
    /// magasins neufs : tout état local précédent est effacé.
    pub async fn connecter(&self, serveur: &str, identifiant: &str, mot_de_passe: &str) -> Resultat<()> {
        self.arreter_synchro().await;
        let mut garde = self.client.lock().await;
        drop(garde.take()); // libère SQLite avant d'effacer les magasins
        session::effacer(&self.dossier, &*self.coffre)?;
        self.salons.send_replace(Vec::new());
        self.fils.vider();
        self.etat.send_replace(EtatConnexion::Connexion);

        let phrase = session::phrase_aleatoire()?;
        let mut client_connecte: Option<Client> = None;
        let resultat = async {
            let client = self.construire(serveur, &phrase, false).await?;
            client
                .matrix_auth()
                .login_username(identifiant, mot_de_passe)
                .initial_device_display_name(&self.nom_appareil)
                .await?;
            client_connecte = Some(client.clone());
            let s = client.matrix_auth().session().ok_or(Erreur::PasDeSession)?;
            Session {
                serveur: client.homeserver().to_string(),
                utilisateur: s.meta.user_id.to_string(),
                appareil: s.meta.device_id.to_string(),
                secrets: Secrets {
                    jeton_acces: s.tokens.access_token,
                    jeton_rafraichissement: s.tokens.refresh_token,
                    phrase_magasin: phrase.clone(),
                },
            }
            .enregistrer(&self.dossier, &*self.coffre)?;
            // Première synchro : publie les clés du nouvel appareil.
            client.sync_once(synchro_immediate()).await?;
            Ok::<_, Erreur>(client)
        }
        .await;

        match resultat {
            Ok(client) => {
                log::info!(
                    "[Sion][matrix] connecté : {} (appareil {})",
                    client.user_id().map(|u| u.to_string()).unwrap_or_default(),
                    client.device_id().map(|d| d.to_string()).unwrap_or_default()
                );
                self.publier_connecte(&client);
                self.lancer_synchro(client.clone());
                *garde = Some(client);
                Ok(())
            }
            Err(e) => {
                // Connecté au serveur mais échec ensuite : ne pas laisser un
                // appareil orphelin sur le compte.
                if let Some(client) = client_connecte {
                    let _ = client.matrix_auth().logout().await;
                }
                let _ = session::effacer(&self.dossier, &*self.coffre);
                self.etat.send_replace(EtatConnexion::Erreur { message: e.to_string() });
                Err(e)
            }
        }
    }

    /// Reprend la session sauvegardée. `Ok(false)` s'il n'y en a pas ou si
    /// elle n'est plus valable (jeton révoqué, magasin disparu) ; hors ligne,
    /// la session est gardée et l'état passe en erreur.
    pub async fn reprendre(&self) -> Resultat<bool> {
        // Idempotent : une session qui tourne déjà n'est pas relancée. (En
        // développement, React monte l'écran deux fois : sans cela, la
        // synchro repartait de zéro au second appel.)
        // La vérification se fait SOUS le verrou, tenu jusqu'au bout : deux
        // appels simultanés ne passent pas tous les deux.
        let mut garde = self.client.lock().await;
        if garde.is_some() {
            return Ok(true);
        }
        self.arreter_synchro().await;
        let Some(s) = Session::charger(&self.dossier, &*self.coffre)? else {
            self.etat.send_replace(EtatConnexion::Deconnecte);
            return Ok(false);
        };
        self.etat.send_replace(EtatConnexion::Connexion);

        let client = self.construire(&s.serveur, &s.secrets.phrase_magasin, true).await?;
        let utilisateur = UserId::parse(&s.utilisateur).map_err(|e| Erreur::Autre(e.to_string()))?;
        client
            .restore_session(MatrixSession {
                meta: SessionMeta { user_id: utilisateur, device_id: OwnedDeviceId::from(s.appareil.as_str()) },
                tokens: SessionTokens {
                    access_token: s.secrets.jeton_acces.clone(),
                    refresh_token: s.secrets.jeton_rafraichissement.clone(),
                },
            })
            .await?;

        match client.sync_once(synchro_immediate()).await {
            Ok(_) => {
                self.publier_connecte(&client);
                self.lancer_synchro(client.clone());
                *garde = Some(client);
                Ok(true)
            }
            Err(e) if matches!(e.client_api_error_kind(), Some(ErrorKind::UnknownToken(_))) => {
                log::warn!("[Sion][matrix] jeton révoqué : session abandonnée");
                drop(client);
                session::effacer(&self.dossier, &*self.coffre)?;
                self.etat.send_replace(EtatConnexion::Deconnecte);
                Ok(false)
            }
            Err(e) => {
                log::warn!("[Sion][matrix] reprise hors ligne : {e}");
                self.etat.send_replace(EtatConnexion::Erreur { message: e.to_string() });
                // La boucle réessaie et repassera « connecté » au retour du réseau.
                self.lancer_synchro(client.clone());
                *garde = Some(client);
                Ok(true)
            }
        }
    }

    /// Déconnexion : l'appareil est supprimé côté serveur, puis la session et
    /// les magasins locaux sont effacés.
    pub async fn deconnecter(&self) -> Resultat<()> {
        self.arreter_synchro().await;
        let mut garde = self.client.lock().await;
        if let Some(client) = garde.take() {
            if let Err(e) = client.matrix_auth().logout().await {
                log::warn!("[Sion][matrix] déconnexion côté serveur impossible : {e}");
            }
        }
        session::effacer(&self.dossier, &*self.coffre)?;
        self.salons.send_replace(Vec::new());
        self.fils.vider();
        self.etat.send_replace(EtatConnexion::Deconnecte);
        Ok(())
    }
}

impl Drop for CoeurMatrix {
    fn drop(&mut self) {
        if let Some(tache) = self.synchro.get_mut().ok().and_then(Option::take) {
            tache.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoffreMemoire;

    fn coeur(dossier: &std::path::Path) -> CoeurMatrix {
        CoeurMatrix::nouveau(dossier.to_path_buf(), "Sion test", Arc::new(CoffreMemoire::default()))
    }

    #[tokio::test]
    async fn sans_session_la_reprise_rend_faux_et_l_etat_est_deconnecte() {
        let d = tempfile::tempdir().unwrap();
        let c = coeur(d.path());
        assert!(!c.reprendre().await.unwrap());
        assert_eq!(c.etat_actuel(), EtatConnexion::Deconnecte);
        assert!(c.client().await.is_none());
    }

    #[tokio::test]
    async fn deux_reprises_simultanees_ne_casse_rien() {
        let d = tempfile::tempdir().unwrap();
        let c = Arc::new(coeur(d.path()));
        let (a, b) = tokio::join!(c.reprendre(), c.reprendre());
        assert!(!a.unwrap() && !b.unwrap());
    }

    #[tokio::test]
    async fn reprendre_deux_fois_de_suite_ne_casse_rien() {
        let d = tempfile::tempdir().unwrap();
        let c = coeur(d.path());
        assert!(!c.reprendre().await.unwrap());
        assert!(!c.reprendre().await.unwrap());
        assert_eq!(c.etat_actuel(), EtatConnexion::Deconnecte);
    }

    #[tokio::test]
    async fn la_deconnexion_sans_client_efface_quand_meme() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(session::FICHIER_SESSION), b"{}").unwrap();
        let c = coeur(d.path());
        c.deconnecter().await.unwrap();
        assert!(!d.path().join(session::FICHIER_SESSION).exists());
        assert_eq!(c.etat_actuel(), EtatConnexion::Deconnecte);
    }

    #[test]
    fn l_etat_se_serialise_pour_l_interface() {
        let etat = EtatConnexion::Connecte { utilisateur: "@a:b".into(), appareil: "X".into() };
        assert_eq!(
            serde_json::to_string(&etat).unwrap(),
            r#"{"etat":"connecte","utilisateur":"@a:b","appareil":"X"}"#
        );
    }
}
