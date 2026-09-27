//! Administration (tranche T4), partie pure : ports de `adminCommandService.ts`
//! et des heuristiques de `matrixService.ts`, avec leurs règles exactes.
use std::collections::HashMap;

use serde_json::Value;

/// Ce qu'on sait d'un salon pour reconnaître le salon d'administration.
pub(crate) struct CandidatAdmin<'a> {
    pub id: &'a str,
    pub nom: &'a str,
    pub alias: &'a str,
    pub membres: &'a [String],
}

/// Le robot d'administration de Continuwuity.
pub(crate) fn robot(serveur: &str) -> String {
    format!("@conduit:{serveur}")
}

/// `findAdminRoom` : le salon au meilleur score. Un MP avec le robot (deux
/// membres) contient lui aussi le robot : il compte moins que la vraie salle
/// où le robot répond aux commandes.
pub(crate) fn salon_admin<'a>(candidats: &[CandidatAdmin<'a>], serveur: &str) -> Option<&'a str> {
    let robot = robot(serveur);
    let mut meilleur = None;
    let mut meilleur_score = 0;
    for c in candidats {
        let nom = c.nom.to_lowercase();
        let avec_robot = c.membres.contains(&robot);
        let membre_conduit = c.membres.iter().any(|m| m.contains("conduit"));
        let mut score = 0;
        if avec_robot {
            score += if c.membres.len() > 2 { 12 } else { 6 };
        }
        if nom.contains("admin") && (nom.contains("conduit") || nom.contains("continuwuity")) {
            score += 8;
        }
        if c.alias.contains("#admins:") || c.alias.contains("#conduit:") {
            score += 6;
        }
        if avec_robot && c.membres.len() == 2 {
            score += 4;
        }
        if membre_conduit && score == 0 {
            score += 1;
        }
        if score > meilleur_score {
            meilleur_score = score;
            meilleur = Some(c.id);
        }
    }
    meilleur
}

/// `getServerAdminUserIds` choisit SON salon avec un barème un peu différent
/// de `findAdminRoom` ; porté tel quel.
pub(crate) fn salon_admin_pour_les_niveaux<'a>(candidats: &[CandidatAdmin<'a>], serveur: &str) -> Option<&'a str> {
    let robot = robot(serveur);
    let mut meilleur = None;
    let mut meilleur_score = 0;
    for c in candidats {
        let nom = c.nom.to_lowercase();
        let avec_robot = c.membres.contains(&robot);
        let mut score = 0;
        if avec_robot {
            score += 10;
        }
        if nom.contains("admin") && (nom.contains("conduit") || nom.contains("continuwuity")) {
            score += 8;
        }
        if avec_robot && c.membres.len() == 2 {
            score += 4;
        }
        if score > meilleur_score {
            meilleur_score = score;
            meilleur = Some(c.id);
        }
    }
    meilleur
}

/// Comptes-robots du serveur, reconnus à leur partie locale EXACTE (un
/// utilisateur dont le nom contient « admin » n'en est pas un).
pub(crate) fn est_robot(utilisateur: &str, avec_admin: bool) -> bool {
    let local = utilisateur.split(':').next().unwrap_or("").to_lowercase();
    matches!(local.as_str(), "@conduit" | "@conduwuit" | "@continuwuity" | "@server") || (avec_admin && local == "@admin")
}

/// Administrateurs du serveur : niveau ≥ 100 dans le salon d'administration,
/// comptes locaux, hors robots (`getServerAdminUserIds`).
pub(crate) fn admins_du_serveur(niveaux: &Value, serveur: &str) -> Vec<String> {
    let suffixe = format!(":{serveur}");
    niveaux
        .get("users")
        .and_then(Value::as_object)
        .map(|utilisateurs| {
            utilisateurs
                .iter()
                .filter(|(id, niveau)| {
                    niveau.as_i64().unwrap_or(0) >= 100 && id.ends_with(&suffixe) && !est_robot(id, true)
                })
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// `parseUserList` : les identifiants cités dans la réponse du robot, sans
/// ceux des robots eux-mêmes, dans l'ordre, sans doublon.
pub(crate) fn liste_utilisateurs(reponse: &str) -> Vec<String> {
    // Balises HTML → espaces.
    let mut texte = String::with_capacity(reponse.len());
    let mut dans_balise = false;
    for c in reponse.chars() {
        match c {
            '<' => dans_balise = true,
            '>' if dans_balise => {
                dans_balise = false;
                texte.push(' ');
            }
            _ if !dans_balise => texte.push(c),
            _ => {}
        }
    }
    // `/@[a-zA-Z0-9._=-]+:[a-zA-Z0-9.-]+/g`
    let local = |c: char| c.is_ascii_alphanumeric() || "._=-".contains(c);
    let domaine = |c: char| c.is_ascii_alphanumeric() || ".-".contains(c);
    let octets: Vec<char> = texte.chars().collect();
    let mut ids: Vec<String> = Vec::new();
    let mut i = 0;
    while i < octets.len() {
        if octets[i] == '@' {
            let mut j = i + 1;
            while j < octets.len() && local(octets[j]) {
                j += 1;
            }
            if j > i + 1 && j < octets.len() && octets[j] == ':' {
                let mut k = j + 1;
                while k < octets.len() && domaine(octets[k]) {
                    k += 1;
                }
                if k > j + 1 {
                    let id: String = octets[i..k].iter().collect();
                    if !id.contains("conduit") && !id.contains("continuwuity") && !ids.contains(&id) {
                        ids.push(id);
                    }
                    i = k;
                    continue;
                }
            }
        }
        i += 1;
    }
    ids
}

/// Chemins que le mandataire d'administration accepte : l'API de
/// Continuwuity et la suspension MSC4323 (`adminService.ts`). Rien d'autre —
/// sinon ce serait un accès authentifié à toute l'API au nom de l'utilisateur.
pub(crate) fn chemin_admin_autorise(chemin: &str) -> bool {
    let sans_requete = chemin.split(['?', '#']).next().unwrap_or("");
    (sans_requete.starts_with("/_continuwuity/") || sans_requete.starts_with("/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/"))
        && !sans_requete.contains("..")
}

/// Niveaux lus dans le contenu de `m.room.power_levels`, avec les valeurs
/// par défaut du moteur JS (salon sans niveaux : état 50, invitation 0).
pub(crate) struct Niveaux {
    pub etat: i64,
    pub invitation: i64,
    pub message: i64,
    pub utilisateurs: HashMap<String, i64>,
    pub par_defaut: i64,
}

pub(crate) fn niveaux(contenu: Option<&Value>) -> Niveaux {
    let entier = |v: Option<&Value>| v.and_then(Value::as_i64);
    let Some(c) = contenu else {
        return Niveaux { etat: 50, invitation: 0, message: 0, utilisateurs: HashMap::new(), par_defaut: 0 };
    };
    Niveaux {
        // `getStatePowerLevel` / `getInvitePowerLevel` / `canSendMessage`
        etat: entier(c.get("state_default")).unwrap_or(50),
        invitation: entier(c.get("invite")).unwrap_or(0),
        message: entier(c.pointer("/events/m.room.message")).or(entier(c.get("events_default"))).unwrap_or(0),
        utilisateurs: c
            .get("users")
            .and_then(Value::as_object)
            .map(|u| u.iter().filter_map(|(id, n)| Some((id.clone(), n.as_i64()?))).collect())
            .unwrap_or_default(),
        par_defaut: entier(c.get("users_default")).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c<'a>(id: &'a str, nom: &'a str, alias: &'a str, membres: &'a [String]) -> CandidatAdmin<'a> {
        CandidatAdmin { id, nom, alias, membres }
    }

    #[test]
    fn la_salle_admin_bat_le_mp_avec_le_robot() {
        let salle = vec!["@conduit:hs".to_owned(), "@a:hs".to_owned(), "@b:hs".to_owned()];
        let mp = vec!["@conduit:hs".to_owned(), "@a:hs".to_owned()];
        let autre = vec!["@a:hs".to_owned(), "@b:hs".to_owned()];
        let candidats = [c("!mp", "", "", &mp), c("!salle", "Admin Room", "", &salle), c("!x", "Général", "", &autre)];
        assert_eq!(salon_admin(&candidats, "hs"), Some("!salle"));
        // Sans vraie salle, le MP avec le robot fait l'affaire.
        assert_eq!(salon_admin(&candidats[..1], "hs"), Some("!mp"));
        assert_eq!(salon_admin(&candidats[2..], "hs"), None);
    }

    #[test]
    fn nom_et_alias_de_la_salle_admin() {
        let membres = vec!["@a:hs".to_owned()];
        assert_eq!(salon_admin(&[c("!n", "conduit Admin Room", "", &membres)], "hs"), Some("!n"));
        assert_eq!(salon_admin(&[c("!a", "x", "#admins:hs", &membres)], "hs"), Some("!a"));
    }

    #[test]
    fn admins_du_serveur_sans_robots_ni_etrangers() {
        let niveaux = json!({ "users": {
            "@greg:hs": 100, "@conduit:hs": 100, "@admin:hs": 100, "@mod:hs": 50, "@loin:ailleurs": 100, "@administrateur:hs": 100
        }});
        let mut admins = admins_du_serveur(&niveaux, "hs");
        admins.sort();
        assert_eq!(admins, ["@administrateur:hs", "@greg:hs"]);
    }

    #[test]
    fn liste_des_utilisateurs_du_robot() {
        let reponse = "<p>Found 3 local user account(s):</p><ul><li>@greg:hs</li><li>@conduit:hs</li><li>@picsou_2:hs</li><li>@greg:hs</li></ul>";
        assert_eq!(liste_utilisateurs(reponse), ["@greg:hs", "@picsou_2:hs"]);
        assert!(liste_utilisateurs("aucun").is_empty());
    }

    #[test]
    fn le_mandataire_ne_sert_que_l_administration() {
        assert!(chemin_admin_autorise("/_continuwuity/admin/rooms/list"));
        assert!(chemin_admin_autorise("/_matrix/client/unstable/uk.timedout.msc4323/admin/suspend/%40a%3Ahs"));
        assert!(!chemin_admin_autorise("/_matrix/client/v3/account/password"));
        assert!(!chemin_admin_autorise("/_continuwuity/../_matrix/client/v3/logout"));
        assert!(!chemin_admin_autorise("https://ailleurs/_continuwuity/x"));
    }

    #[test]
    fn niveaux_par_defaut_du_js() {
        let n = niveaux(None);
        assert_eq!((n.etat, n.invitation, n.message), (50, 0, 0));
        let n = niveaux(Some(&json!({ "events_default": 10, "events": { "m.room.message": 20 }, "invite": 50, "users": { "@a:hs": 100 } })));
        assert_eq!((n.etat, n.invitation, n.message, n.utilisateurs["@a:hs"]), (50, 50, 20, 100));
        assert_eq!(niveaux(Some(&json!({ "events_default": 10 }))).message, 10);
    }
}
