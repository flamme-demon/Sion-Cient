//! Migration de l'ancien moteur vers le cœur (étape 4), sur un vrai compte —
//! côté Rust. Ignoré par défaut ; lancé par `build-scripts/migration-croisee.sh`
//! avec `src/services/migrationCroisee.test.ts`, qui fait l'export.
//!
//! Le nouvel appareil se connecte par mot de passe en important l'export :
//! il doit être vérifié d'emblée (signature croisée reprise) et avoir les
//! clés des salons.
#![recursion_limit = "256"]
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use sion_matrix::{CoeurMatrix, CoffreMemoire, ImportMigration};

fn ecrire(chemin: &Path, valeur: Value) {
    let provisoire = chemin.with_extension("tmp");
    std::fs::write(&provisoire, serde_json::to_vec(&valeur).unwrap()).unwrap();
    std::fs::rename(provisoire, chemin).unwrap();
}

async fn attendre_fichier(chemin: &Path) -> Value {
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            if let Ok(Ok(v)) = std::fs::read(chemin).map(|o| serde_json::from_slice::<Value>(&o)) {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} jamais écrit", chemin.display()))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "compte réel : lancé par build-scripts/migration-croisee.sh"]
async fn migration_depuis_le_moteur_js() {
    let v = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("{n} requis"));
    let echange = PathBuf::from(v("SION_TEST_ECHANGE"));
    let export = attendre_fichier(&echange.join("export.json")).await;
    let import = ImportMigration {
        secrets: export.get("secrets").filter(|s| !s.is_null()).cloned(),
        cles_salons: export.get("cles").and_then(Value::as_str).map(str::to_owned),
    };
    let dossier = tempfile::tempdir().unwrap();
    let coeur = CoeurMatrix::nouveau(dossier.path().to_path_buf(), "Sion — migration (cœur)", Arc::new(CoffreMemoire::default()));
    let resultat = async {
        let rapport = coeur
            .connecter_et_migrer(&v("SION_TEST_SERVEUR"), &v("SION_TEST_IDENTIFIANT"), &v("SION_TEST_MOT_DE_PASSE"), &import)
            .await
            .map_err(|e| format!("connexion : {e}"))?;
        println!("rapport : {rapport:?}");
        if !rapport.secrets_importes {
            return Err("secrets non importés".to_owned());
        }
        if !coeur.appareil_verifie().await.map_err(|e| e.to_string())? {
            return Err("nouvel appareil pas vérifié".to_owned());
        }
        if rapport.cles_importees == 0 {
            return Err("aucune clé de salon importée".to_owned());
        }
        println!("nouvel appareil vérifié d'emblée ; {}/{} clés de salons importées", rapport.cles_importees, rapport.cles_total);
        Ok::<_, String>(())
    }
    .await;
    ecrire(&echange.join("rust-fini.json"), match &resultat {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "erreur": e }),
    });
    coeur.deconnecter().await.ok();
    resultat.unwrap();
}
