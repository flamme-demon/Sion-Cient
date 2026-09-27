//! Noms des membres, calculés comme `RoomMember.name` de matrix-js-sdk
//! (`shouldDisambiguate` + `calculateDisplayName`) : l'identifiant complet
//! sans nom d'affichage, « Nom (@id) » seulement en cas d'homonyme, de nom
//! qui ressemble à un identifiant, ou de caractère de direction. Sert au fil
//! (T2) et aux mentions (T3).
//!
//! Pas repris de matrix-sdk : son `name()` rend la partie locale, et son
//! `name_ambiguous()` juge ambigu tout nom contenant un caractère invisible —
//! « pierre 🏳️‍⚧️ » (le drapeau contient un ZWJ) y devenait
//! « pierre 🏳️‍⚧️ (@pierre:…) », quand le moteur JS affiche « pierre 🏳️‍⚧️ ».
//!
//! Approximation : la comparaison des homonymes retire les caractères
//! invisibles et les espaces comme `removeHiddenChars`, sans la normalisation
//! NFD ni la table d'homoglyphes (`unhomoglyph`).
use std::collections::HashMap;

use matrix_sdk::room::RoomMember;

/// `removeHiddenCharsRegex` de matrix-js-sdk.
fn invisible(c: char) -> bool {
    matches!(c, '\u{2000}'..='\u{200F}' | '\u{202A}'..='\u{202F}' | '\u{0300}'..='\u{036F}' | '\u{FEFF}' | '\u{061C}' | '\u{2800}' | '\u{2062}'..='\u{2063}')
        || c.is_whitespace()
}

fn sans_invisibles(nom: &str) -> String {
    nom.chars().filter(|&c| !invisible(c)).collect()
}

/// `MXID_PATTERN` : `/@.+:.+/`.
fn ressemble_a_un_identifiant(nom: &str) -> bool {
    nom.match_indices('@').any(|(i, _)| {
        let reste = &nom[i + 1..];
        reste.char_indices().any(|(j, c)| c == ':' && j > 0 && j + 1 < reste.len())
    })
}

/// `LTR_RTL_PATTERN`.
fn direction(nom: &str) -> bool {
    nom.chars().any(|c| matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202F}'))
}

/// `removeDirectionOverrideChars`.
fn sans_forcage(nom: &str) -> String {
    nom.chars().filter(|c| !matches!(c, '\u{202D}' | '\u{202E}')).collect()
}

/// Nom affiché de chaque membre, à partir de (identifiant, nom d'affichage)
/// de TOUS les membres connus de l'état du salon (le JS tient son cache
/// d'homonymes sur tous les événements de membre, départs compris).
pub(crate) fn noms(membres: &[(String, Option<String>)]) -> HashMap<String, String> {
    let mut porteurs: HashMap<String, Vec<&str>> = HashMap::new();
    for (id, nom) in membres {
        if let Some(nom) = nom {
            porteurs.entry(sans_invisibles(nom)).or_default().push(id);
        }
    }
    membres
        .iter()
        .map(|(id, nom)| {
            let affiche = match nom.as_deref() {
                None | Some("") => id.clone(),
                Some(n) if n == id => id.clone(),
                Some(n) => {
                    let cle = sans_invisibles(n);
                    let homonyme = porteurs.get(&cle).is_some_and(|ids| ids.iter().any(|autre| autre != id));
                    if cle.is_empty() {
                        id.clone()
                    } else if ressemble_a_un_identifiant(&cle) || direction(n) || homonyme {
                        format!("{} ({id})", sans_forcage(n))
                    } else {
                        sans_forcage(n)
                    }
                }
            };
            (id.clone(), affiche)
        })
        .collect()
}

/// `noms` pour des membres de matrix-sdk.
pub(crate) fn noms_du_salon(membres: &[RoomMember]) -> HashMap<String, String> {
    let paires: Vec<(String, Option<String>)> =
        membres.iter().map(|m| (m.user_id().to_string(), m.display_name().map(str::to_owned))).collect();
    noms(&paires)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(membres: &[(&str, Option<&str>)]) -> HashMap<String, String> {
        let paires: Vec<_> = membres.iter().map(|(id, nom)| (id.to_string(), nom.map(str::to_owned))).collect();
        noms(&paires)
    }

    #[test]
    fn nom_simple_ou_identifiant() {
        let r = n(&[("@a:hs", Some("Alice")), ("@b:hs", None), ("@c:hs", Some("   "))]);
        assert_eq!((r["@a:hs"].as_str(), r["@b:hs"].as_str(), r["@c:hs"].as_str()), ("Alice", "@b:hs", "@c:hs"));
    }

    #[test]
    fn un_zwj_ne_rend_pas_un_nom_ambigu() {
        let r = n(&[("@pierre:hs", Some("pierre 🏳️\u{200d}⚧️")), ("@a:hs", Some("Alice"))]);
        assert_eq!(r["@pierre:hs"], "pierre 🏳️\u{200d}⚧️");
    }

    #[test]
    fn homonymes_et_imitations() {
        let r = n(&[("@a:hs", Some("Léa")), ("@b:hs", Some("Léa")), ("@c:hs", Some("L\u{200b}éa"))]);
        assert_eq!(r["@a:hs"], "Léa (@a:hs)");
        assert_eq!(r["@c:hs"], "L\u{200b}éa (@c:hs)");
        // Nom qui imite un identifiant, ou qui joue sur la direction du texte.
        let r = n(&[("@x:hs", Some("@admin:hs")), ("@y:hs", Some("\u{202e}nimda"))]);
        assert_eq!(r["@x:hs"], "@admin:hs (@x:hs)");
        assert_eq!(r["@y:hs"], "nimda (@y:hs)");
    }
}
