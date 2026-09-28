//! « Vu par » : jusqu'où chaque membre d'un salon a lu, placé sur un message
//! affiché. Calcul pur ; `fil.rs` y branche les accusés de matrix-sdk.
use std::collections::{BTreeMap, HashMap, HashSet};

/// Un événement du fil chargé, dans l'ordre chronologique.
pub(crate) struct Jalon<'a> {
    pub id: &'a str,
    pub expediteur: &'a str,
}

/// Pour chaque message affiché, les membres dont la lecture s'arrête là
/// (triés, pour une publication stable).
///
/// - `accuses` : pour chaque membre, les événements de ses accusés de lecture
///   (hors fil et fil principal : les clients n'envoient pas tous le même) ;
///   on retient le plus avancé.
/// - Un membre a lu ses propres messages, même sans accusé (Element fait de
///   même).
/// - Un accusé posé sur un événement non affiché (réaction, appartenance à
///   l'appel…) remonte au message affiché qui le précède.
/// - Un accusé hors du fil chargé est plus ancien que tout ce qui est affiché :
///   il ne place personne.
/// - Ni moi, ni les utilisateurs ignorés.
pub(crate) fn placer(
    fil: &[Jalon],
    affiches: &HashSet<&str>,
    accuses: &HashMap<String, Vec<String>>,
    membres: &[String],
    moi: &str,
    ignores: &HashSet<String>,
) -> BTreeMap<String, Vec<String>> {
    let rang: HashMap<&str, usize> = fil.iter().enumerate().map(|(i, j)| (j.id, i)).collect();
    let mut places: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for membre in membres {
        if membre == moi || ignores.contains(membre) {
            continue;
        }
        let par_accuse = accuses.get(membre).into_iter().flatten().filter_map(|ev| rang.get(ev.as_str()).copied()).max();
        let par_envoi = fil.iter().rposition(|j| j.expediteur == membre);
        let Some(position) = par_accuse.max(par_envoi) else { continue };
        if let Some(j) = fil[..=position].iter().rev().find(|j| affiches.contains(j.id)) {
            places.entry(j.id.to_owned()).or_default().push(membre.clone());
        }
    }
    for lecteurs in places.values_mut() {
        lecteurs.sort();
    }
    places
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fil<'a>(evs: &[(&'a str, &'a str)]) -> Vec<Jalon<'a>> {
        evs.iter().map(|(id, expediteur)| Jalon { id, expediteur }).collect()
    }

    fn accuses(liste: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        liste.iter().map(|(m, evs)| (m.to_string(), evs.iter().map(|e| e.to_string()).collect())).collect()
    }

    fn membres(liste: &[&str]) -> Vec<String> {
        liste.iter().map(|m| m.to_string()).collect()
    }

    fn aucun() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn un_accuse_sur_un_message_affiche_y_place_le_membre() {
        let f = fil(&[("$1", "@a"), ("$2", "@b"), ("$3", "@a")]);
        let affiches = HashSet::from(["$1", "$2", "$3"]);
        let places = placer(&f, &affiches, &accuses(&[("@c", &["$2"])]), &membres(&["@a", "@b", "@c", "@moi"]), "@moi", &aucun());
        // @b a écrit $2 : il l'a lu, lui aussi.
        assert_eq!(places.get("$2"), Some(&vec!["@b".to_string(), "@c".to_string()]));
        assert_eq!(places.get("$3"), Some(&vec!["@a".to_string()]));
    }

    #[test]
    fn on_a_lu_ses_propres_messages_meme_sans_accuse() {
        let f = fil(&[("$1", "@a"), ("$2", "@b"), ("$3", "@a")]);
        let affiches = HashSet::from(["$1", "$2", "$3"]);
        let places = placer(&f, &affiches, &accuses(&[("@b", &["$1"])]), &membres(&["@a", "@b"]), "@moi", &aucun());
        assert_eq!(places.get("$3"), Some(&vec!["@a".to_string()]));
        assert_eq!(places.get("$2"), Some(&vec!["@b".to_string()]));
    }

    #[test]
    fn l_accuse_le_plus_avance_l_emporte() {
        let f = fil(&[("$1", "@a"), ("$2", "@a"), ("$3", "@a")]);
        let affiches = HashSet::from(["$1", "$2", "$3"]);
        let places = placer(&f, &affiches, &accuses(&[("@c", &["$3", "$1"])]), &membres(&["@c"]), "@moi", &aucun());
        assert_eq!(places, BTreeMap::from([("$3".to_string(), vec!["@c".to_string()])]));
    }

    #[test]
    fn un_accuse_sur_un_evenement_cache_remonte_au_message_precedent() {
        // $2 = une réaction, $4 = un état d'appel : non affichés.
        let f = fil(&[("$1", "@a"), ("$2", "@a"), ("$3", "@b"), ("$4", "@b")]);
        let affiches = HashSet::from(["$1", "$3"]);
        let places = placer(&f, &affiches, &accuses(&[("@c", &["$2"]), ("@d", &["$4"])]), &membres(&["@c", "@d"]), "@moi", &aucun());
        assert_eq!(places.get("$1"), Some(&vec!["@c".to_string()]));
        assert_eq!(places.get("$3"), Some(&vec!["@d".to_string()]));
    }

    #[test]
    fn un_accuse_hors_du_fil_charge_ne_place_personne() {
        let f = fil(&[("$5", "@a"), ("$6", "@a")]);
        let affiches = HashSet::from(["$5", "$6"]);
        let places = placer(&f, &affiches, &accuses(&[("@c", &["$1"])]), &membres(&["@c"]), "@moi", &aucun());
        assert!(places.is_empty());
    }

    #[test]
    fn ni_moi_ni_les_ignores() {
        let f = fil(&[("$1", "@moi"), ("$2", "@troll")]);
        let affiches = HashSet::from(["$1", "$2"]);
        let ignores = HashSet::from(["@troll".to_string()]);
        let places = placer(&f, &affiches, &accuses(&[("@moi", &["$2"])]), &membres(&["@moi", "@troll"]), "@moi", &ignores);
        assert!(places.is_empty());
    }

    #[test]
    fn plusieurs_lecteurs_sur_un_meme_message_sont_tries() {
        let f = fil(&[("$1", "@a")]);
        let affiches = HashSet::from(["$1"]);
        let places = placer(&f, &affiches, &accuses(&[("@z", &["$1"]), ("@b", &["$1"])]), &membres(&["@z", "@b", "@a"]), "@moi", &aucun());
        assert_eq!(places.get("$1"), Some(&vec!["@a".to_string(), "@b".to_string(), "@z".to_string()]));
    }

    #[test]
    fn un_evenement_non_affiche_avant_tout_message_ne_place_personne() {
        let f = fil(&[("$0", "@a"), ("$1", "@b")]);
        let affiches = HashSet::from(["$1"]);
        let places = placer(&f, &affiches, &accuses(&[("@c", &["$0"])]), &membres(&["@c"]), "@moi", &aucun());
        assert!(places.is_empty());
    }
}
