//! Envoi (tranche T3) : les contenus de `envoi.rs`, envoyés par matrix-sdk.
//!
//! Tout part par `send_raw` : le JSON est exactement celui du moteur JS, et
//! matrix-sdk le chiffre d'office dans un salon chiffré. Le message revient
//! ensuite par la synchro, dans le fil du salon. Chaque envoi rend
//! l'identifiant serveur de l'événement (plus d'écho local `~…` à résoudre,
//! contrairement au JS : `resolveServerEventId` n'a pas d'équivalent).
use std::future::IntoFuture;
use std::io::Cursor;

use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::{EventId, OwnedEventId};
use matrix_sdk::{Room, RoomMemberships};
use serde_json::Value;

use crate::coeur::CoeurMatrix;
use crate::envoi::{self, InfosMedia, Membre, Televerse};
use crate::{membres, Erreur, Resultat};

fn id_evenement(id: &str) -> Resultat<OwnedEventId> {
    EventId::parse(id).map_err(|e| Erreur::Autre(format!("identifiant d'événement invalide {id} : {e}")))
}

/// Membres rejoints (`getJoinedMembers`), nommés d'après TOUT l'état du salon.
async fn membres_rejoints(salon: &Room) -> Vec<Membre> {
    let tous = salon.members(RoomMemberships::all()).await.unwrap_or_default();
    let mut noms = membres::noms_du_salon(&tous);
    tous.iter()
        .filter(|m| m.membership() == &MembershipState::Join)
        .filter_map(|m| {
            let id = m.user_id().to_string();
            noms.remove(&id).map(|nom| Membre { id, nom })
        })
        .collect()
}

async fn envoyer(salon: &Room, type_: &str, contenu: Value) -> Resultat<String> {
    let resultat = Box::pin(salon.send_raw(type_, contenu).into_future()).await?;
    Ok(resultat.response.event_id.to_string())
}

impl CoeurMatrix {
    /// Message texte, avec mentions (`sendTextMessage`).
    pub async fn envoyer_texte(&self, salon: &str, corps: &str) -> Resultat<String> {
        let salon = self.salon(salon).await?;
        let contenu = envoi::texte(corps, &membres_rejoints(&salon).await);
        envoyer(&salon, "m.room.message", contenu).await
    }

    /// Réponse à un message (`sendReply`).
    pub async fn repondre(&self, salon: &str, cible: &str, corps: &str) -> Resultat<String> {
        let cible = id_evenement(cible)?;
        let salon = self.salon(salon).await?;
        let contenu = envoi::reponse(cible.as_str(), corps, &membres_rejoints(&salon).await);
        envoyer(&salon, "m.room.message", contenu).await
    }

    /// Édition d'un message (`editMessage`) — chiffrée dans un salon chiffré.
    pub async fn editer(&self, salon: &str, cible: &str, texte: &str) -> Resultat<String> {
        let cible = id_evenement(cible)?;
        let salon = self.salon(salon).await?;
        envoyer(&salon, "m.room.message", envoi::edition(cible.as_str(), texte)).await
    }

    /// Suppression (`redactMessage`) : message, réaction, vote…
    pub async fn supprimer(&self, salon: &str, cible: &str) -> Resultat<()> {
        let cible = id_evenement(cible)?;
        let salon = self.salon(salon).await?;
        Box::pin(salon.redact(&cible, None, None)).await.map_err(matrix_sdk::Error::from)?;
        Ok(())
    }

    /// Réaction (`sendReaction`). La retirer = supprimer l'événement de
    /// réaction (identifiant fourni par le fil, `reactions[].eventIds`).
    pub async fn reagir(&self, salon: &str, cible: &str, cle: &str) -> Resultat<String> {
        let cible = id_evenement(cible)?;
        let salon = self.salon(salon).await?;
        envoyer(&salon, "m.reaction", envoi::reaction(cible.as_str(), cle)).await
    }

    /// « Poke » (`sendPoke`).
    pub async fn poker(&self, salon: &str) -> Resultat<String> {
        let salon = self.salon(salon).await?;
        envoyer(&salon, "m.room.message", envoi::poke()).await
    }

    /// Sondage (`createPoll`) ; `fin` : échéance en ms depuis l'epoch.
    pub async fn creer_sondage(
        &self,
        salon: &str,
        question: &str,
        options: &[String],
        secret: bool,
        max: u32,
        fin: Option<i64>,
    ) -> Resultat<String> {
        let salon = self.salon(salon).await?;
        let maintenant = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let contenu = envoi::sondage(question, options, secret, max.max(1), fin, maintenant);
        envoyer(&salon, "m.poll.start", contenu).await
    }

    /// Vote (`votePoll`) ; remplace le vote précédent, vide = retrait.
    pub async fn voter(&self, salon: &str, sondage: &str, reponses: &[String]) -> Resultat<String> {
        let sondage = id_evenement(sondage)?;
        let salon = self.salon(salon).await?;
        envoyer(&salon, "m.poll.response", envoi::vote(sondage.as_str(), reponses)).await
    }

    /// Clôture d'un sondage (`endPoll`).
    pub async fn clore_sondage(&self, salon: &str, sondage: &str) -> Resultat<String> {
        let sondage = id_evenement(sondage)?;
        let salon = self.salon(salon).await?;
        envoyer(&salon, "m.poll.end", envoi::fin_sondage(sondage.as_str())).await
    }

    /// Épingle un message, ou le désépingle s'il l'était (`pinMessage`).
    pub async fn epingler(&self, salon: &str, cible: &str) -> Resultat<()> {
        let cible = id_evenement(cible)?;
        let salon = self.salon(salon).await?;
        let actuels: Vec<String> = salon.pinned_event_ids().unwrap_or_default().iter().map(|e| e.to_string()).collect();
        let contenu = envoi::epinglage(&actuels, cible.as_str());
        Box::pin(salon.send_state_event_raw("m.room.pinned_events", "", contenu)).await?;
        Ok(())
    }

    /// Fichier (`sendFileMessage`) : téléversé chiffré si le salon l'est.
    /// La vidéo arrive déjà préparée (WebM) par l'appelant, avec ses
    /// dimensions et sa durée.
    pub async fn envoyer_fichier(
        &self,
        salon: &str,
        octets: Vec<u8>,
        nom: &str,
        mime: &str,
        infos: InfosMedia,
    ) -> Resultat<String> {
        let salon = self.salon(salon).await?;
        let contenu = televerser(&salon, octets, nom, mime, &infos).await?;
        envoyer(&salon, "m.room.message", contenu).await
    }

    /// GIF choisi dans le sélecteur (`sendImageUrl`) : téléchargé puis
    /// téléversé, corps « GIF ».
    pub async fn envoyer_image_url(&self, salon: &str, url: &str) -> Resultat<String> {
        let salon = self.salon(salon).await?;
        let reponse = matrix_sdk::reqwest::get(url).await.map_err(|e| Erreur::Autre(e.to_string()))?;
        if !reponse.status().is_success() {
            return Err(Erreur::Autre(format!("image introuvable ({})", reponse.status())));
        }
        let octets = reponse.bytes().await.map_err(|e| Erreur::Autre(e.to_string()))?.to_vec();
        let contenu = televerser(&salon, octets, "GIF", "image/gif", &InfosMedia::default()).await?;
        envoyer(&salon, "m.room.message", contenu).await
    }

    /// Taille maximale d'un envoi annoncée par le serveur (`getMaxUploadSize`).
    pub async fn taille_max_envoi(&self) -> Resultat<u64> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        Ok(u64::from(Box::pin(client.load_or_fetch_max_upload_size()).await?))
    }
}

async fn televerser(salon: &Room, octets: Vec<u8>, corps: &str, mime: &str, infos: &InfosMedia) -> Resultat<Value> {
    let client = salon.client();
    let taille = octets.len() as u64;
    let chiffre = Box::pin(salon.latest_encryption_state()).await?.is_encrypted();
    let source = if chiffre {
        let fichier = Box::pin(client.upload_encrypted_file(&mut Cursor::new(&octets)).into_future()).await?;
        Televerse::Chiffre(serde_json::to_value(fichier)?)
    } else {
        let type_: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
        let reponse = Box::pin(client.media().upload(&type_, octets, None).into_future()).await?;
        Televerse::Clair(reponse.content_uri.to_string())
    };
    Ok(envoi::fichier(corps, mime, taille, source, infos))
}
