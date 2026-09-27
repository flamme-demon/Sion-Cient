//! Cœur Matrix de Sion, bâti sur matrix-rust-sdk.
//!
//! Ce crate ne connaît ni Tauri ni la webview : il possède le client Matrix,
//! ses magasins SQLite chiffrés et la session, et publie un état de connexion
//! observable. L'application lui fournit un [`Coffre`] pour les secrets.
//! Plan et invariants : `docs/plan-matrix-rust-sdk.md`.
// Les futurs de matrix-sdk sont si imbriqués que le compilateur ne sait plus
// calculer la taille de ceux qui les attendent (« queries overflow the depth
// limit »). La limite est relevée ICI seulement : les méthodes publiques de
// `CoeurMatrix` rendent des futurs en boîte, que l'appli attend sans rien
// changer de son côté.
#![recursion_limit = "256"]
mod administration;
mod appels;
mod coeur;
mod coffre;
mod confiance;
mod emission;
mod envoi;
mod epingles;
mod fil;
mod fonctions_sion;
mod gestion;
mod horloge;
mod rtc;
mod medias;
mod membres;
mod messages;
mod salons;
mod session;
mod sion;
mod synchro;
mod voix;

pub use appels::UtilisateurVocal;
pub use coeur::{CoeurMatrix, EtatConnexion};
pub use coffre::{Coffre, CoffreMemoire};
pub use confiance::{EmojiSas, EtatVerification};
pub use envoi::InfosMedia;
pub use epingles::ResumeEpingle;
pub use fil::FilSalon;
pub use fonctions_sion::{EtatSalon, EvenementSion, ResultatSoundboard, SonAjoute};
pub use gestion::{Appareil, DetailsSalon, EtapesInscription, MembreSalon, ReponseServeur};
pub use medias::{type_mime, FormatMedia, PREFIXE_PAR_DEFAUT};
pub use messages::Message;
pub use rtc::CleMedia;
pub use salons::Salon;
pub use sion::{ChampVoix, Meme, Son, VersionMembre, Voix};
pub use voix::ConnexionVoix;

/// Erreurs du cœur, présentables telles quelles à l'interface.
#[derive(Debug, thiserror::Error)]
pub enum Erreur {
    #[error("aucune session active")]
    PasDeSession,
    #[error("serveur Matrix : {0}")]
    Matrix(#[from] matrix_sdk::Error),
    #[error("construction du client : {0}")]
    Construction(#[from] matrix_sdk::ClientBuildError),
    #[error("fichiers de session : {0}")]
    Fichiers(#[from] std::io::Error),
    #[error("session illisible : {0}")]
    Format(#[from] serde_json::Error),
    #[error("{0}")]
    Autre(String),
}

pub type Resultat<T> = Result<T, Erreur>;
