//! Cœur Matrix de Sion, bâti sur matrix-rust-sdk.
//!
//! Ce crate ne connaît ni Tauri ni la webview : il possède le client Matrix,
//! ses magasins SQLite chiffrés et la session, et publie un état de connexion
//! observable. L'application lui fournit un [`Coffre`] pour les secrets.
//! Plan et invariants : `docs/plan-matrix-rust-sdk.md`.
mod coeur;
mod coffre;
mod session;

pub use coeur::{CoeurMatrix, EtatConnexion};
pub use coffre::{Coffre, CoffreMemoire};

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
