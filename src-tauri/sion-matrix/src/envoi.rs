//! Contenus envoyés — construits À L'IDENTIQUE du moteur JS
//! (`matrixService.ts`, `utils/mentions.ts`), pour qu'une instance sur l'un ou
//! l'autre moteur lise la même chose. Pur : l'adaptateur (`coeur.rs`) envoie
//! par matrix-sdk, qui chiffre d'office dans un salon chiffré.
//!
//! Différences VOULUES avec le moteur JS :
//! - une édition part chiffrée dans un salon chiffré ; le JS l'envoyait en
//!   clair (requête REST brute, contournant son SDK) ;
//! - un fichier ou un GIF est chiffré dans un salon chiffré (`file` au lieu de
//!   `url`) ; le JS le téléversait en clair.
use serde_json::{json, Map, Value};

/// Un membre rejoint, pour les mentions.
pub(crate) struct Membre {
    pub id: String,
    pub nom: String,
}

/// `parseMentions` : `formatted_body` avec liens matrix.to, et les
/// identifiants pour `m.mentions` (MSC3952). `None` sans mention.
pub(crate) fn mentions(corps: &str, membres: &[Membre]) -> Option<(String, Vec<String>)> {
    if !corps.contains('@') || membres.is_empty() {
        return None;
    }
    // Le nom le plus long d'abord (« @John Doe » avant « @John ») ; longueur
    // en UTF-16 et tri stable, comme en JS.
    let mut tries: Vec<&Membre> = membres.iter().filter(|m| !m.nom.is_empty() && !m.id.is_empty()).collect();
    tries.sort_by_key(|m| std::cmp::Reverse(m.nom.encode_utf16().count()));

    let mot = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let mut pris = vec![false; corps.len()];
    let mut touches: Vec<(usize, usize, &Membre)> = Vec::new();
    for membre in tries {
        let aiguille = format!("@{}", membre.nom);
        let mut depuis = 0;
        while let Some(pos) = corps[depuis..].find(&aiguille) {
            let debut = depuis + pos;
            let fin = debut + aiguille.len();
            depuis = debut + 1; // « @ » tient sur un octet
            if pris[debut..fin].iter().any(|&p| p) {
                continue;
            }
            // Ni collé à un mot avant (« email@picsou »), ni prolongé après (« @picsouz »).
            if mot(corps[..debut].chars().next_back()) || mot(corps[fin..].chars().next()) {
                continue;
            }
            touches.push((debut, fin, membre));
            pris[debut..fin].iter_mut().for_each(|p| *p = true);
        }
    }
    if touches.is_empty() {
        return None;
    }
    touches.sort_by_key(|t| t.0);
    let texte = |s: &str| echapper(s).replace('\n', "<br>");
    let mut html = String::new();
    let mut curseur = 0;
    let mut ids: Vec<String> = Vec::new();
    for (debut, fin, membre) in touches {
        html.push_str(&texte(&corps[curseur..debut]));
        html.push_str(&format!(
            "<a href=\"https://matrix.to/#/{}\">{}</a>",
            encoder_composant(&membre.id),
            echapper(&membre.nom)
        ));
        if !ids.contains(&membre.id) {
            ids.push(membre.id.clone());
        }
        curseur = fin;
    }
    html.push_str(&texte(&corps[curseur..]));
    Some((html, ids))
}

fn echapper(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `encodeURIComponent`.
fn encoder_composant(s: &str) -> String {
    let mut sortie = String::new();
    for octet in s.bytes() {
        if octet.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&octet) {
            sortie.push(octet as char);
        } else {
            sortie.push_str(&format!("%{octet:02X}"));
        }
    }
    sortie
}

fn avec_mentions(mut contenu: Map<String, Value>, corps: &str, membres: &[Membre]) -> Value {
    if let Some((html, ids)) = mentions(corps, membres) {
        contenu.insert("format".into(), "org.matrix.custom.html".into());
        contenu.insert("formatted_body".into(), html.into());
        contenu.insert("m.mentions".into(), json!({ "user_ids": ids }));
    }
    Value::Object(contenu)
}

/// `sendTextMessage`.
pub(crate) fn texte(corps: &str, membres: &[Membre]) -> Value {
    let mut c = Map::new();
    c.insert("msgtype".into(), "m.text".into());
    c.insert("body".into(), corps.into());
    avec_mentions(c, corps, membres)
}

/// `sendReply` (sans citation de repli dans le corps, comme le JS).
pub(crate) fn reponse(cible: &str, corps: &str, membres: &[Membre]) -> Value {
    let mut c = Map::new();
    c.insert("msgtype".into(), "m.text".into());
    c.insert("body".into(), corps.into());
    c.insert("m.relates_to".into(), json!({ "m.in_reply_to": { "event_id": cible } }));
    avec_mentions(c, corps, membres)
}

/// `editMessage`.
pub(crate) fn edition(cible: &str, texte: &str) -> Value {
    json!({
        "msgtype": "m.text",
        "body": format!("* {texte}"),
        "m.new_content": { "msgtype": "m.text", "body": texte },
        "m.relates_to": { "rel_type": "m.replace", "event_id": cible },
    })
}

/// `sendReaction` (type `m.reaction`).
pub(crate) fn reaction(cible: &str, cle: &str) -> Value {
    json!({ "m.relates_to": { "rel_type": "m.annotation", "event_id": cible, "key": cle } })
}

/// `sendPoke`.
pub(crate) fn poke() -> Value {
    json!({ "msgtype": "m.poke", "body": "👉 Poke!" })
}

/// `createPoll` (type `m.poll.start`). `fin` : échéance Sion en ms, gardée
/// seulement si elle est dans le futur.
pub(crate) fn sondage(question: &str, options: &[String], secret: bool, max: u32, fin: Option<i64>, maintenant: i64) -> Value {
    let reponses: Vec<Value> = options.iter().enumerate().map(|(i, t)| json!({ "id": i.to_string(), "m.text": t })).collect();
    let repli = std::iter::once(question.to_owned())
        .chain(options.iter().enumerate().map(|(i, o)| format!("{}. {o}", i + 1)))
        .collect::<Vec<_>>()
        .join("\n");
    let mut c = json!({
        "m.poll.start": {
            "question": { "m.text": question },
            "kind": if secret { "m.poll.undisclosed" } else { "m.poll.disclosed" },
            "max_selections": max,
            "answers": reponses,
        },
        "m.text": repli,
    });
    if let Some(fin) = fin.filter(|&f| f > maintenant) {
        c["app.sion.poll_ends_ts"] = fin.into();
    }
    c
}

/// `votePoll` (type `m.poll.response`) ; une liste vide retire le vote.
pub(crate) fn vote(sondage: &str, reponses: &[String]) -> Value {
    json!({
        "m.poll.response": { "answers": reponses },
        "m.relates_to": { "rel_type": "m.reference", "event_id": sondage },
    })
}

/// `endPoll` (type `m.poll.end`).
pub(crate) fn fin_sondage(sondage: &str) -> Value {
    json!({
        "m.poll.end": {},
        "m.text": "Sondage terminé",
        "m.relates_to": { "rel_type": "m.reference", "event_id": sondage },
    })
}

/// `pinMessage` : épingle, ou désépingle s'il l'était déjà.
pub(crate) fn epinglage(actuels: &[String], cible: &str) -> Value {
    let mut epingles: Vec<&str> = actuels.iter().map(String::as_str).filter(|e| *e != cible).collect();
    if epingles.len() == actuels.len() {
        epingles.push(cible);
    }
    json!({ "pinned": epingles })
}

/// Où se trouve le fichier téléversé.
pub(crate) enum Televerse {
    /// Salon en clair : `url`.
    Clair(String),
    /// Salon chiffré : `file` (EncryptedFile).
    Chiffre(Value),
}

/// Dimensions et durée, quand l'appelant les connaît (vidéo préparée).
#[derive(Clone, Debug, Default)]
pub struct InfosMedia {
    pub largeur: Option<u32>,
    pub hauteur: Option<u32>,
    pub duree_ms: Option<u64>,
}

/// `sendFileMessage` / `sendImageUrl`.
pub(crate) fn fichier(corps: &str, mime: &str, taille: u64, source: Televerse, infos: &InfosMedia) -> Value {
    let msgtype = match mime.split('/').next() {
        Some("image") => "m.image",
        Some("video") => "m.video",
        Some("audio") => "m.audio",
        _ => "m.file",
    };
    let mut info = json!({ "mimetype": mime, "size": taille });
    if let (Some(l), Some(h)) = (infos.largeur.filter(|&l| l > 0), infos.hauteur.filter(|&h| h > 0)) {
        info["w"] = l.into();
        info["h"] = h.into();
    }
    if let Some(d) = infos.duree_ms.filter(|&d| d > 0) {
        info["duration"] = d.into();
    }
    let mut c = json!({ "msgtype": msgtype, "body": corps, "info": info });
    match source {
        Televerse::Clair(url) => c["url"] = url.into(),
        Televerse::Chiffre(fichier) => c["file"] = fichier,
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn membres() -> Vec<Membre> {
        [("@john:hs", "John"), ("@johndoe:hs", "John Doe"), ("@greg:hs", "Grégory D")]
            .into_iter()
            .map(|(id, nom)| Membre { id: id.into(), nom: nom.into() })
            .collect()
    }
    fn ids(corps: &str) -> Vec<String> {
        mentions(corps, &membres()).map(|m| m.1).unwrap_or_default()
    }

    // — mentions : les 6 tests de mentions.test.ts

    #[test]
    fn sans_mention() {
        assert!(mentions("salut tout le monde", &membres()).is_none());
        assert!(ids("email@picsou.fr").is_empty());
    }

    #[test]
    fn mention_en_lien_matrix_to() {
        let (html, ids) = mentions("salut @John !", &membres()).unwrap();
        assert_eq!(ids, ["@john:hs"]);
        assert!(html.contains("href=\"https://matrix.to/#/%40john%3Ahs\""));
        assert!(html.contains(">John</a>"));
    }

    #[test]
    fn le_nom_le_plus_long_gagne() {
        assert_eq!(ids("cc @John Doe"), ["@johndoe:hs"]);
    }

    #[test]
    fn unicode_et_faux_positifs_colles() {
        assert_eq!(ids("yo @Grégory D"), ["@greg:hs"]);
        assert!(ids("yo @Johnz").is_empty());
    }

    #[test]
    fn echappe_le_html_et_les_sauts_de_ligne() {
        let (html, _) = mentions("<b>x</b>\n@John", &membres()).unwrap();
        assert!(html.contains("&lt;b&gt;x&lt;/b&gt;<br>"));
    }

    #[test]
    fn plusieurs_membres_chacun_une_fois() {
        let mut v = ids("@John et @John Doe et @John");
        v.sort();
        assert_eq!(v, ["@john:hs", "@johndoe:hs"]);
    }

    #[test]
    fn html_complet_identique_au_js() {
        // Sortie de parseMentions("a @John b", …) côté JS.
        let (html, _) = mentions("a @John b", &membres()).unwrap();
        assert_eq!(html, "a <a href=\"https://matrix.to/#/%40john%3Ahs\">John</a> b");
    }

    // — contenus

    #[test]
    fn texte_simple_ou_mentionne() {
        assert_eq!(texte("salut", &membres()), json!({ "msgtype": "m.text", "body": "salut" }));
        let c = texte("salut @John", &membres());
        assert_eq!(c["format"], "org.matrix.custom.html");
        assert_eq!(c["m.mentions"], json!({ "user_ids": ["@john:hs"] }));
    }

    #[test]
    fn reponse_et_edition() {
        let r = reponse("$a", "ok", &[]);
        assert_eq!(r, json!({ "msgtype": "m.text", "body": "ok", "m.relates_to": { "m.in_reply_to": { "event_id": "$a" } } }));
        let e = edition("$a", "corrigé");
        assert_eq!(e["body"], "* corrigé");
        assert_eq!(e["m.new_content"], json!({ "msgtype": "m.text", "body": "corrigé" }));
        assert_eq!(e["m.relates_to"], json!({ "rel_type": "m.replace", "event_id": "$a" }));
    }

    #[test]
    fn sondage_comme_le_js() {
        let options = vec!["Oui".to_owned(), "Non".to_owned()];
        let c = sondage("On y va ?", &options, false, 1, Some(2_000), 1_000);
        assert_eq!(c["m.text"], "On y va ?\n1. Oui\n2. Non");
        assert_eq!(c["m.poll.start"]["kind"], "m.poll.disclosed");
        assert_eq!(c["m.poll.start"]["answers"][1], json!({ "id": "1", "m.text": "Non" }));
        assert_eq!(c["app.sion.poll_ends_ts"], 2_000);
        // Échéance passée : ignorée.
        assert!(sondage("q", &options, true, 2, Some(500), 1_000).get("app.sion.poll_ends_ts").is_none());
        assert_eq!(vote("$s", &["0".into()])["m.relates_to"]["rel_type"], "m.reference");
        assert_eq!(fin_sondage("$s")["m.text"], "Sondage terminé");
    }

    #[test]
    fn epinglage_bascule() {
        let actuels = vec!["$a".to_owned(), "$b".to_owned()];
        assert_eq!(epinglage(&actuels, "$c"), json!({ "pinned": ["$a", "$b", "$c"] }));
        assert_eq!(epinglage(&actuels, "$a"), json!({ "pinned": ["$b"] }));
    }

    #[test]
    fn fichier_clair_ou_chiffre() {
        let c = fichier("son.mp3", "audio/mpeg", 42, Televerse::Clair("mxc://hs/a".into()), &InfosMedia::default());
        assert_eq!(c, json!({ "msgtype": "m.audio", "body": "son.mp3", "url": "mxc://hs/a", "info": { "mimetype": "audio/mpeg", "size": 42 } }));
        let infos = InfosMedia { largeur: Some(640), hauteur: Some(360), duree_ms: Some(1_500) };
        let v = fichier("v.webm", "video/webm", 9, Televerse::Chiffre(json!({ "url": "mxc://hs/c" })), &infos);
        assert_eq!((v["msgtype"].as_str(), v["file"]["url"].as_str()), (Some("m.video"), Some("mxc://hs/c")));
        assert_eq!(v["info"], json!({ "mimetype": "video/webm", "size": 9, "w": 640, "h": 360, "duration": 1_500 }));
        assert!(v.get("url").is_none());
        assert_eq!(fichier("x", "application/pdf", 1, Televerse::Clair("mxc://hs/x".into()), &InfosMedia::default())["msgtype"], "m.file");
    }
}
