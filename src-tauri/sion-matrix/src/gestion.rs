//! Membres, salons, profil, appareils et administration (tranche T4) :
//! l'équivalent de la partie « gestion » de `matrixService.ts`, de
//! `adminService.ts` (par un mandataire : le jeton d'accès ne quitte pas
//! Rust) et de `adminCommandService.ts`.
use std::future::IntoFuture;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::room::create_room::v3::{Request as CreerSalon, RoomPreset};
use matrix_sdk::ruma::api::client::uiaa::AuthData;
use matrix_sdk::ruma::events::room::join_rules::JoinRule;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{Int, OwnedDeviceId, OwnedUserId, RoomId, UserId};
use matrix_sdk::{Client, Room, RoomMemberships};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::administration::{self, CandidatAdmin};
use crate::coeur::CoeurMatrix;
use crate::salons::mxc_vers_http;
use crate::{membres, Erreur, Resultat};

/// Événement d'état de la version du client (`SION_VERSION_EVENT`).
const EVENEMENT_VERSION: &str = "com.sion.client_version";
/// Attente d'une réponse du robot d'administration (`sendAdminCommand`).
const DELAI_COMMANDE: Duration = Duration::from_secs(15);

/// Un membre rejoint (`getRoomMembers`), avec son niveau (`getMemberPowerLevel`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MembreSalon {
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub power_level: i64,
}

/// Ce que l'interface lit d'un salon pour ses écrans de gestion.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsSalon {
    pub membres: Vec<MembreSalon>,
    /// Mon niveau (`getUserPowerLevel`) ; `i64::MAX` = infini (créateur).
    pub moi: i64,
    /// Niveau requis pour l'état (`getStatePowerLevel`, 50 par défaut).
    pub niveau_etat: i64,
    /// Niveau requis pour inviter (`getInvitePowerLevel`, 0 par défaut).
    pub niveau_invitation: i64,
    /// Puis-je écrire (`canSendMessage`) ?
    pub peut_ecrire: bool,
    /// « public », « invite »…
    pub regle_acces: Option<String>,
}

/// Un appareil du compte, au format de l'API (`getDevices`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Appareil {
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_ts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_ip: Option<String>,
}

/// Réponse brute du mandataire d'administration.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReponseServeur {
    pub status: u16,
    pub corps: Value,
}

/// Étapes d'inscription annoncées par le serveur (`getRegistrationFlows`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EtapesInscription {
    pub flows: Value,
    pub params: Value,
    pub session: String,
    pub disabled: bool,
}

/// Niveau d'un utilisateur ; l'infini (créateur, salon v12) devient
/// `i64::MAX`, que la façade rend en `Infinity` comme le JS.
fn en_nombre(niveau: UserPowerLevel) -> i64 {
    match niveau {
        UserPowerLevel::Int(n) => n.into(),
        _ => i64::MAX,
    }
}

fn utilisateur(id: &str) -> Resultat<OwnedUserId> {
    UserId::parse(id).map_err(|e| Erreur::Autre(format!("identifiant invalide {id} : {e}")))
}

fn maintenant_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn brut<T>(valeur: Value) -> Resultat<Raw<T>> {
    Ok(Raw::from_json_string(valeur.to_string())?)
}

/// Contenu d'un événement d'état, en JSON.
async fn contenu_etat(salon: &Room, type_: StateEventType) -> Option<Value> {
    let brut = salon.get_state_event(type_, "").await.ok().flatten()?;
    let json = match brut {
        RawAnySyncOrStrippedState::Sync(e) => e.json().get().to_owned(),
        RawAnySyncOrStrippedState::Stripped(e) => e.json().get().to_owned(),
    };
    serde_json::from_str::<Value>(&json).ok()?.get("content").cloned()
}

/// Authentification par mot de passe pour une requête UIA, au format du
/// protocole (celui qu'envoie le JS).
fn auth_mot_de_passe(moi: &str, mot_de_passe: &str, session: Option<&str>) -> Resultat<AuthData> {
    let mut auth = json!({
        "type": "m.login.password",
        "identifier": { "type": "m.id.user", "user": moi },
        "password": mot_de_passe,
    });
    if let Some(s) = session {
        auth["session"] = s.into();
    }
    Ok(serde_json::from_value(auth)?)
}

/// Requête HTTP brute (inscription, mandataire) : JSON en entrée, statut et
/// JSON (ou `null`) en sortie.
async fn http(methode: &str, url: &str, jeton: Option<&str>, corps: Option<&Value>) -> Resultat<ReponseServeur> {
    let methode = matrix_sdk::reqwest::Method::from_bytes(methode.as_bytes()).map_err(|e| Erreur::Autre(e.to_string()))?;
    let mut requete = matrix_sdk::reqwest::Client::new().request(methode, url).header("Content-Type", "application/json");
    if let Some(jeton) = jeton {
        requete = requete.bearer_auth(jeton);
    }
    if let Some(corps) = corps {
        requete = requete.body(corps.to_string());
    }
    let reponse = requete.send().await.map_err(|e| Erreur::Autre(e.to_string()))?;
    let status = reponse.status().as_u16();
    let octets = reponse.bytes().await.map_err(|e| Erreur::Autre(e.to_string()))?;
    Ok(ReponseServeur { status, corps: serde_json::from_slice(&octets).unwrap_or(Value::Null) })
}

/// URL du serveur, découverte comme à la connexion (`.well-known`).
async fn adresse_serveur(serveur: &str) -> Resultat<String> {
    let client = Client::builder().server_name_or_homeserver_url(serveur).build().await?;
    Ok(client.homeserver().to_string().trim_end_matches('/').to_owned())
}

/// Salons rejoints, décrits pour la reconnaissance du salon d'administration.
async fn candidats(client: &Client) -> Vec<(String, String, String, Vec<String>)> {
    let mut liste = Vec::new();
    for salon in client.joined_rooms() {
        let membres: Vec<String> = salon
            .members_no_sync(RoomMemberships::JOIN)
            .await
            .unwrap_or_default()
            .iter()
            .map(|m| m.user_id().to_string())
            .collect();
        let nom = salon.cached_display_name().map(|n| n.to_string()).unwrap_or_default();
        let alias = salon.canonical_alias().map(|a| a.to_string()).unwrap_or_default();
        liste.push((salon.room_id().to_string(), nom, alias, membres));
    }
    liste
}

fn vue(liste: &[(String, String, String, Vec<String>)]) -> Vec<CandidatAdmin<'_>> {
    liste.iter().map(|(id, nom, alias, membres)| CandidatAdmin { id, nom, alias, membres }).collect()
}

// Chaque méthode publique rend un futur en boîte (voir `recursion_limit`
// dans lib.rs) ; le travail est dans sa jumelle suffixée `_`.
impl CoeurMatrix {
    async fn client_actif(&self) -> Resultat<Client> {
        self.client().await.ok_or(Erreur::PasDeSession)
    }

    // ── Lecture ──────────────────────────────────────────────────────────────

    /// Membres et niveaux d'un salon, pour les écrans de gestion.
    pub async fn details_salon(&self, salon: &str) -> Resultat<DetailsSalon> {
        Box::pin(self.details_salon_(salon)).await
    }

    async fn details_salon_(&self, salon: &str) -> Resultat<DetailsSalon> {
        let salon = self.salon(salon).await?;
        let client = salon.client();
        let moi = client.user_id().map(|u| u.to_string()).unwrap_or_default();
        let base = client.homeserver().to_string();
        let niveaux = administration::niveaux(contenu_etat(&salon, StateEventType::RoomPowerLevels).await.as_ref());
        // Niveau calculé par matrix-sdk : il connaît les créateurs d'un salon
        // en version 12, de niveau infini (le JS donne `Infinity`).
        let calcul = salon.power_levels().await.ok();
        let niveau = |id: &str| match (&calcul, UserId::parse(id)) {
            (Some(p), Ok(uid)) => en_nombre(p.for_user(&uid)),
            _ => niveaux.utilisateurs.get(id).copied().unwrap_or(niveaux.par_defaut),
        };
        let tous = salon.members_no_sync(RoomMemberships::all()).await?;
        let mut noms = membres::noms_du_salon(&tous);
        let membres = tous
            .iter()
            .filter(|m| m.membership() == &MembershipState::Join)
            .map(|m| {
                let id = m.user_id().to_string();
                MembreSalon {
                    display_name: noms.remove(&id).unwrap_or_else(|| id.clone()),
                    avatar_url: m.avatar_url().and_then(|u| mxc_vers_http(&base, u.as_str())),
                    power_level: niveau(&id),
                    user_id: id,
                }
            })
            .collect();
        let regle = contenu_etat(&salon, StateEventType::RoomJoinRules).await;
        Ok(DetailsSalon {
            membres,
            moi: niveau(&moi),
            niveau_etat: niveaux.etat,
            niveau_invitation: niveaux.invitation,
            peut_ecrire: niveau(&moi) >= niveaux.message,
            regle_acces: regle.and_then(|r| r.get("join_rule").and_then(Value::as_str).map(str::to_owned)),
        })
    }

    /// Administrateurs du serveur (`getServerAdminUserIds`).
    pub async fn admins_serveur(&self) -> Resultat<Vec<String>> {
        Box::pin(self.admins_serveur_()).await
    }

    async fn admins_serveur_(&self) -> Resultat<Vec<String>> {
        let client = self.client_actif().await?;
        let serveur = client.user_id().ok_or(Erreur::PasDeSession)?.server_name().to_string();
        let liste = candidats(&client).await;
        let Some(id) = administration::salon_admin_pour_les_niveaux(&vue(&liste), &serveur) else {
            return Ok(Vec::new());
        };
        let salon = self.salon(id).await?;
        let niveaux = contenu_etat(&salon, StateEventType::RoomPowerLevels).await.unwrap_or(Value::Null);
        Ok(administration::admins_du_serveur(&niveaux, &serveur))
    }

    /// Nom d'affichage d'un utilisateur (`fetchDisplayName`).
    pub async fn nom_utilisateur(&self, id: &str) -> Resultat<Option<String>> {
        Box::pin(self.nom_utilisateur_(id)).await
    }

    async fn nom_utilisateur_(&self, id: &str) -> Resultat<Option<String>> {
        let client = self.client_actif().await?;
        Ok(client.account().fetch_user_profile_of(&utilisateur(id)?).await.ok().and_then(|p| {
            p.get("displayname").and_then(|v| v.as_str().map(str::to_owned))
        }))
    }

    /// Avatar d'un utilisateur, en URL http (`getAvatarUrl`).
    pub async fn avatar_utilisateur(&self, id: &str) -> Resultat<Option<String>> {
        Box::pin(self.avatar_utilisateur_(id)).await
    }

    async fn avatar_utilisateur_(&self, id: &str) -> Resultat<Option<String>> {
        let client = self.client_actif().await?;
        let base = client.homeserver().to_string();
        Ok(client.account().fetch_user_profile_of(&utilisateur(id)?).await.ok().and_then(|p| {
            p.get("avatar_url").and_then(|v| v.as_str().and_then(|u| mxc_vers_http(&base, u)))
        }))
    }

    /// Appareils du compte (`getDevices`).
    pub async fn appareils(&self) -> Resultat<Vec<Appareil>> {
        Box::pin(self.appareils_()).await
    }

    async fn appareils_(&self) -> Resultat<Vec<Appareil>> {
        let client = self.client_actif().await?;
        let reponse = client.devices().await.map_err(matrix_sdk::Error::from)?;
        Ok(reponse
            .devices
            .into_iter()
            .map(|d| Appareil {
                device_id: d.device_id.to_string(),
                display_name: d.display_name,
                last_seen_ts: d.last_seen_ts.map(|t| u64::from(t.0)),
                last_seen_ip: d.last_seen_ip,
            })
            .collect())
    }

    // ── Membres ──────────────────────────────────────────────────────────────

    /// Invitation (`inviteUser`) ; l'historique des clés est partagé avec
    /// l'invité (MSC4268), comme `shareHistoricKeys`.
    pub async fn inviter(&self, salon: &str, id: &str) -> Resultat<()> {
        Box::pin(self.inviter_(salon, id)).await
    }

    async fn inviter_(&self, salon: &str, id: &str) -> Resultat<()> {
        let id = utilisateur(id)?;
        let salon = self.salon(salon).await?;
        Box::pin(salon.invite_user_by_id(&id)).await?;
        Ok(())
    }

    pub async fn expulser(&self, salon: &str, id: &str, raison: Option<&str>) -> Resultat<()> {
        Box::pin(self.expulser_(salon, id, raison)).await
    }

    async fn expulser_(&self, salon: &str, id: &str, raison: Option<&str>) -> Resultat<()> {
        let id = utilisateur(id)?;
        let salon = self.salon(salon).await?;
        Box::pin(salon.kick_user(&id, raison)).await?;
        Ok(())
    }

    pub async fn bannir(&self, salon: &str, id: &str, raison: Option<&str>) -> Resultat<()> {
        Box::pin(self.bannir_(salon, id, raison)).await
    }

    async fn bannir_(&self, salon: &str, id: &str, raison: Option<&str>) -> Resultat<()> {
        let id = utilisateur(id)?;
        let salon = self.salon(salon).await?;
        Box::pin(salon.ban_user(&id, raison)).await?;
        Ok(())
    }

    /// Niveau d'un membre (`setUserPowerLevel`).
    pub async fn changer_niveau(&self, salon: &str, id: &str, niveau: i64) -> Resultat<()> {
        Box::pin(self.changer_niveau_(salon, id, niveau)).await
    }

    async fn changer_niveau_(&self, salon: &str, id: &str, niveau: i64) -> Resultat<()> {
        let id = utilisateur(id)?;
        let niveau = Int::new(niveau).ok_or_else(|| Erreur::Autre(format!("niveau invalide : {niveau}")))?;
        let salon = self.salon(salon).await?;
        Box::pin(salon.update_power_levels(vec![(&id, niveau)])).await?;
        Ok(())
    }

    // ── Salons ───────────────────────────────────────────────────────────────

    pub async fn rejoindre(&self, salon: &str) -> Resultat<()> {
        Box::pin(self.rejoindre_(salon)).await
    }

    async fn rejoindre_(&self, salon: &str) -> Resultat<()> {
        let client = self.client_actif().await?;
        let id = RoomId::parse(salon).map_err(|e| Erreur::Autre(e.to_string()))?;
        Box::pin(client.join_room_by_id(&id)).await?;
        Ok(())
    }

    pub async fn quitter(&self, salon: &str) -> Resultat<()> {
        Box::pin(self.quitter_(salon)).await
    }

    async fn quitter_(&self, salon: &str) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        Box::pin(salon.leave()).await?;
        Ok(())
    }

    pub async fn renommer_salon(&self, salon: &str, nom: &str) -> Resultat<()> {
        Box::pin(self.renommer_salon_(salon, nom)).await
    }

    async fn renommer_salon_(&self, salon: &str, nom: &str) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        Box::pin(salon.set_name(nom.to_owned())).await?;
        Ok(())
    }

    pub async fn changer_sujet(&self, salon: &str, sujet: &str) -> Resultat<()> {
        Box::pin(self.changer_sujet_(salon, sujet)).await
    }

    async fn changer_sujet_(&self, salon: &str, sujet: &str) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        Box::pin(salon.set_room_topic(sujet)).await?;
        Ok(())
    }

    /// Avatar du salon (`setRoomAvatar`) : téléversé, puis `m.room.avatar`.
    pub async fn changer_avatar_salon(&self, salon: &str, octets: Vec<u8>, mime: &str) -> Resultat<()> {
        Box::pin(self.changer_avatar_salon_(salon, octets, mime)).await
    }

    async fn changer_avatar_salon_(&self, salon: &str, octets: Vec<u8>, mime: &str) -> Resultat<()> {
        let salon = self.salon(salon).await?;
        let type_: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
        let reponse = Box::pin(salon.client().media().upload(&type_, octets, None).into_future()).await?;
        Box::pin(salon.send_state_event_raw("m.room.avatar", "", json!({ "url": reponse.content_uri }))).await?;
        Ok(())
    }

    /// Règle d'accès (`setRoomJoinRule`) ; un salon qui DEVIENT public est
    /// ouvert à tous les utilisateurs du serveur, comme à sa création.
    pub async fn changer_regle_acces(&self, salon: &str, publique: bool) -> Resultat<()> {
        Box::pin(self.changer_regle_acces_(salon, publique)).await
    }

    async fn changer_regle_acces_(&self, salon: &str, publique: bool) -> Resultat<()> {
        let id = salon.to_owned();
        let salon = self.salon(salon).await?;
        let devient_publique = publique && salon.join_rule() != Some(JoinRule::Public);
        let regle = if publique { "public" } else { "invite" };
        Box::pin(salon.send_state_event_raw("m.room.join_rules", "", json!({ "join_rule": regle }))).await?;
        if devient_publique {
            Box::pin(self.ouvrir_a_tous(&id)).await;
        }
        Ok(())
    }

    /// Création d'un salon (`createChannel`) : mêmes état initial et niveaux
    /// que le JS ; public, il est ouvert à tous les utilisateurs du serveur.
    pub async fn creer_salon(&self, nom: &str, vocal: bool, publique: bool, chiffre: bool) -> Resultat<String> {
        Box::pin(self.creer_salon_(nom, vocal, publique, chiffre)).await
    }

    async fn creer_salon_(&self, nom: &str, vocal: bool, publique: bool, chiffre: bool) -> Resultat<String> {
        let client = self.client_actif().await?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        // Les administrateurs du serveur sont administrateurs du salon dès sa
        // création : atomique, contrairement à un changement après coup.
        let mut utilisateurs = serde_json::Map::new();
        utilisateurs.insert(moi, 100.into());
        for admin in self.admins_serveur().await.unwrap_or_default() {
            utilisateurs.insert(admin, 100.into());
        }
        let mut etat = vec![
            json!({ "type": "m.room.join_rules", "state_key": "", "content": { "join_rule": if publique { "public" } else { "invite" } } }),
            json!({ "type": "m.room.history_visibility", "state_key": "", "content": { "history_visibility": "shared" } }),
        ];
        if vocal {
            etat.push(json!({ "type": "m.room.type", "state_key": "", "content": { "type": "m.voice_channel" } }));
            etat.push(json!({ "type": "m.room.topic", "state_key": "", "content": { "topic": "voice" } }));
        }
        if chiffre {
            etat.insert(0, json!({ "type": "m.room.encryption", "state_key": "", "content": { "algorithm": "m.megolm.v1.aes-sha2" } }));
        }
        let mut requete = CreerSalon::new();
        requete.name = Some(nom.to_owned());
        requete.preset = Some(if publique { RoomPreset::PublicChat } else { RoomPreset::PrivateChat });
        requete.initial_state = etat.into_iter().map(brut).collect::<Resultat<_>>()?;
        requete.power_level_content_override = Some(brut(json!({
            "users": utilisateurs,
            "events": { "org.matrix.msc3401.call.member": 0, EVENEMENT_VERSION: 0 },
        }))?);
        let salon = Box::pin(client.create_room(requete)).await?;
        let id = salon.room_id().to_string();
        if publique {
            Box::pin(self.ouvrir_a_tous(&id)).await;
        }
        Ok(id)
    }

    /// MP avec un utilisateur (`createOrGetDMRoom`) : réutilise un MP
    /// existant (m.direct, sinon tout salon « en forme de MP » avec lui), en
    /// réinvitant le correspondant s'il en était parti ; sinon en crée un.
    pub async fn mp_avec(&self, id: &str) -> Resultat<String> {
        Box::pin(self.mp_avec_(id)).await
    }

    async fn mp_avec_(&self, id: &str) -> Resultat<String> {
        let cible = utilisateur(id)?;
        let client = self.client_actif().await?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_owned();

        // 1. m.direct
        for salon in client.get_dm_rooms(&cible) {
            if salon.state() == matrix_sdk::RoomState::Joined {
                return self.reutiliser_mp(&salon, &cible).await;
            }
        }
        // 2. Tout salon rejoint qui le contient et n'a que nous deux de vivants.
        for salon in client.joined_rooms() {
            let tous = salon.members_no_sync(RoomMemberships::all()).await.unwrap_or_default();
            if !tous.iter().any(|m| m.user_id() == cible) {
                continue;
            }
            let vivants: Vec<_> = tous
                .iter()
                .filter(|m| matches!(m.membership(), MembershipState::Join | MembershipState::Invite))
                .collect();
            if vivants.len() > 2 {
                continue;
            }
            if vivants.iter().any(|m| m.user_id() != moi && m.user_id() != cible) {
                continue;
            }
            return self.reutiliser_mp(&salon, &cible).await;
        }
        // 3. Nouveau MP (sans chiffrement imposé, comme le JS).
        let mut requete = CreerSalon::new();
        requete.is_direct = true;
        requete.invite = vec![cible.clone()];
        requete.preset = Some(RoomPreset::TrustedPrivateChat);
        let salon = Box::pin(client.create_room(requete)).await?;
        if let Err(e) = Box::pin(salon.set_is_direct(true)).await {
            log::warn!("[Sion][matrix] m.direct non mis à jour : {e}");
        }
        Ok(salon.room_id().to_string())
    }

    async fn reutiliser_mp(&self, salon: &Room, cible: &UserId) -> Resultat<String> {
        let present = salon
            .get_member_no_sync(cible)
            .await
            .ok()
            .flatten()
            .is_some_and(|m| matches!(m.membership(), MembershipState::Join | MembershipState::Invite));
        if !present {
            if let Err(e) = Box::pin(salon.invite_user_by_id(cible)).await {
                log::warn!("[Sion][matrix] réinvitation de {cible} impossible : {e}");
            }
        }
        if !salon.is_direct().await.unwrap_or(false) {
            if let Err(e) = Box::pin(salon.set_is_direct(true)).await {
                log::warn!("[Sion][matrix] m.direct non réparé : {e}");
            }
        }
        Ok(salon.room_id().to_string())
    }

    // ── Profil et compte ─────────────────────────────────────────────────────

    pub async fn changer_nom(&self, nom: &str) -> Resultat<()> {
        Box::pin(self.changer_nom_(nom)).await
    }

    async fn changer_nom_(&self, nom: &str) -> Resultat<()> {
        let client = self.client_actif().await?;
        Box::pin(client.account().set_display_name(Some(nom))).await?;
        Ok(())
    }

    /// Avatar du compte (`setAvatar`) ; rend son URL http.
    pub async fn changer_avatar(&self, octets: Vec<u8>, mime: &str) -> Resultat<Option<String>> {
        Box::pin(self.changer_avatar_(octets, mime)).await
    }

    async fn changer_avatar_(&self, octets: Vec<u8>, mime: &str) -> Resultat<Option<String>> {
        let client = self.client_actif().await?;
        let type_: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
        let mxc = Box::pin(client.account().upload_avatar(&type_, octets)).await?;
        Ok(mxc_vers_http(client.homeserver().as_ref(), mxc.as_str()))
    }

    /// Changement de mot de passe (`changePassword`), authentifié par
    /// l'ancien ; reprend la session UIA si le serveur en ouvre une.
    pub async fn changer_mot_de_passe(&self, ancien: &str, nouveau: &str) -> Resultat<()> {
        Box::pin(self.changer_mot_de_passe_(ancien, nouveau)).await
    }

    async fn changer_mot_de_passe_(&self, ancien: &str, nouveau: &str) -> Resultat<()> {
        let client = self.client_actif().await?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        let premier = Box::pin(client.account().change_password(nouveau, Some(auth_mot_de_passe(&moi, ancien, None)?))).await;
        match premier {
            Ok(_) => Ok(()),
            Err(e) => {
                let Some(session) = e.as_uiaa_response().and_then(|i| i.session.clone()) else { return Err(e.into()) };
                let auth = auth_mot_de_passe(&moi, ancien, Some(&session))?;
                Box::pin(client.account().change_password(nouveau, Some(auth))).await?;
                Ok(())
            }
        }
    }

    /// Suppression d'un appareil du compte (`deleteDevice`), par mot de passe.
    pub async fn supprimer_appareil(&self, appareil: &str, mot_de_passe: &str) -> Resultat<()> {
        Box::pin(self.supprimer_appareil_(appareil, mot_de_passe)).await
    }

    async fn supprimer_appareil_(&self, appareil: &str, mot_de_passe: &str) -> Resultat<()> {
        let client = self.client_actif().await?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_string();
        let ids = [OwnedDeviceId::from(appareil)];
        let session = match Box::pin(client.delete_devices(&ids, None)).await {
            Ok(_) => return Ok(()),
            Err(e) => e.as_uiaa_response().and_then(|i| i.session.clone()),
        };
        let auth = auth_mot_de_passe(&moi, mot_de_passe, session.as_deref())?;
        Box::pin(client.delete_devices(&ids, Some(auth))).await.map_err(matrix_sdk::Error::from)?;
        Ok(())
    }

    /// Compte suspendu (`checkSuspended`) ? Le JS tentait d'écrire la partie
    /// locale comme nom d'affichage — et l'écrivait vraiment ; ici on réécrit
    /// le nom ACTUEL : même verdict (403 `M_USER_SUSPENDED`), rien ne change.
    pub async fn est_suspendu(&self) -> Resultat<bool> {
        Box::pin(self.est_suspendu_()).await
    }

    async fn est_suspendu_(&self) -> Resultat<bool> {
        let client = self.client_actif().await?;
        let moi = client.user_id().ok_or(Erreur::PasDeSession)?.to_owned();
        let nom = client.account().get_display_name().await.ok().flatten().unwrap_or_else(|| moi.localpart().to_owned());
        match Box::pin(client.account().set_display_name(Some(&nom))).await {
            Ok(()) => Ok(false),
            Err(e) => Ok(e.to_string().contains("M_USER_SUSPENDED")),
        }
    }

    // ── Inscription (sans session) ───────────────────────────────────────────

    /// Étapes d'inscription du serveur (`getRegistrationFlows`).
    pub async fn etapes_inscription(serveur: &str) -> EtapesInscription {
        let ferme = EtapesInscription { flows: json!([]), params: json!({}), session: String::new(), disabled: true };
        let Ok(base) = adresse_serveur(serveur).await else { return ferme };
        let Ok(r) = http("POST", &format!("{base}/_matrix/client/v3/register"), None, Some(&json!({ "kind": "user" }))).await else {
            return ferme;
        };
        administration_etapes(r)
    }

    /// Inscription (`registerUser`) puis connexion comme nouvel appareil. Le
    /// JS se connectait une seconde fois après avoir créé une session à
    /// l'inscription, laissant un appareil orphelin : ici l'inscription ne
    /// crée pas de session (`inhibit_login`).
    pub async fn inscrire(
        &self,
        serveur: &str,
        identifiant: &str,
        mot_de_passe: &str,
        jeton: Option<&str>,
        captcha: Option<&str>,
    ) -> Resultat<()> {
        let base = adresse_serveur(serveur).await?;
        let url = format!("{base}/_matrix/client/v3/register");
        let corps = |auth: Option<Value>| {
            let mut c = json!({ "username": identifiant, "password": mot_de_passe, "inhibit_login": true });
            if let Some(a) = auth {
                c["auth"] = a;
            }
            c
        };
        // Chaque étape : 200 = compte créé (s'arrêter là, sinon M_USER_IN_USE),
        // 401 + session = étape suivante, autre chose = erreur.
        let etape = |auth: Option<Value>| {
            let url = url.clone();
            let c = corps(auth);
            async move {
                let r = http("POST", &url, None, Some(&c)).await?;
                match (r.status, r.corps.get("session").and_then(Value::as_str)) {
                    (200, _) => Ok(None),
                    (401, Some(s)) => Ok(Some(s.to_owned())),
                    _ => Err(Erreur::Autre(format!(
                        "{} {}",
                        r.corps.get("errcode").and_then(Value::as_str).unwrap_or("M_UNKNOWN"),
                        r.corps.get("error").and_then(Value::as_str).unwrap_or("inscription refusée")
                    ))),
                }
            }
        };
        let mut session = etape(None).await?;
        if let (Some(s), Some(j)) = (session.clone(), jeton) {
            session = etape(Some(json!({ "type": "m.login.registration_token", "token": j, "session": s }))).await?;
        }
        if let (Some(s), Some(c)) = (session.clone(), captcha) {
            session = etape(Some(json!({ "type": "m.login.recaptcha", "response": c, "session": s }))).await?;
        }
        if let Some(s) = session {
            if etape(Some(json!({ "type": "m.login.dummy", "session": s }))).await?.is_some() {
                return Err(Erreur::Autre("inscription incomplète : étapes inattendues".into()));
            }
        }
        self.connecter(serveur, identifiant, mot_de_passe).await
    }

    // ── Administration du serveur ────────────────────────────────────────────

    /// Mandataire de `adminService.ts` : l'API de Continuwuity et la
    /// suspension MSC4323, authentifiées par le jeton qui reste ici.
    pub async fn requete_admin(&self, methode: &str, chemin: &str, corps: Option<Value>, authentifiee: bool) -> Resultat<ReponseServeur> {
        Box::pin(self.requete_admin_(methode, chemin, corps, authentifiee)).await
    }

    async fn requete_admin_(&self, methode: &str, chemin: &str, corps: Option<Value>, authentifiee: bool) -> Resultat<ReponseServeur> {
        if !administration::chemin_admin_autorise(chemin) {
            return Err(Erreur::Autre(format!("chemin refusé par le mandataire : {chemin}")));
        }
        let client = self.client_actif().await?;
        let base = client.homeserver().to_string();
        let jeton = if authentifiee { client.access_token() } else { None };
        http(methode, &format!("{}{chemin}", base.trim_end_matches('/')), jeton.as_deref(), corps.as_ref()).await
    }

    /// Salon d'administration (`findAdminRoom`).
    pub async fn salon_admin(&self) -> Resultat<Option<String>> {
        Box::pin(self.salon_admin_()).await
    }

    async fn salon_admin_(&self) -> Resultat<Option<String>> {
        let client = self.client_actif().await?;
        let serveur = client.user_id().ok_or(Erreur::PasDeSession)?.server_name().to_string();
        let liste = candidats(&client).await;
        Ok(administration::salon_admin(&vue(&liste), &serveur).map(str::to_owned))
    }

    /// Commande au robot d'administration (`sendAdminCommand`) : envoyée
    /// dans le salon d'administration, la réponse du robot est attendue dans
    /// le fil.
    pub async fn commande_admin(&self, commande: &str) -> Resultat<String> {
        Box::pin(self.commande_admin_(commande)).await
    }

    async fn commande_admin_(&self, commande: &str) -> Resultat<String> {
        let client = self.client_actif().await?;
        let serveur = client.user_id().ok_or(Erreur::PasDeSession)?.server_name().to_string();
        let id = self.salon_admin().await?.ok_or_else(|| Erreur::Autre("Admin room not found".into()))?;
        let salon = self.salon(&id).await?;
        let robot = administration::robot(&serveur);
        let (cache, _poignees) = salon.event_cache().await.map_err(|e| Erreur::Autre(e.to_string()))?;
        let (_, mut abonnement) = cache.subscribe().await.map_err(|e| Erreur::Autre(e.to_string()))?;
        let envoi = maintenant_ms();
        Box::pin(salon.send_raw("m.room.message", json!({ "msgtype": "m.text", "body": commande })).into_future()).await?;
        let reponse = async {
            loop {
                for ev in cache.events().await.unwrap_or_default().iter().rev() {
                    let Ok(json) = serde_json::from_str::<Value>(ev.raw().json().get()) else { continue };
                    if json.get("origin_server_ts").and_then(Value::as_i64).unwrap_or(0) < envoi - 2_000 {
                        break;
                    }
                    if json.get("type").and_then(Value::as_str) != Some("m.room.message")
                        || json.get("sender").and_then(Value::as_str) != Some(robot.as_str())
                    {
                        continue;
                    }
                    let contenu = json.get("content").cloned().unwrap_or(Value::Null);
                    let texte = contenu
                        .get("formatted_body")
                        .or_else(|| contenu.get("body"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !texte.is_empty() {
                        return Some(texte.to_owned());
                    }
                }
                match abonnement.recv().await {
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => return None,
                }
            }
        };
        tokio::time::timeout(DELAI_COMMANDE, reponse)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| Erreur::Autre("Admin command timeout".into()))
    }

    /// Utilisateurs humains du serveur (`getServerUserIds`) : par le robot
    /// (`list-users`), sinon par les salons partagés ; sans moi ni robots.
    async fn utilisateurs_du_serveur(&self, client: &Client) -> Vec<String> {
        let Some(moi) = client.user_id() else { return Vec::new() };
        let suffixe = format!(":{}", moi.server_name());
        let garder = |id: &str| id != moi.as_str() && id.ends_with(&suffixe) && !administration::est_robot(id, false);
        let mut ids: Vec<String> = match Box::pin(self.commande_admin("!admin users list-users")).await {
            Ok(reponse) => administration::liste_utilisateurs(&reponse),
            Err(e) => {
                log::warn!("[Sion][matrix] list-users impossible ({e}) : repli sur les salons partagés");
                let mut vus = Vec::new();
                for salon in client.joined_rooms() {
                    for m in salon.members_no_sync(RoomMemberships::JOIN).await.unwrap_or_default() {
                        vus.push(m.user_id().to_string());
                    }
                }
                vus
            }
        };
        ids.retain(|id| garder(id));
        ids.sort();
        ids.dedup();
        ids
    }

    /// Ouvre un salon public à tous les utilisateurs du serveur
    /// (`fanOutPublicInvites`) : ajout forcé par le robot, sinon invitation.
    async fn ouvrir_a_tous(&self, id: &str) {
        let Ok(client) = self.client_actif().await else { return };
        let Ok(salon) = self.salon(id).await else { return };
        let deja: Vec<String> = salon
            .members_no_sync(RoomMemberships::JOIN)
            .await
            .unwrap_or_default()
            .iter()
            .map(|m| m.user_id().to_string())
            .collect();
        let cibles: Vec<String> = self.utilisateurs_du_serveur(&client).await.into_iter().filter(|u| !deja.contains(u)).collect();
        let mut repli = false;
        let mut ajoutes = 0;
        for cible in &cibles {
            if !repli {
                match Box::pin(self.commande_admin(&format!("!admin users force-join-room {cible} {id}"))).await {
                    Ok(_) => {
                        ajoutes += 1;
                        continue;
                    }
                    Err(e) => {
                        repli = true;
                        log::warn!("[Sion][matrix] ajout forcé impossible ({e}) : repli sur l'invitation");
                    }
                }
            }
            if let Ok(u) = utilisateur(cible) {
                if let Err(e) = Box::pin(salon.invite_user_by_id(&u)).await {
                    log::warn!("[Sion][matrix] invitation de {cible} impossible : {e}");
                }
            }
        }
        log::info!("[Sion][matrix] salon ouvert à tous : {ajoutes} ajout(s) forcé(s) sur {}", cibles.len());
    }
}

/// Réponse de `POST /register` sans authentification → étapes
/// (`getRegistrationFlows`) : 403 = inscription fermée, 401 = étapes,
/// 200 = serveur ouvert (une étape factice).
fn administration_etapes(r: ReponseServeur) -> EtapesInscription {
    let ferme = EtapesInscription { flows: json!([]), params: json!({}), session: String::new(), disabled: true };
    if r.status == 403 {
        return ferme;
    }
    if r.status == 401 || r.corps.get("flows").is_some() {
        return EtapesInscription {
            flows: r.corps.get("flows").cloned().unwrap_or(json!([])),
            params: r.corps.get("params").cloned().unwrap_or(json!({})),
            session: r.corps.get("session").and_then(Value::as_str).unwrap_or("").to_owned(),
            disabled: false,
        };
    }
    if (200..300).contains(&r.status) {
        return EtapesInscription { flows: json!([{ "stages": ["m.login.dummy"] }]), params: json!({}), session: String::new(), disabled: false };
    }
    ferme
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etapes_d_inscription_comme_le_js() {
        let r = |status, corps| administration_etapes(ReponseServeur { status, corps });
        assert!(r(403, json!({ "errcode": "M_FORBIDDEN" })).disabled);
        let e = r(401, json!({ "flows": [{ "stages": ["m.login.registration_token"] }], "session": "s1", "params": {} }));
        assert_eq!((e.disabled, e.session.as_str(), e.flows[0]["stages"][0].as_str()), (false, "s1", Some("m.login.registration_token")));
        assert_eq!(r(200, json!({})).flows, json!([{ "stages": ["m.login.dummy"] }]));
        assert!(r(500, Value::Null).disabled);
    }

    #[test]
    fn auth_par_mot_de_passe_au_format_du_protocole() {
        let a = auth_mot_de_passe("@a:hs", "secret", Some("s1")).unwrap();
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["type"], "m.login.password");
        assert_eq!(v["identifier"], json!({ "type": "m.id.user", "user": "@a:hs" }));
        assert_eq!(v["session"], "s1");
    }
}
