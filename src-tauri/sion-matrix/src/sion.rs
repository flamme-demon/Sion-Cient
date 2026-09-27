//! Fonctions propres à Sion (tranche T6), partie pure : ports exacts de
//! `soundboardService.ts` (lecture des sons, surcouche des éditions, contenus
//! d'ajout et d'édition), `memeboardService.ts` (lecture et contenu des
//! memes) et des versions de client (`com.sion.client_version`).
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::messages::EvenementBrut;

/// Espace de noms des métadonnées d'un son (`m.audio`).
pub(crate) const ESPACE_SON: &str = "com.sion.soundboard";
/// Espace de noms d'un meme (`m.video` / `m.image`).
pub(crate) const ESPACE_MEME: &str = "com.sion.meme";
/// Version du client, événement d'état dont la clé est l'utilisateur.
pub(crate) const EVENEMENT_VERSION: &str = "com.sion.client_version";

/// Bornes du gain à l'ENVOI (`SOUND_GAIN_MIN` / `SOUND_GAIN_MAX`) ; à la
/// lecture, le JS tolère jusqu'à 5.
const GAIN_MAX_ENVOI: f64 = 3.0;
const GAIN_MAX_LECTURE: f64 = 5.0;
/// Taille et durée maximales d'un son (`SOUNDBOARD_MAX_FILE_SIZE`,
/// `SOUNDBOARD_MAX_DURATION_MS`).
pub(crate) const TAILLE_MAX_SON: u64 = 1024 * 1024;
pub(crate) const DUREE_MAX_SON_MS: i64 = 20_000;

/// Miroir de `SoundEntry`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Son {
    pub event_id: String,
    pub mxc_url: String,
    pub label: String,
    pub category: String,
    pub emoji: Option<String>,
    pub body: String,
    pub mimetype: String,
    pub size: u64,
    pub duration: Option<i64>,
    pub sender_id: String,
    pub timestamp: i64,
    pub gain: f64,
    pub ref_text: Option<String>,
    pub avatar_url: Option<String>,
    pub kind: &'static str,
    pub tts_model: Option<String>,
}

/// Miroir de `MemeEntry`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meme {
    pub event_id: String,
    pub mxc_url: String,
    pub apercu_mxc: Option<String>,
    pub label: String,
    pub emoji: Option<String>,
    pub gain: f64,
    pub duration_ms: Option<i64>,
    pub largeur: Option<i64>,
    pub hauteur: Option<i64>,
    pub sender_id: String,
    pub timestamp: i64,
}

/// Miroir de `SionMemberVersion`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMembre {
    pub user_id: String,
    pub version: String,
    pub os: String,
    pub ts: i64,
}

// ── Petits outils calqués sur le JS ─────────────────────────────────────────

/// Chaîne « vraie » au sens JS (présente et non vide).
fn texte(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Nombre fini (`typeof x === "number" && Number.isFinite(x)`).
fn nombre(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// `stripExtension` : `/\.[^.]+$/` retiré.
fn sans_extension(nom: &str) -> String {
    match nom.rfind('.') {
        Some(i) if i + 1 < nom.len() => nom[..i].to_owned(),
        _ => nom.to_owned(),
    }
}

/// `normalizeCategory`.
pub(crate) fn categorie(brute: Option<&str>) -> String {
    let nette = brute.unwrap_or("").split('/').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/");
    if nette.is_empty() { "Autre".to_owned() } else { nette }
}

/// `clampGain` (valeur non finie → 1).
fn borne_gain(g: f64) -> f64 {
    if g.is_finite() { g.clamp(0.0, GAIN_MAX_ENVOI) } else { 1.0 }
}

/// `label.trim().slice(0, 60)`.
fn etiquette(label: &str) -> String {
    label.trim().chars().take(60).collect()
}

fn est_edition(contenu: &Value) -> bool {
    contenu.pointer("/m.relates_to/rel_type").and_then(Value::as_str) == Some("m.replace")
}

// ── Soundboard ──────────────────────────────────────────────────────────────

/// `parseSound`.
fn lire_son(ev: &EvenementBrut) -> Option<Son> {
    if ev.id.is_empty() {
        return None;
    }
    let c = &ev.contenu;
    if c.get("msgtype").and_then(Value::as_str) != Some("m.audio") {
        return None;
    }
    let url = c.get("url").and_then(Value::as_str).filter(|u| u.starts_with("mxc://"))?;
    let meta = c.get(ESPACE_SON).cloned().unwrap_or(Value::Null);
    let corps = texte(c.get("body")).unwrap_or_else(|| "sound".to_owned());
    let gain = nombre(meta.get("gain_pct")).map(|p| p / 100.0).or(nombre(meta.get("gain"))).unwrap_or(1.0);
    let cat = categorie(meta.get("category").and_then(Value::as_str));
    Some(Son {
        event_id: ev.id.clone(),
        mxc_url: url.to_owned(),
        label: texte(meta.get("label")).unwrap_or_else(|| sans_extension(&corps)),
        emoji: texte(meta.get("emoji")),
        mimetype: texte(c.pointer("/info/mimetype")).unwrap_or_else(|| "audio/mpeg".to_owned()),
        size: nombre(c.pointer("/info/size")).filter(|&t| t > 0.0).map_or(0, |t| t as u64),
        duration: c.pointer("/info/duration").and_then(Value::as_i64),
        sender_id: ev.expediteur.clone(),
        timestamp: ev.ts,
        gain: gain.clamp(0.0, GAIN_MAX_LECTURE),
        ref_text: texte(meta.get("ref_text")),
        avatar_url: texte(meta.get("avatar")),
        // Repli sur la catégorie pour les voix d'avant le drapeau.
        kind: if meta.get("kind").and_then(Value::as_str) == Some("voice") || cat == "Voix" { "voice" } else { "sound" },
        tts_model: texte(meta.get("tts_model")),
        category: cat,
        body: corps,
    })
}

/// `listSounds` : les sons d'origine, avec les métadonnées de leur dernière
/// édition (quel qu'en soit l'auteur, comme le JS), du plus récent au plus
/// ancien. Un son supprimé (contenu vidé) disparaît de lui-même.
pub(crate) fn sons(evenements: &[EvenementBrut]) -> Vec<Son> {
    let mut sons: Vec<Son> = evenements.iter().filter(|e| !est_edition(&e.contenu)).filter_map(lire_son).collect();
    // Dernière édition de chaque son (strictement plus récente).
    let mut editions: std::collections::HashMap<&str, (i64, Option<&Value>)> = std::collections::HashMap::new();
    for ev in evenements {
        if !est_edition(&ev.contenu) {
            continue;
        }
        let Some(cible) = ev.contenu.pointer("/m.relates_to/event_id").and_then(Value::as_str) else { continue };
        let Some(nouveau) = ev.contenu.get("m.new_content") else { continue };
        if editions.get(cible).is_none_or(|(ts, _)| ev.ts > *ts) {
            editions.insert(cible, (ev.ts, nouveau.get(ESPACE_SON)));
        }
    }
    for son in &mut sons {
        let Some((_, Some(meta))) = editions.get(son.event_id.as_str()) else { continue };
        let a = |cle: &str| meta.get(cle).is_some();
        if let Some(l) = texte(meta.get("label")) {
            son.label = l;
        }
        if let Some(c) = texte(meta.get("category")) {
            son.category = categorie(Some(&c));
        }
        if a("emoji") {
            son.emoji = texte(meta.get("emoji"));
        }
        // Une édition sans gain ramène au niveau d'origine.
        son.gain = if a("gain_pct") {
            nombre(meta.get("gain_pct")).map_or(1.0, |p| p / 100.0)
        } else if a("gain") {
            nombre(meta.get("gain")).unwrap_or(1.0)
        } else {
            1.0
        }
        .clamp(0.0, GAIN_MAX_LECTURE);
        if a("ref_text") {
            son.ref_text = texte(meta.get("ref_text"));
        }
        if a("avatar") {
            son.avatar_url = texte(meta.get("avatar"));
        }
        if a("tts_model") {
            son.tts_model = texte(meta.get("tts_model"));
        }
    }
    sons.sort_by_key(|s| std::cmp::Reverse(s.timestamp));
    sons
}

/// Ce qui distingue une voix de référence (synthèse) d'un son.
#[derive(Clone, Debug, Default)]
pub struct Voix {
    pub ref_text: Option<String>,
    pub avatar: Option<String>,
}

/// Contenu d'un nouveau son (`uploadSound`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn contenu_nouveau_son(
    nom_fichier: &str,
    mxc: &str,
    mime: &str,
    taille: u64,
    duree: Option<i64>,
    label: &str,
    cat: &str,
    emoji: Option<&str>,
    gain: f64,
    voix: Option<&Voix>,
    modele: Option<&str>,
) -> Value {
    let mut meta = Map::new();
    meta.insert("label".into(), Some(etiquette(label)).filter(|l| !l.is_empty()).unwrap_or_else(|| sans_extension(nom_fichier)).into());
    meta.insert("category".into(), categorie(Some(cat)).into());
    if let Some(e) = emoji.filter(|e| !e.is_empty()) {
        meta.insert("emoji".into(), e.into());
    }
    // Pourcentage entier : Matrix refuse les nombres à virgule (M_BAD_JSON).
    if gain != 1.0 {
        meta.insert("gain_pct".into(), ((borne_gain(gain) * 100.0).round() as i64).into());
    }
    if let Some(v) = voix {
        meta.insert("kind".into(), "voice".into());
        if let Some(t) = v.ref_text.as_deref().filter(|t| !t.is_empty()) {
            meta.insert("ref_text".into(), t.into());
        }
        if let Some(a) = v.avatar.as_deref().filter(|a| !a.is_empty()) {
            meta.insert("avatar".into(), a.into());
        }
    }
    if let Some(m) = modele.filter(|m| !m.is_empty()) {
        meta.insert("tts_model".into(), m.into());
    }
    let mut info = json!({ "mimetype": mime, "size": taille });
    if let Some(d) = duree {
        info["duration"] = d.into();
    }
    json!({ "msgtype": "m.audio", "body": nom_fichier, "url": mxc, "info": info, ESPACE_SON: meta })
}

/// Changement d'un champ de voix à l'édition : absent = inchangé, `Some(None)`
/// = effacé (le JS distingue `undefined` et `null`).
pub type ChampVoix = Option<Option<String>>;

/// Contenu d'une édition de son (`editSound`) : un remplacement complet, qui
/// reprend `kind` et le modèle — sans quoi renommer une voix la rendrait à la
/// soundboard.
pub(crate) fn contenu_edition_son(
    original: &Son,
    label: &str,
    cat: &str,
    emoji: Option<&str>,
    gain: f64,
    ref_text: ChampVoix,
    avatar: ChampVoix,
) -> Value {
    let mut meta = Map::new();
    meta.insert("label".into(), Some(etiquette(label)).filter(|l| !l.is_empty()).unwrap_or_else(|| original.label.clone()).into());
    meta.insert("category".into(), categorie(Some(cat)).into());
    if let Some(e) = emoji.filter(|e| !e.is_empty()) {
        meta.insert("emoji".into(), e.into());
    }
    let borne = borne_gain(gain);
    if borne != 1.0 {
        meta.insert("gain_pct".into(), ((borne * 100.0).round() as i64).into());
    }
    if original.kind == "voice" {
        meta.insert("kind".into(), "voice".into());
    }
    if let Some(m) = &original.tts_model {
        meta.insert("tts_model".into(), m.clone().into());
    }
    if let Some(t) = ref_text {
        meta.insert("ref_text".into(), t.unwrap_or_default().into());
    }
    if let Some(a) = avatar {
        meta.insert("avatar".into(), a.unwrap_or_default().into());
    }
    let mut info = json!({ "mimetype": original.mimetype, "size": original.size });
    if let Some(d) = original.duration {
        info["duration"] = d.into();
    }
    let base = json!({ "msgtype": "m.audio", "body": original.body, "url": original.mxc_url, "info": info, ESPACE_SON: meta });
    let mut contenu = base.clone();
    contenu["m.new_content"] = base;
    contenu["m.relates_to"] = json!({ "rel_type": "m.replace", "event_id": original.event_id });
    contenu
}

// ── Memeboard ───────────────────────────────────────────────────────────────

/// `lireMeme`.
fn lire_meme(ev: &EvenementBrut) -> Option<Meme> {
    if ev.id.is_empty() || est_edition(&ev.contenu) {
        return None;
    }
    let c = &ev.contenu;
    let meta = c.get(ESPACE_MEME).filter(|m| m.is_object())?;
    let url = c.get("url").and_then(Value::as_str).filter(|u| u.starts_with("mxc://"))?;
    Some(Meme {
        event_id: ev.id.clone(),
        mxc_url: url.to_owned(),
        apercu_mxc: c.pointer("/info/thumbnail_url").and_then(Value::as_str).map(str::to_owned),
        label: texte(meta.get("label")).or_else(|| texte(c.get("body"))).unwrap_or_else(|| "meme".to_owned()),
        emoji: texte(meta.get("emoji")),
        gain: nombre(meta.get("gain_pct")).map_or(1.0, |p| (p / 100.0).clamp(0.0, GAIN_MAX_ENVOI)),
        duration_ms: c.pointer("/info/duration").and_then(Value::as_i64),
        largeur: c.pointer("/info/w").and_then(Value::as_i64),
        hauteur: c.pointer("/info/h").and_then(Value::as_i64),
        sender_id: ev.expediteur.clone(),
        timestamp: ev.ts,
    })
}

/// `listMemes`, du plus récent au plus ancien.
pub(crate) fn memes(evenements: &[EvenementBrut]) -> Vec<Meme> {
    let mut memes: Vec<Meme> = evenements.iter().filter_map(lire_meme).collect();
    memes.sort_by_key(|m| std::cmp::Reverse(m.timestamp));
    memes
}

/// Ce que produit la préparation d'un meme (`MemePrepare`), téléversé.
pub struct MemeTeleverse<'a> {
    pub mxc: &'a str,
    pub mime: &'a str,
    pub taille: u64,
    pub largeur: i64,
    pub hauteur: i64,
    pub duree_ms: i64,
    pub apercu: Option<(&'a str, &'a str)>,
}

/// Nom de fichier d'un meme (`envoyerMeme`) : lettres, chiffres, espace, `_`
/// et `-` gardés.
pub(crate) fn nom_fichier_meme(label: &str, gif: bool) -> String {
    let net: String = label.chars().filter(|c| c.is_alphanumeric() || " _-".contains(*c)).collect();
    let net = net.trim();
    format!("{}.{}", if net.is_empty() { "meme" } else { net }, if gif { "gif" } else { "mp4" })
}

/// Contenu d'un meme (`envoyerMeme`).
pub(crate) fn contenu_meme(m: &MemeTeleverse, nom_fichier: &str, label: &str, emoji: Option<&str>) -> Value {
    let mut info = json!({ "mimetype": m.mime, "size": m.taille, "w": m.largeur, "h": m.hauteur, "duration": m.duree_ms });
    if let Some((mxc, mime)) = m.apercu {
        info["thumbnail_url"] = mxc.into();
        info["thumbnail_info"] = json!({ "mimetype": mime });
    }
    let label = label.trim();
    json!({
        "msgtype": if m.mime == "image/gif" { "m.image" } else { "m.video" },
        "body": nom_fichier,
        "url": m.mxc,
        "info": info,
        ESPACE_MEME: { "label": if label.is_empty() { "meme" } else { label }, "emoji": emoji.filter(|e| !e.is_empty()), "gain_pct": 100 },
    })
}

// ── Versions de client ──────────────────────────────────────────────────────

/// `getRoomClientVersions` : (clé d'état, contenu) → versions, la plus
/// récente d'abord ; un membre sans version est absent.
pub(crate) fn versions(etats: &[(String, Value)]) -> Vec<VersionMembre> {
    let mut liste: Vec<VersionMembre> = etats
        .iter()
        .filter(|(id, _)| !id.is_empty())
        .filter_map(|(id, c)| {
            Some(VersionMembre {
                user_id: id.clone(),
                version: texte(c.get("version"))?,
                os: texte(c.get("os")).unwrap_or_else(|| "?".to_owned()),
                ts: nombre(c.get("ts")).map_or(0, |t| t as i64),
            })
        })
        .collect();
    liste.sort_by_key(|v| std::cmp::Reverse(v.ts));
    liste
}

/// `ouvrirDroitAnnonceVersion` : les niveaux à écrire pour que tout membre
/// puisse annoncer sa version, ou `None` s'il n'y a rien à faire (déjà
/// ouvert) ou pas le droit. `mon_niveau` vient de matrix-sdk : il connaît le
/// créateur d'un salon v12, de niveau infini, que le JS (qui lit la table)
/// croyait à 0 — et qui ne pouvait donc jamais ouvrir ce droit.
pub(crate) fn niveaux_avec_version_ouverte(niveaux: &Value, mon_niveau: i64) -> Option<Value> {
    if niveaux.pointer(&format!("/events/{EVENEMENT_VERSION}")).and_then(Value::as_i64) == Some(0) {
        return None;
    }
    let requis = niveaux
        .pointer("/events/m.room.power_levels")
        .and_then(Value::as_i64)
        .or(niveaux.get("state_default").and_then(Value::as_i64))
        .unwrap_or(50);
    if mon_niveau < requis {
        return None;
    }
    let mut nouveau = niveaux.clone();
    if !nouveau.get("events").is_some_and(Value::is_object) {
        nouveau["events"] = json!({});
    }
    nouveau["events"][EVENEMENT_VERSION] = 0.into();
    Some(nouveau)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, ts: i64, contenu: Value) -> EvenementBrut {
        EvenementBrut { type_: "m.room.message".into(), contenu, id: id.into(), expediteur: "@a:hs".into(), ts, ..Default::default() }
    }

    fn son_brut(id: &str, ts: i64, meta: Value) -> EvenementBrut {
        ev(id, ts, json!({ "msgtype": "m.audio", "body": "ouf.mp3", "url": "mxc://hs/o", "info": { "mimetype": "audio/mpeg", "size": 42, "duration": 900 }, ESPACE_SON: meta }))
    }

    #[test]
    fn lecture_d_un_son() {
        let s = &sons(&[son_brut("$s", 1, json!({ "label": "Ouf", "category": " Réactions / Drôle ", "gain_pct": 240 }))])[0];
        assert_eq!((s.label.as_str(), s.category.as_str(), s.gain, s.kind), ("Ouf", "Réactions/Drôle", 2.4, "sound"));
        assert_eq!((s.size, s.duration, s.mimetype.as_str()), (42, Some(900), "audio/mpeg"));
        // Sans métadonnées : nom de fichier sans extension, catégorie « Autre ».
        let s = &sons(&[son_brut("$t", 1, Value::Null)])[0];
        assert_eq!((s.label.as_str(), s.category.as_str(), s.gain), ("ouf", "Autre", 1.0));
        // Ancien gain multiplicateur, et voix d'avant le drapeau.
        let s = &sons(&[son_brut("$u", 1, json!({ "gain": 2, "category": "Voix" }))])[0];
        assert_eq!((s.gain, s.kind), (2.0, "voice"));
    }

    #[test]
    fn ignore_ce_qui_n_est_pas_un_son() {
        let pas_audio = ev("$x", 1, json!({ "msgtype": "m.text", "body": "salut" }));
        let sans_mxc = ev("$y", 1, json!({ "msgtype": "m.audio", "body": "a", "url": "https://x" }));
        let supprime = ev("$z", 1, json!({}));
        assert!(sons(&[pas_audio, sans_mxc, supprime]).is_empty());
    }

    #[test]
    fn la_derniere_edition_s_applique() {
        let orig = son_brut("$s", 1, json!({ "label": "Ouf", "emoji": "😮", "gain_pct": 200 }));
        let edition = |ts, meta: Value| {
            ev("$e", ts, json!({ "m.relates_to": { "rel_type": "m.replace", "event_id": "$s" }, "m.new_content": { ESPACE_SON: meta } }))
        };
        let liste = sons(&[orig, edition(3, json!({ "label": "Final", "category": "B" })), edition(2, json!({ "label": "Ancienne" }))]);
        assert_eq!(liste.len(), 1);
        let s = &liste[0];
        // Édition sans gain : retour à 1 ; sans « emoji » : emoji inchangé.
        assert_eq!((s.label.as_str(), s.category.as_str(), s.gain, s.emoji.as_deref()), ("Final", "B", 1.0, Some("😮")));
    }

    #[test]
    fn tri_du_plus_recent() {
        let liste = sons(&[son_brut("$a", 1, Value::Null), son_brut("$b", 3, Value::Null), son_brut("$c", 2, Value::Null)]);
        assert_eq!(liste.iter().map(|s| s.event_id.as_str()).collect::<Vec<_>>(), ["$b", "$c", "$a"]);
    }

    #[test]
    fn contenu_d_un_nouveau_son() {
        let voix = Voix { ref_text: Some("bonjour".into()), avatar: None };
        let c = contenu_nouveau_son("clip.ogg", "mxc://hs/c", "audio/ogg", 10, Some(1500), "  Mon clip  ", "", None, 4.0, Some(&voix), Some("qwen"));
        assert_eq!(c[ESPACE_SON], json!({ "label": "Mon clip", "category": "Autre", "gain_pct": 300, "kind": "voice", "ref_text": "bonjour", "tts_model": "qwen" }));
        assert_eq!(c["info"], json!({ "mimetype": "audio/ogg", "size": 10, "duration": 1500 }));
        let c = contenu_nouveau_son("clip.ogg", "mxc://hs/c", "audio/ogg", 10, None, "", "A", Some("🔊"), 1.0, None, None);
        assert_eq!(c[ESPACE_SON], json!({ "label": "clip", "category": "A", "emoji": "🔊" }));
    }

    #[test]
    fn edition_garde_le_genre_voix_et_le_modele() {
        let mut orig = sons(&[son_brut("$s", 1, json!({ "label": "Voix", "kind": "voice", "tts_model": "m1" }))])[0].clone();
        orig.duration = None;
        let c = contenu_edition_son(&orig, "Nouveau", "Voix", None, 1.0, Some(None), None);
        assert_eq!(c["m.new_content"][ESPACE_SON], json!({ "label": "Nouveau", "category": "Voix", "kind": "voice", "tts_model": "m1", "ref_text": "" }));
        assert_eq!(c["m.relates_to"], json!({ "rel_type": "m.replace", "event_id": "$s" }));
        assert!(c["info"].get("duration").is_none());
    }

    #[test]
    fn lecture_et_contenu_des_memes() {
        let m = ev("$m", 5, json!({
            "msgtype": "m.video", "body": "chat.mp4", "url": "mxc://hs/v",
            "info": { "duration": 3000, "w": 640, "h": 360, "thumbnail_url": "mxc://hs/a" },
            ESPACE_MEME: { "label": "", "gain_pct": 500 }
        }));
        let son = son_brut("$s", 6, Value::Null);
        let liste = memes(&[m, son]);
        assert_eq!(liste.len(), 1);
        let x = &liste[0];
        assert_eq!((x.label.as_str(), x.gain, x.apercu_mxc.as_deref(), x.largeur), ("chat.mp4", 3.0, Some("mxc://hs/a"), Some(640)));
        assert_eq!(nom_fichier_meme("Chat !! trop/drôle", false), "Chat  tropdrôle.mp4");
        let t = MemeTeleverse { mxc: "mxc://hs/g", mime: "image/gif", taille: 9, largeur: 1, hauteur: 1, duree_ms: 800, apercu: None };
        let c = contenu_meme(&t, "x.gif", " ", None);
        assert_eq!((c["msgtype"].as_str(), c[ESPACE_MEME]["label"].as_str()), (Some("m.image"), Some("meme")));
    }

    #[test]
    fn versions_et_droit_d_annonce() {
        let etats = vec![
            ("@a:hs".to_owned(), json!({ "version": "2.0.0", "os": "Linux", "ts": 5 })),
            ("@b:hs".to_owned(), json!({ "version": "1.9.0", "ts": 9 })),
            ("@c:hs".to_owned(), json!({})),
        ];
        let v = versions(&etats);
        assert_eq!(v.iter().map(|x| (x.user_id.as_str(), x.os.as_str())).collect::<Vec<_>>(), [("@b:hs", "?"), ("@a:hs", "Linux")]);
        let niveaux = json!({ "state_default": 50, "users": { "@a:hs": 100 } });
        assert_eq!(niveaux_avec_version_ouverte(&niveaux, 100).unwrap()["events"][EVENEMENT_VERSION], 0);
        assert!(niveaux_avec_version_ouverte(&niveaux, 0).is_none(), "pas le droit");
        let ouvert = json!({ "events": { EVENEMENT_VERSION: 0 } });
        assert!(niveaux_avec_version_ouverte(&ouvert, 100).is_none(), "déjà ouvert");
    }
}
