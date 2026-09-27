//! Étape 4 : reprendre l'appareil du moteur JS sur un nouvel appareil du
//! cœur, sans rien perdre. L'ancien moteur exporte (côté interface,
//! `migrationMoteur.ts`) son paquet de secrets et ses clés de salons ; le
//! cœur les importe juste après la connexion, avant la première synchro.
//!
//! Chaque morceau est facultatif et best-effort : un ancien appareil jamais
//! vérifié n'a pas de secrets à donner, et la connexion doit aboutir quand
//! même — l'appareil sera alors vérifié comme d'habitude.
use std::path::Path;

use matrix_sdk::Client;
use matrix_sdk_crypto::olm::ExportedRoomKey;
use matrix_sdk_crypto::types::SecretsBundle;
use serde::Serialize;
use serde_json::Value;

/// Ce que l'ancien moteur a exporté.
#[derive(Clone, Debug, Default)]
pub struct ImportMigration {
    /// `exportSecretsBundle()` de matrix-js-sdk.
    pub secrets: Option<Value>,
    /// `exportRoomKeysAsJson()` de matrix-js-sdk.
    pub cles_salons: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RapportMigration {
    /// Signature croisée (et sauvegarde) reprises : appareil vérifié.
    pub secrets_importes: bool,
    pub cles_importees: usize,
    pub cles_total: usize,
}

/// Tours de dérivation du fichier d'export : il ne quitte jamais le dossier
/// privé du cœur et sa phrase est aléatoire, pas besoin des 500 000 d'un
/// export fait pour être stocké.
const TOURS_EXPORT: u32 = 10_000;

pub(crate) async fn importer(client: &Client, dossier: &Path, import: &ImportMigration) -> RapportMigration {
    let mut rapport = RapportMigration::default();
    if let Some(secrets) = &import.secrets {
        match serde_json::from_value::<SecretsBundle>(secrets.clone()) {
            Ok(paquet) => match client.encryption().import_secrets_bundle(&paquet).await {
                Ok(()) => {
                    rapport.secrets_importes = true;
                    log::info!("[Sion][migration] secrets de l'ancien appareil importés : appareil vérifié");
                }
                Err(e) => log::warn!("[Sion][migration] secrets refusés : {e}"),
            },
            Err(e) => log::warn!("[Sion][migration] paquet de secrets illisible : {e}"),
        }
    }
    if let Some(texte) = &import.cles_salons {
        match importer_cles(client, dossier, texte).await {
            Ok((importees, total)) => {
                rapport.cles_importees = importees;
                rapport.cles_total = total;
                log::info!("[Sion][migration] clés de salons : {importees}/{total} importées");
            }
            Err(e) => log::warn!("[Sion][migration] clés de salons non importées : {e}"),
        }
    }
    rapport
}

/// Les clés arrivent en JSON clair ; l'import de matrix-sdk lit le format
/// d'export chiffré : on chiffre le JSON dans un fichier privé, on l'importe,
/// on l'efface.
async fn importer_cles(client: &Client, dossier: &Path, texte: &str) -> Result<(usize, usize), String> {
    let cles: Vec<ExportedRoomKey> = serde_json::from_str(texte).map_err(|e| format!("JSON des clés : {e}"))?;
    if cles.is_empty() {
        return Ok((0, 0));
    }
    let phrase = crate::session::phrase_aleatoire().map_err(|e| e.to_string())?;
    let export = matrix_sdk_crypto::encrypt_room_key_export(&cles, &phrase, TOURS_EXPORT).map_err(|e| e.to_string())?;
    let chemin = dossier.join(".cles-migration.txt");
    crate::session::ecrire_prive(&chemin, export.as_bytes()).map_err(|e| e.to_string())?;
    let resultat = client.encryption().import_room_keys(chemin.clone(), &phrase).await;
    let _ = std::fs::remove_file(&chemin);
    let r = resultat.map_err(|e| e.to_string())?;
    Ok((r.imported_count, r.total_count))
}
