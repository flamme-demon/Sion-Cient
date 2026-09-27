//! Messages d'un salon — port de `extractMessagesFromEvents`
//! (src/stores/useMatrixStore.ts), avec les tests de
//! `src/stores/extractMessages.test.ts` portés à l'identique.
//!
//! Pur : l'adaptateur (`fil.rs`) fournit les événements, déjà déchiffrés
//! quand c'est possible, dans l'ordre chronologique. Les noms, avatars et URL
//! de médias viennent de rappels fournis par l'appelant.
//!
//! Les éditions suivent matrix-js-sdk (`MatrixEvent.getContent()`) : la
//! dernière édition de l'auteur remplace TOUT le contenu du message, type
//! compris (un « poke » corrigé devient un texte), qu'elle soit dans le fil
//! ou groupée par le serveur (`unsigned.m.relations`).
//!
//! Différences VOULUES avec le moteur JS :
//! - la miniature d'une image chiffrée (`info.thumbnail_file`) : le JS ne
//!   savait pas la déchiffrer et n'en affichait aucune ; le cœur Rust la sert
//!   déchiffrée ;
//! - une réponse éditée reste une réponse : la spec garde la relation
//!   d'origine, le JS la perdait ;
//! - une « édition » envoyée par quelqu'un d'autre que l'auteur est ignorée :
//!   le JS en affichait le texte (usurpation possible).
use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::Value;

/// Plafond par salon : on garde les plus récents (`MAX_MESSAGES_PER_ROOM`).
pub(crate) const MAX_MESSAGES_PAR_SALON: usize = 500;
const TEXTE_INDECHIFFRABLE: &str = "🔒 Message chiffré (clé de déchiffrement manquante)";
const DEBUT_SONDAGE: [&str; 2] = ["m.poll.start", "org.matrix.msc3381.poll.start"];
const REPONSE_SONDAGE: [&str; 2] = ["m.poll.response", "org.matrix.msc3381.poll.response"];
const FIN_SONDAGE: [&str; 2] = ["m.poll.end", "org.matrix.msc3381.poll.end"];

/// Un événement du fil, tel que l'adaptateur l'a lu.
#[derive(Clone, Debug, Default)]
pub(crate) struct EvenementBrut {
    pub type_: String,
    pub contenu: Value,
    pub id: String,
    pub expediteur: String,
    pub ts: i64,
    /// Échec de déchiffrement (clé manquante).
    pub echec_dechiffrement: bool,
    /// Dernière édition, groupée par le serveur dans `unsigned`.
    pub edition_groupee: Option<Box<EvenementBrut>>,
}

/// Cible d'une édition (`m.replace`), si l'événement en est une.
fn cible_edition(contenu: &Value) -> Option<&str> {
    (contenu.pointer("/m.relates_to/rel_type")?.as_str()? == "m.replace")
        .then(|| contenu.pointer("/m.relates_to/event_id")?.as_str())
        .flatten()
}

fn est_message(ev: &EvenementBrut) -> bool {
    ev.type_ == "m.room.message" || vrai(ev.contenu.get("msgtype"))
}

/// Contenu en vigueur de chaque message édité : le `m.new_content` de la
/// dernière édition de son auteur (à égalité d'horodatage, la plus tardive
/// dans le fil), comme `Relations.getLastReplacement` de matrix-js-sdk.
fn contenus_en_vigueur(evenements: &[EvenementBrut]) -> HashMap<&str, &Value> {
    let auteurs: HashMap<&str, &str> = evenements.iter().map(|e| (e.id.as_str(), e.expediteur.as_str())).collect();
    let mut retenues: HashMap<&str, (i64, &Value)> = HashMap::new();
    let groupees = evenements.iter().filter_map(|e| e.edition_groupee.as_deref());
    // Les éditions groupées d'abord : celles du fil, plus récentes ou égales,
    // passent devant.
    for edition in groupees.chain(evenements.iter()) {
        if !est_message(edition) {
            continue;
        }
        let Some(cible) = cible_edition(&edition.contenu) else { continue };
        let Some(nouveau) = edition.contenu.get("m.new_content").filter(|n| n.is_object()) else { continue };
        if auteurs.get(cible) != Some(&edition.expediteur.as_str()) {
            continue;
        }
        if retenues.get(cible).is_some_and(|(ts, _)| *ts > edition.ts) {
            continue;
        }
        retenues.insert(cible, (edition.ts, nouveau));
    }
    retenues.into_iter().map(|(cible, (_, nouveau))| (cible, nouveau)).collect()
}

/// Où trouver un média : l'adaptateur en tire une URL servie par Rust.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum SourceMedia {
    Mxc(String),
    /// Fichier chiffré : le JSON `EncryptedFile` complet (url, clé, iv…),
    /// qui ne quitte jamais Rust.
    Chiffre(Value),
}

/// Nom affiché et URL d'avatar d'un utilisateur, s'ils sont connus.
pub(crate) type Profil<'a> = &'a dyn Fn(&str) -> (Option<String>, Option<String>);

/// Rappels fournis par l'appelant.
pub(crate) struct Contexte<'a> {
    pub profil: Profil<'a>,
    /// URL d'un média ; `vignette` demande la miniature serveur (600×400).
    pub url: &'a dyn Fn(&SourceMedia, bool) -> Option<String>,
}

// ── Miroirs des types TypeScript (src/types/matrix.ts) ────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceJointe {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub mime_type: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reponse {
    pub event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msgtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    pub count: usize,
    pub user_ids: Vec<String>,
    pub event_ids: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReponseSondage {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sondage {
    pub question: String,
    pub kind: &'static str,
    pub max_selections: i64,
    pub answers: Vec<ReponseSondage>,
    pub votes: BTreeMap<String, Vec<Value>>,
    pub ended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_ts: Option<i64>,
}

/// Miroir de `ChatMessage`, sans `time` : l'heure affichée est calculée par
/// l'interface à partir de `ts`, dans le fuseau et le format de l'utilisateur.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub event_id: String,
    pub sender_id: String,
    pub user: String,
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub ts: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msgtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<PieceJointe>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Reponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<Reaction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll: Option<Sondage>,
}

// ── Utilitaires JS portés ─────────────────────────────────────────────────────

/// Vérité au sens de JavaScript.
fn vrai(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Chaîne non vide, sinon `None` (le `a || b` de JavaScript).
fn chaine(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn entier(v: Option<&Value>) -> Option<i64> {
    v.and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}

/// `extractReplyQuoteBody` : la citation d'un repli de réponse
/// (`> <@user:hs> texte`), quand l'original n'est pas chargé.
pub(crate) fn citation_de_repli(corps: &str) -> Option<String> {
    let lignes: Vec<&str> = corps.split('\n').take_while(|l| l.starts_with("> ")).map(|l| &l[2..]).collect();
    let premiere = lignes.first()?;
    let premiere = match premiere.strip_prefix('<').and_then(|r| r.split_once('>')) {
        Some((_, reste)) => reste.trim_start(),
        None => premiere,
    };
    let reste = lignes[1..].join("\n");
    let assemble = if reste.is_empty() { premiere.to_owned() } else { format!("{premiere}\n{reste}") };
    let assemble = assemble.trim();
    (!assemble.is_empty()).then(|| assemble.to_owned())
}

/// `stripReplyFallback` : retire la citation et la ligne vide qui suit.
pub(crate) fn sans_repli(corps: &str) -> String {
    let lignes: Vec<&str> = corps.split('\n').collect();
    let mut i = lignes.iter().take_while(|l| l.starts_with("> ")).count();
    if i > 0 && i < lignes.len() && lignes[i].trim().is_empty() {
        i += 1;
    }
    lignes[i..].join("\n")
}

/// `stripMxReply` : retire les blocs `<mx-reply>…</mx-reply>` (casse ignorée).
pub(crate) fn sans_mx_reply(html: &str) -> String {
    let bas = html.to_ascii_lowercase();
    let mut sortie = String::with_capacity(html.len());
    let mut i = 0;
    while let Some(debut) = bas[i..].find("<mx-reply>").map(|d| d + i) {
        let Some(fin) = bas[debut..].find("</mx-reply>").map(|f| f + debut) else { break };
        sortie.push_str(&html[i..debut]);
        i = fin + "</mx-reply>".len();
    }
    sortie.push_str(&html[i..]);
    sortie
}

fn texte_m(noeud: Option<&Value>) -> String {
    noeud
        .and_then(|n| n.get("m.text").or_else(|| n.get("org.matrix.msc1767.text")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// `parsePollStartContent` : formes stable et instable.
pub(crate) fn lire_debut_sondage(contenu: &Value) -> Option<Sondage> {
    let debut = contenu.get("m.poll.start").or_else(|| contenu.get("org.matrix.msc3381.poll.start"))?;
    let reponses = debut.get("answers")?.as_array()?;
    let answers = reponses
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let id = match r.get("id") {
                Some(Value::String(s)) => s.clone(),
                Some(v) if !v.is_null() => v.to_string(),
                _ => i.to_string(),
            };
            let texte = texte_m(Some(r));
            ReponseSondage { id, text: if texte.is_empty() { format!("Option {}", i + 1) } else { texte } }
        })
        .collect();
    let question = Some(texte_m(debut.get("question")))
        .filter(|q| !q.is_empty())
        .or_else(|| chaine(contenu.get("m.text")))
        .unwrap_or_else(|| "Sondage".to_owned());
    let genre = debut.get("kind").and_then(Value::as_str).unwrap_or("");
    Some(Sondage {
        question,
        kind: if genre.contains("undisclosed") { "undisclosed" } else { "disclosed" },
        max_selections: debut.get("max_selections").and_then(Value::as_i64).unwrap_or(1),
        answers,
        votes: BTreeMap::new(),
        ended: false,
        ends_ts: contenu.get("app.sion.poll_ends_ts").and_then(Value::as_i64),
    })
}

// ── Extraction ────────────────────────────────────────────────────────────────

fn nouveau(ev: &EvenementBrut, ctx: &Contexte, texte: String) -> Message {
    let expediteur = if ev.expediteur.is_empty() { "unknown".to_owned() } else { ev.expediteur.clone() };
    let (nom, avatar) = (ctx.profil)(&expediteur);
    Message {
        id: ev.id.clone(),
        event_id: ev.id.clone(),
        user: nom.unwrap_or_else(|| crate::appels::partie_locale(&expediteur)),
        sender_id: expediteur,
        role: "user",
        avatar_url: avatar,
        ts: ev.ts,
        text: texte,
        formatted_body: None,
        msgtype: None,
        attachments: None,
        edited: None,
        reply_to: None,
        reactions: None,
        poll: None,
    }
}

/// Miniature d'une image (`vignetteDe`).
fn vignette(source: &SourceMedia, info: &Value, ctx: &Contexte) -> Option<String> {
    match source {
        SourceMedia::Mxc(_) => (ctx.url)(source, true),
        SourceMedia::Chiffre(_) => {
            // Écart voulu : le JS s'arrêtait là faute de savoir déchiffrer.
            if let Some(fichier) = info.get("thumbnail_file").filter(|f| f.is_object()) {
                return (ctx.url)(&SourceMedia::Chiffre(fichier.clone()), false);
            }
            let miniature = info.get("thumbnail_url").and_then(Value::as_str)?;
            (ctx.url)(&SourceMedia::Mxc(miniature.to_owned()), false)
        }
    }
}

/// Le contenu d'édition, avec la relation d'origine (réponse) gardée.
fn remplacer(ev: &EvenementBrut, nouveau: &Value) -> Value {
    let mut contenu = nouveau.clone();
    if let (Some(objet), Some(relation)) = (contenu.as_object_mut(), ev.contenu.get("m.relates_to")) {
        objet.entry("m.relates_to").or_insert_with(|| relation.clone());
    }
    contenu
}

/// Contenu affiché d'un événement du fil, éditions appliquées.
pub(crate) fn contenu_affiche(evenements: &[EvenementBrut], ev: &EvenementBrut) -> Value {
    match contenus_en_vigueur(evenements).get(ev.id.as_str()) {
        Some(nouveau) if est_message(ev) => remplacer(ev, nouveau),
        _ => ev.contenu.clone(),
    }
}

pub(crate) fn extraire(evenements: &[EvenementBrut], ctx: &Contexte) -> Vec<Message> {
    let mut msgs: Vec<Message> = Vec::new();
    let en_vigueur = contenus_en_vigueur(evenements);
    let mut edites: Vec<&str> = Vec::new();
    for ev in evenements {
        let type_ = ev.type_.as_str();
        let remplace = en_vigueur.get(ev.id.as_str()).filter(|_| est_message(ev)).map(|nouveau| remplacer(ev, nouveau));
        if remplace.is_some() {
            edites.push(ev.id.as_str());
        }
        let contenu = remplace.as_ref().unwrap_or(&ev.contenu);

        // ── Sondages (MSC3381) : début → message ; réponses et fin → agrégat.
        if DEBUT_SONDAGE.contains(&type_) {
            if let Some(sondage) = lire_debut_sondage(contenu) {
                let mut m = nouveau(ev, ctx, sondage.question.clone());
                m.msgtype = Some("m.poll".into());
                m.poll = Some(sondage);
                msgs.push(m);
            }
            continue;
        }
        if REPONSE_SONDAGE.contains(&type_) {
            let cible = chaine(contenu.pointer("/m.relates_to/event_id"));
            let reponses = contenu
                .get("m.poll.response")
                .or_else(|| contenu.get("org.matrix.msc3381.poll.response"))
                .and_then(|r| r.get("answers"))
                .and_then(Value::as_array);
            if let (Some(cible), false, Some(reponses)) = (cible, ev.expediteur.is_empty(), reponses) {
                if let Some(sondage) = msgs.iter_mut().find(|m| m.id == cible && m.poll.is_some()).and_then(|m| m.poll.as_mut()) {
                    if !sondage.ended {
                        sondage.votes.insert(ev.expediteur.clone(), reponses.clone());
                    }
                }
            }
            continue;
        }
        if FIN_SONDAGE.contains(&type_) {
            if let Some(cible) = chaine(contenu.pointer("/m.relates_to/event_id")) {
                if let Some(sondage) = msgs.iter_mut().find(|m| m.id == cible && m.poll.is_some()).and_then(|m| m.poll.as_mut()) {
                    sondage.ended = true;
                }
            }
            continue;
        }

        // Le contenu clair fait foi (un événement déchiffré peut garder le
        // type `m.room.encrypted`).
        let est_message = type_ == "m.room.message" || vrai(contenu.get("msgtype"));
        // Une édition n'est pas un message : son contenu est déjà appliqué
        // au message d'origine.
        if est_message && cible_edition(&ev.contenu).is_some() {
            continue;
        }

        if type_ == "m.room.message" && ev.echec_dechiffrement {
            let mut m = nouveau(ev, ctx, TEXTE_INDECHIFFRABLE.into());
            m.msgtype = Some("m.encrypted".into());
            // Indéchiffrable, mais une édition de l'auteur est lisible (le
            // moteur JS envoyait ses éditions en clair) : son texte remplace
            // le substitut, le type reste « m.encrypted » — comme le JS.
            if let Some(r) = &remplace {
                if let Some(t) = chaine(r.get("body")) {
                    m.text = t;
                }
                m.formatted_body = r
                    .get("formatted_body")
                    .filter(|_| r.get("format").and_then(Value::as_str) == Some("org.matrix.custom.html"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            msgs.push(m);
            continue;
        }
        if !est_message {
            continue;
        }
        let Some(msgtype) = chaine(contenu.get("msgtype")) else { continue };

        match msgtype.as_str() {
            "m.text" | "m.notice" | "m.emote" | "m.poke" => {
                let Some(corps) = chaine(contenu.get("body")) else { continue };

                // Réponse : résolue depuis les messages chargés, sinon citation de repli.
                let reponse = chaine(contenu.pointer("/m.relates_to/m.in_reply_to/event_id")).map(|cible| {
                    let origine = msgs.iter().find(|m| m.id == cible);
                    let texte_origine = origine.map(|o| o.text.clone()).filter(|t| !t.is_empty());
                    Reponse {
                        sender_id: origine.map(|o| o.sender_id.clone()),
                        user: origine.map(|o| o.user.clone()),
                        text: texte_origine.or_else(|| citation_de_repli(&corps)),
                        msgtype: origine.and_then(|o| o.msgtype.clone()),
                        attachment_name: origine
                            .and_then(|o| o.attachments.as_ref())
                            .and_then(|a| a.first())
                            .map(|a| a.name.clone()),
                        event_id: cible,
                    }
                });

                let texte = if reponse.is_some() { sans_repli(&corps) } else { corps };
                let html = if contenu.get("format").and_then(Value::as_str) == Some("org.matrix.custom.html") {
                    contenu.get("formatted_body").and_then(Value::as_str).map(str::to_owned)
                } else {
                    None
                };
                let html = match (html, reponse.is_some()) {
                    (Some(h), true) if !h.is_empty() => Some(sans_mx_reply(&h)),
                    (h, _) => h,
                };
                let mut m = nouveau(ev, ctx, texte);
                m.formatted_body = html;
                m.msgtype = Some(msgtype);
                m.reply_to = reponse;
                msgs.push(m);
            }
            "m.image" | "m.file" | "m.video" | "m.audio" => {
                let source = if let Some(url) = chaine(contenu.get("url")) {
                    SourceMedia::Mxc(url)
                } else if vrai(contenu.pointer("/file/url")) {
                    SourceMedia::Chiffre(contenu["file"].clone())
                } else {
                    continue;
                };
                let Some(url) = (ctx.url)(&source, false) else { continue };
                let vide = Value::Object(Default::default());
                let info = contenu.get("info").filter(|i| i.is_object()).unwrap_or(&vide);
                let type_mime = chaine(info.get("mimetype")).unwrap_or_else(|| {
                    match msgtype.as_str() {
                        "m.image" => "image/jpeg",
                        "m.video" => "video/mp4",
                        "m.audio" => "audio/mpeg",
                        _ => "application/octet-stream",
                    }
                    .to_owned()
                });
                let piece = PieceJointe {
                    id: ev.id.clone(),
                    name: chaine(contenu.get("body")).unwrap_or_else(|| "fichier".into()),
                    size: entier(info.get("size")).filter(|&t| t != 0).unwrap_or(0),
                    mime_type: type_mime,
                    url,
                    thumbnail_url: (msgtype == "m.image").then(|| vignette(&source, info, ctx)).flatten(),
                    width: entier(info.get("w")),
                    height: entier(info.get("h")),
                };
                let mut m = nouveau(ev, ctx, String::new());
                m.attachments = Some(vec![piece]);
                msgs.push(m);
            }
            _ => {}
        }
    }

    for m in msgs.iter_mut().filter(|m| edites.contains(&m.id.as_str())) {
        m.edited = Some(true);
    }

    // Réactions (m.annotation), rattachées aux messages chargés.
    for ev in evenements.iter().filter(|e| e.type_ == "m.reaction") {
        let relation = ev.contenu.get("m.relates_to");
        if relation.and_then(|r| r.get("rel_type")).and_then(Value::as_str) != Some("m.annotation") {
            continue;
        }
        let (Some(cible), Some(cle)) = (
            chaine(relation.and_then(|r| r.get("event_id"))),
            chaine(relation.and_then(|r| r.get("key"))),
        ) else {
            continue;
        };
        let Some(message) = msgs.iter_mut().find(|m| m.id == cible) else { continue };
        let reactions = message.reactions.get_or_insert_with(Vec::new);
        match reactions.iter_mut().find(|r| r.emoji == cle) {
            Some(r) => {
                if !r.user_ids.contains(&ev.expediteur) {
                    r.user_ids.push(ev.expediteur.clone());
                    r.count += 1;
                }
                r.event_ids.insert(ev.expediteur.clone(), ev.id.clone());
            }
            None => reactions.push(Reaction {
                emoji: cle,
                count: 1,
                user_ids: vec![ev.expediteur.clone()],
                event_ids: BTreeMap::from([(ev.expediteur.clone(), ev.id.clone())]),
            }),
        }
    }

    if msgs.len() > MAX_MESSAGES_PAR_SALON {
        msgs.drain(..msgs.len() - MAX_MESSAGES_PAR_SALON);
    }
    msgs
}

#[cfg(test)]
mod tests {
    //! `src/stores/extractMessages.test.ts`, cas par cas.
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn ev(type_: &str, contenu: Value) -> EvenementBrut {
        EvenementBrut {
            type_: type_.into(),
            contenu,
            id: format!("$e{}", SEQ.fetch_add(1, Ordering::Relaxed)),
            expediteur: "@alice:hs".into(),
            ts: 1_700_000_000_000,
            echec_dechiffrement: false,
            edition_groupee: None,
        }
    }
    fn edition(cible: &str, nouveau: Value) -> EvenementBrut {
        let corps = format!("* {}", nouveau["body"].as_str().unwrap_or(""));
        ev(
            "m.room.message",
            json!({
                "msgtype": "m.text", "body": corps,
                "m.relates_to": { "rel_type": "m.replace", "event_id": cible },
                "m.new_content": nouveau
            }),
        )
    }
    fn avec_id(mut e: EvenementBrut, id: &str) -> EvenementBrut {
        e.id = id.into();
        e
    }
    fn de(mut e: EvenementBrut, expediteur: &str) -> EvenementBrut {
        e.expediteur = expediteur.into();
        e
    }

    // Même simulacre que le test JS : Alice est membre, les médias sont servis
    // sous https://hs.test/media/<serveur>/<id>.
    fn extraire_(evs: &[EvenementBrut]) -> Vec<Message> {
        let profil = |id: &str| if id == "@alice:hs" { (Some("Alice".to_owned()), None) } else { (None, None) };
        let url = |s: &SourceMedia, _vignette: bool| match s {
            SourceMedia::Mxc(m) => m.strip_prefix("mxc://").map(|r| format!("https://hs.test/media/{r}")),
            SourceMedia::Chiffre(f) => f["url"].as_str()?.strip_prefix("mxc://").map(|r| format!("https://hs.test/media/{r}")),
        };
        extraire(evs, &Contexte { profil: &profil, url: &url })
    }

    // — texte

    #[test]
    fn texte_avec_le_nom_du_membre() {
        let m = extraire_(&[ev("m.room.message", json!({ "msgtype": "m.text", "body": "salut" }))]);
        assert_eq!((m.len(), m[0].text.as_str(), m[0].user.as_str()), (1, "salut", "Alice"));
    }

    #[test]
    fn membre_inconnu_partie_locale() {
        let m = extraire_(&[de(ev("m.room.message", json!({ "msgtype": "m.text", "body": "yo" })), "@bob:hs")]);
        assert_eq!(m[0].user, "bob");
    }

    #[test]
    fn type_encore_chiffre_mais_contenu_clair() {
        let m = extraire_(&[ev("m.room.encrypted", json!({ "msgtype": "m.text", "body": "déchiffré" }))]);
        assert_eq!((m.len(), m[0].text.as_str()), (1, "déchiffré"));
    }

    #[test]
    fn echec_de_dechiffrement_affiche_un_substitut() {
        let mut e = ev("m.room.message", json!({}));
        e.echec_dechiffrement = true;
        let m = extraire_(&[e]);
        assert_eq!((m.len(), m[0].msgtype.as_deref()), (1, Some("m.encrypted")));
    }

    #[test]
    fn ignore_etat_et_signalisation() {
        let m = extraire_(&[
            ev("m.room.member", json!({ "membership": "join" })),
            ev("com.sion.transcript", json!({ "text": "segment" })),
        ]);
        assert!(m.is_empty());
    }

    // — éditions

    #[test]
    fn edition_appliquee_sans_doublon() {
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "typo" })), "$orig");
        let edit = ev(
            "m.room.message",
            json!({
                "msgtype": "m.text", "body": "* corrigé",
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$orig" },
                "m.new_content": { "msgtype": "m.text", "body": "corrigé" }
            }),
        );
        let m = extraire_(&[orig, edit]);
        assert_eq!((m.len(), m[0].text.as_str(), m[0].edited), (1, "corrigé", Some(true)));
    }

    #[test]
    fn edition_remplace_tout_le_contenu() {
        // Comme `getContent()` de matrix-js-sdk : un « poke » corrigé devient un texte.
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.poke", "body": "👉 Poke!" })), "$p");
        let m = extraire_(&[orig, edition("$p", json!({ "msgtype": "m.text", "body": "👉 Poke!", "format": "org.matrix.custom.html", "formatted_body": "<b>Poke</b>" }))]);
        assert_eq!((m[0].msgtype.as_deref(), m[0].formatted_body.as_deref()), (Some("m.text"), Some("<b>Poke</b>")));
    }

    #[test]
    fn derniere_edition_de_l_auteur_seulement() {
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "a" })), "$o");
        let mut e1 = edition("$o", json!({ "msgtype": "m.text", "body": "b" }));
        e1.ts += 2;
        let mut e2 = edition("$o", json!({ "msgtype": "m.text", "body": "c" }));
        e2.ts += 1; // arrivée après, mais plus ancienne : ignorée
        let intrus = de(edition("$o", json!({ "msgtype": "m.text", "body": "usurpé" })), "@bob:hs");
        let m = extraire_(&[orig, e1, e2, intrus]);
        assert_eq!((m.len(), m[0].text.as_str()), (1, "b"));
    }

    #[test]
    fn edition_d_un_autre_ignoree() {
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "vrai" })), "$o");
        let m = extraire_(&[orig, de(edition("$o", json!({ "msgtype": "m.text", "body": "usurpé" })), "@bob:hs")]);
        assert_eq!((m.len(), m[0].text.as_str(), m[0].edited), (1, "vrai", None));
    }

    #[test]
    fn edition_groupee_par_le_serveur() {
        let mut orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "typo" })), "$o");
        orig.edition_groupee = Some(Box::new(edition("$o", json!({ "msgtype": "m.text", "body": "corrigé" }))));
        let m = extraire_(&[orig]);
        assert_eq!((m[0].text.as_str(), m[0].edited), ("corrigé", Some(true)));
    }

    #[test]
    fn reponse_editee_reste_une_reponse() {
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "question" })), "$q");
        let rep = avec_id(
            de(
                ev("m.room.message", json!({ "msgtype": "m.text", "body": "> <@alice:hs> question\n\nréponse", "m.relates_to": { "m.in_reply_to": { "event_id": "$q" } } })),
                "@bob:hs",
            ),
            "$r",
        );
        let edit = de(edition("$r", json!({ "msgtype": "m.text", "body": "réponse corrigée" })), "@bob:hs");
        let m = extraire_(&[orig, rep, edit]);
        assert_eq!((m.len(), m[1].text.as_str()), (2, "réponse corrigée"));
        assert_eq!(m[1].reply_to.as_ref().map(|r| r.event_id.as_str()), Some("$q"));
    }

    #[test]
    fn edition_lisible_d_un_message_indechiffrable() {
        let mut orig = avec_id(ev("m.room.message", json!({})), "$o");
        orig.echec_dechiffrement = true;
        let m = extraire_(&[orig, edition("$o", json!({ "msgtype": "m.text", "body": "lisible" }))]);
        assert_eq!((m.len(), m[0].text.as_str(), m[0].edited), (1, "lisible", Some(true)));
        assert_eq!(m[0].msgtype.as_deref(), Some("m.encrypted"));
    }

    #[test]
    fn edition_hors_fenetre_ignoree() {
        let edit = ev(
            "m.room.message",
            json!({
                "msgtype": "m.text", "body": "* corrigé",
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$absent" },
                "m.new_content": { "msgtype": "m.text", "body": "corrigé" }
            }),
        );
        assert!(extraire_(&[edit]).is_empty());
    }

    // — réponses

    const CORPS_REPONSE: &str = "> <@alice:hs> message original\n\nma réponse";

    #[test]
    fn reponse_resolue_et_repli_retire() {
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "message original" })), "$orig");
        let rep = de(
            ev(
                "m.room.message",
                json!({ "msgtype": "m.text", "body": CORPS_REPONSE, "m.relates_to": { "m.in_reply_to": { "event_id": "$orig" } } }),
            ),
            "@bob:hs",
        );
        let m = extraire_(&[orig, rep]);
        assert_eq!(m[1].text, "ma réponse");
        let r = m[1].reply_to.as_ref().unwrap();
        assert_eq!((r.event_id.as_str(), r.user.as_deref(), r.text.as_deref()), ("$orig", Some("Alice"), Some("message original")));
    }

    #[test]
    fn reponse_hors_fenetre_citation_de_repli() {
        let rep = ev(
            "m.room.message",
            json!({ "msgtype": "m.text", "body": CORPS_REPONSE, "m.relates_to": { "m.in_reply_to": { "event_id": "$absent" } } }),
        );
        let m = extraire_(&[rep]);
        assert_eq!(m[0].reply_to.as_ref().unwrap().text.as_deref(), Some("message original"));
        assert_eq!(m[0].text, "ma réponse");
    }

    // — réactions

    fn reaction(cible: &str, cle: &str, qui: &str) -> EvenementBrut {
        de(ev("m.reaction", json!({ "m.relates_to": { "rel_type": "m.annotation", "event_id": cible, "key": cle } })), qui)
    }

    #[test]
    fn reactions_agregees_et_dedoublonnees() {
        let orig = avec_id(ev("m.room.message", json!({ "msgtype": "m.text", "body": "gg" })), "$m");
        let m = extraire_(&[
            orig,
            reaction("$m", "👍", "@alice:hs"),
            reaction("$m", "👍", "@bob:hs"),
            reaction("$m", "👍", "@bob:hs"),
            reaction("$m", "🎉", "@bob:hs"),
        ]);
        let r = m[0].reactions.as_ref().unwrap();
        assert_eq!(r.len(), 2);
        let pouce = r.iter().find(|x| x.emoji == "👍").unwrap();
        assert_eq!((pouce.count, pouce.user_ids.clone()), (2, vec!["@alice:hs".to_owned(), "@bob:hs".to_owned()]));
        assert_eq!(r.iter().find(|x| x.emoji == "🎉").unwrap().count, 1);
    }

    #[test]
    fn reaction_hors_fenetre_ignoree() {
        assert!(extraire_(&[reaction("$absent", "👍", "@alice:hs")]).is_empty());
    }

    // — médias

    #[test]
    fn fichier_chiffre_sans_cle_cote_interface() {
        let m = extraire_(&[ev(
            "m.room.message",
            json!({
                "msgtype": "m.image", "body": "photo.png",
                "info": { "mimetype": "image/png", "size": 1234, "w": 10, "h": 20 },
                "file": { "url": "mxc://hs/abc", "key": { "k": "secret" }, "iv": "iv0" }
            }),
        )]);
        let p = &m[0].attachments.as_ref().unwrap()[0];
        assert_eq!((p.url.as_str(), p.name.as_str(), p.size, p.width, p.height), ("https://hs.test/media/hs/abc", "photo.png", 1234, Some(10), Some(20)));
        // Écart voulu avec le JS : aucune clé ne part vers l'interface.
        assert!(!serde_json::to_string(&m[0]).unwrap().contains("secret"));
    }

    #[test]
    fn media_sans_url_ignore() {
        assert!(extraire_(&[ev("m.room.message", json!({ "msgtype": "m.image", "body": "x" }))]).is_empty());
    }

    #[test]
    fn miniature_d_image_chiffree_servie() {
        let m = extraire_(&[ev(
            "m.room.message",
            json!({
                "msgtype": "m.image", "body": "p.png",
                "info": { "thumbnail_file": { "url": "mxc://hs/mini" } },
                "file": { "url": "mxc://hs/grand" }
            }),
        )]);
        let p = &m[0].attachments.as_ref().unwrap()[0];
        assert_eq!(p.thumbnail_url.as_deref(), Some("https://hs.test/media/hs/mini"));
    }

    // — sondages

    fn debut_sondage() -> EvenementBrut {
        avec_id(
            ev(
                "org.matrix.msc3381.poll.start",
                json!({ "org.matrix.msc3381.poll.start": {
                    "question": { "org.matrix.msc1767.text": "Pizza ?" },
                    "kind": "org.matrix.msc3381.poll.disclosed",
                    "max_selections": 1,
                    "answers": [
                        { "id": "a", "org.matrix.msc1767.text": "Oui" },
                        { "id": "b", "org.matrix.msc1767.text": "Non" }
                    ]
                } }),
            ),
            "$poll",
        )
    }

    #[test]
    fn sondage_debut_votes_et_fin() {
        let vote = de(
            ev(
                "org.matrix.msc3381.poll.response",
                json!({ "m.relates_to": { "event_id": "$poll" }, "org.matrix.msc3381.poll.response": { "answers": ["a"] } }),
            ),
            "@bob:hs",
        );
        let fin = ev("org.matrix.msc3381.poll.end", json!({ "m.relates_to": { "event_id": "$poll" } }));
        let m = extraire_(&[debut_sondage(), vote, fin]);
        assert_eq!(m.len(), 1);
        let s = m[0].poll.as_ref().unwrap();
        assert_eq!((s.question.as_str(), s.ended), ("Pizza ?", true));
        assert_eq!(s.votes.get("@bob:hs"), Some(&vec![json!("a")]));
    }

    #[test]
    fn votes_apres_cloture_refuses() {
        let fin = ev("org.matrix.msc3381.poll.end", json!({ "m.relates_to": { "event_id": "$poll" } }));
        let tard = de(
            ev(
                "org.matrix.msc3381.poll.response",
                json!({ "m.relates_to": { "event_id": "$poll" }, "org.matrix.msc3381.poll.response": { "answers": ["b"] } }),
            ),
            "@bob:hs",
        );
        let m = extraire_(&[debut_sondage(), fin, tard]);
        assert!(m[0].poll.as_ref().unwrap().votes.is_empty());
    }

    // — utilitaires de repli

    #[test]
    fn citation_multiligne() {
        assert_eq!(citation_de_repli("> <@a:hs> ligne 1\n> ligne 2\n\nréponse").as_deref(), Some("ligne 1\nligne 2"));
        assert_eq!(citation_de_repli("pas de citation"), None);
    }

    #[test]
    fn repli_retire() {
        assert_eq!(sans_repli("> <@a:hs> quoté\n\nma réponse"), "ma réponse");
        assert_eq!(sans_repli("sans fallback"), "sans fallback");
    }

    #[test]
    fn mx_reply_retire() {
        assert_eq!(sans_mx_reply("<mx-reply><blockquote>q</blockquote></mx-reply>réponse"), "réponse");
        assert_eq!(sans_mx_reply("<MX-REPLY>x</MX-REPLY>ok"), "ok");
    }

    // — parsePollStartContent

    #[test]
    fn sondage_formes_stable_et_instable() {
        let s = lire_debut_sondage(&json!({ "m.poll.start": { "question": { "m.text": "Q" }, "answers": [{ "id": "x", "m.text": "R" }] } })).unwrap();
        assert_eq!((s.question.as_str(), s.answers[0].id.as_str(), s.answers[0].text.as_str(), s.kind), ("Q", "x", "R", "disclosed"));
        assert!(lire_debut_sondage(&json!({ "foo": 1 })).is_none());
    }

    #[test]
    fn sondage_non_divulgue_et_plafond() {
        let s = lire_debut_sondage(&json!({ "m.poll.start": {
            "question": { "m.text": "Q" }, "kind": "org.matrix.msc3381.poll.undisclosed",
            "max_selections": 3, "answers": [{ "m.text": "A" }]
        } }))
        .unwrap();
        assert_eq!((s.kind, s.max_selections), ("undisclosed", 3));
    }

    #[test]
    fn plafond_de_cinq_cents_messages_les_plus_recents() {
        let evs: Vec<_> = (0..520).map(|i| ev("m.room.message", json!({ "msgtype": "m.text", "body": format!("m{i}") }))).collect();
        let m = extraire_(&evs);
        assert_eq!((m.len(), m[0].text.as_str()), (500, "m20"));
    }
}
