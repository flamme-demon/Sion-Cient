//! Entre membres : « en train d'écrire », « vu par », signalement, utilisateurs
//! ignorés et bannière de profil (MSC4427).
use std::future::IntoFuture;

use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::profile::{ProfileFieldName, ProfileFieldValue};
use matrix_sdk::ruma::{EventId, UserId};
use tokio::sync::broadcast;

use crate::coeur::CoeurMatrix;
use crate::fil::{Frappe, LecturesSalon};
use crate::messages::SourceMedia;
use crate::{Erreur, Resultat};

/// Champ de profil de la bannière : préfixe instable de MSC4427, lu aussi
/// sous son nom stable.
pub(crate) const CHAMP_BANNIERE: &str = "chat.commet.profile_banner";
const CHAMP_BANNIERE_STABLE: &str = "m.banner_url";

fn utilisateur(id: &str) -> Resultat<&UserId> {
    <&UserId>::try_from(id).map_err(|e| Erreur::Autre(format!("identifiant invalide {id} : {e}")))
}

/// Adresse `mxc://` de la bannière dans un profil (nom instable d'abord).
pub(crate) fn banniere_du_profil(profil: &serde_json::Value) -> Option<&str> {
    [CHAMP_BANNIERE, CHAMP_BANNIERE_STABLE]
        .iter()
        .find_map(|champ| profil.get(champ).and_then(|v| v.as_str()))
        .filter(|u| u.starts_with("mxc://"))
}

impl CoeurMatrix {
    /// Qui écrit, salon par salon (moi et les ignorés exceptés).
    pub fn frappes(&self) -> broadcast::Receiver<Frappe> {
        self.fils().abonner_frappes()
    }

    /// « Vu par », salon par salon, republié quand il change.
    pub fn lectures(&self) -> broadcast::Receiver<LecturesSalon> {
        self.fils().abonner_lectures()
    }

    pub fn lectures_actuelles(&self) -> Vec<LecturesSalon> {
        self.fils().toutes_lectures()
    }

    /// Déclare où le serveur envoie les notifications push de cet appareil :
    /// un pusher HTTP vers la passerelle Matrix de ntfy (`passerelle`), le
    /// sujet ntfy servant de clé (`cle`). Format « event_id_only » : ni texte
    /// ni expéditeur ne quittent le serveur. Remplace un pusher de même clé.
    pub async fn enregistrer_pusher(&self, passerelle: &str, cle: &str, app_id: &str, nom_appareil: &str) -> Resultat<()> {
        use matrix_sdk::ruma::api::client::push::{Pusher, PusherIds, PusherInit, PusherKind};
        use matrix_sdk::ruma::push::{HttpPusherData, PushFormat};
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let mut donnees = HttpPusherData::new(passerelle.to_owned());
        donnees.format = Some(PushFormat::EventIdOnly);
        let pusher: Pusher = PusherInit {
            ids: PusherIds::new(cle.to_owned(), app_id.to_owned()),
            kind: PusherKind::Http(donnees),
            app_display_name: "Sion Client".to_owned(),
            device_display_name: nom_appareil.to_owned(),
            profile_tag: None,
            lang: "fr".to_owned(),
        }
        .into();
        Box::pin(client.pusher().set(pusher, false)).await?;
        Ok(())
    }

    /// Retire le pusher de cet appareil (déconnexion).
    pub async fn retirer_pusher(&self, cle: &str, app_id: &str) -> Resultat<()> {
        use matrix_sdk::ruma::api::client::push::PusherIds;
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        Box::pin(client.pusher().delete(PusherIds::new(cle.to_owned(), app_id.to_owned()))).await?;
        Ok(())
    }

    /// Signale que j'écris (ou plus) : matrix-sdk n'envoie au serveur qu'un
    /// changement ou un rappel toutes les 3 s.
    pub async fn ecrire(&self, salon: &str, actif: bool) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        Box::pin(salon.typing_notice(actif)).await?;
        Ok(())
    }

    /// Signale un message aux administrateurs du serveur (Continuwuity les
    /// relaie dans son salon d'administration).
    pub async fn signaler(&self, salon: &str, evenement: &str, raison: Option<String>) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        let evenement = EventId::parse(evenement).map_err(|e| Erreur::Autre(e.to_string()))?;
        let raison = raison.map(|r| r.trim().to_owned()).filter(|r| !r.is_empty());
        Box::pin(salon.report_content(evenement, raison)).await?;
        Ok(())
    }

    /// Ignore un utilisateur : ses messages, frappes et invitations ne
    /// m'arrivent plus. matrix-sdk vide alors les caches de messages, que les
    /// fils rechargent aussitôt.
    pub async fn ignorer(&self, id: &str) -> Resultat<()> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        Box::pin(client.account().ignore_user(utilisateur(id)?)).await?;
        Ok(())
    }

    pub async fn ne_plus_ignorer(&self, id: &str) -> Resultat<()> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        Box::pin(client.account().unignore_user(utilisateur(id)?)).await?;
        Ok(())
    }

    /// Utilisateurs ignorés, lus sur le serveur : la liste locale n'est à jour
    /// qu'à la synchro suivante.
    pub async fn ignores(&self) -> Resultat<Vec<String>> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let contenu = Box::pin(client.account().fetch_account_data_static::<IgnoredUserListEventContent>()).await?;
        let mut liste: Vec<String> = match contenu {
            Some(brut) => brut.deserialize()?.ignored_users.into_keys().map(|u| u.to_string()).collect(),
            None => Vec::new(),
        };
        liste.sort();
        Ok(liste)
    }

    /// Salons rejoints où l'utilisateur est aussi (calcul local : l'état des
    /// membres est déjà synchronisé, aucune requête).
    pub async fn salons_en_commun(&self, id: &str) -> Resultat<Vec<String>> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let cible = utilisateur(id)?;
        let mut liste = Vec::new();
        for salon in client.joined_rooms() {
            if let Ok(Some(m)) = salon.get_member_no_sync(cible).await {
                if *m.membership() == MembershipState::Join {
                    liste.push(salon.room_id().to_string());
                }
            }
        }
        Ok(liste)
    }

    /// Bannière d'un utilisateur, en URL `sion-media` (image d'origine).
    pub async fn banniere(&self, id: &str) -> Resultat<Option<String>> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let profil = Box::pin(client.account().fetch_user_profile_of(utilisateur(id)?)).await?;
        let json = serde_json::json!({
            CHAMP_BANNIERE: profil.data.get(CHAMP_BANNIERE),
            CHAMP_BANNIERE_STABLE: profil.data.get(CHAMP_BANNIERE_STABLE),
        });
        Ok(banniere_du_profil(&json).and_then(|mxc| self.medias().url(&SourceMedia::Mxc(mxc.to_owned()), false)))
    }

    /// Ma bannière : téléversée puis posée dans le profil ; `None` l'enlève.
    pub async fn changer_banniere(&self, image: Option<(Vec<u8>, String)>) -> Resultat<Option<String>> {
        let client = self.client().await.ok_or(Erreur::PasDeSession)?;
        let Some((octets, mime)) = image else {
            Box::pin(client.account().delete_profile_field(ProfileFieldName::from(CHAMP_BANNIERE))).await?;
            return Ok(None);
        };
        let type_: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
        let reponse = Box::pin(client.media().upload(&type_, octets, None).into_future()).await?;
        let mxc = reponse.content_uri.to_string();
        let valeur = ProfileFieldValue::new(CHAMP_BANNIERE, serde_json::Value::String(mxc.clone()))?;
        Box::pin(client.account().set_profile_field(valeur)).await?;
        Ok(self.medias().url(&SourceMedia::Mxc(mxc), false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn la_banniere_est_lue_sous_son_nom_instable_puis_stable() {
        assert_eq!(banniere_du_profil(&json!({ CHAMP_BANNIERE: "mxc://a/b" })), Some("mxc://a/b"));
        assert_eq!(banniere_du_profil(&json!({ "m.banner_url": "mxc://a/c" })), Some("mxc://a/c"));
        assert_eq!(
            banniere_du_profil(&json!({ CHAMP_BANNIERE: "mxc://a/b", "m.banner_url": "mxc://a/c" })),
            Some("mxc://a/b")
        );
    }

    #[test]
    fn une_banniere_hors_mxc_est_refusee() {
        // MSC4427 : seulement des `mxc://`, jamais une adresse web arbitraire.
        assert_eq!(banniere_du_profil(&json!({ CHAMP_BANNIERE: "https://exemple.org/pistage.png" })), None);
        assert_eq!(banniere_du_profil(&json!({ "displayname": "x" })), None);
    }
}
