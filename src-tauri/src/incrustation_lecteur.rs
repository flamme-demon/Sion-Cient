//! Contrôles du lecteur, peints DANS les images de la vidéo.
//!
//! ## Pourquoi dans l'image
//!
//! La surface native est une couche du compositeur posée au-dessus de la
//! fenêtre : rien du DOM ne peut s'afficher devant elle, aucun `z-index` n'y
//! change quoi que ce soit. Les contrôles placés dans la page passaient donc
//! derrière la vidéo dès qu'ils empiétaient dessus, et sortaient de la bulle
//! du message quand on les déplaçait vers le bas.
//!
//! On aurait pu peindre dans le renderer : EGL sous Linux, GDI sous Windows,
//! deux implémentations à tenir. Composer dans l'image décodée coûte bien
//! moins cher — un seul code, les mêmes pixels partout — et le surcoût est
//! celui d'un bandeau de quelques dizaines de milliers de pixels par image.
//!
//! ## Les clics restent au DOM
//!
//! La surface laisse passer les événements, sa région d'entrée étant vide. Le
//! front garde donc des zones transparentes aux mêmes endroits : Rust dessine,
//! la page écoute. Rien à réimplémenter côté survol ou clavier.

use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Rect, Transform};

/// Ce que le bandeau doit montrer. Tout est en unités du média, pas en
/// pixels : le dessin s'adapte à la résolution de la vidéo.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct EtatIncrustation {
    pub position_ms: u64,
    pub duree_ms: u64,
    pub en_pause: bool,
    /// De 0 à 1,5 comme ailleurs dans le lecteur.
    pub volume: f32,
    /// Position VISÉE pendant un glissement sur la barre.
    ///
    /// Le déplacement réel n'a lieu qu'au relâchement — relancer ffmpeg à
    /// chaque pixel serait intenable — mais la pastille doit suivre la souris
    /// entre-temps, sans quoi le geste paraît sans effet.
    pub apercu_ms: Option<u64>,
}

/// Hauteur du bandeau, en pixels de l'IMAGE, pour qu'il occupe
/// `HAUTEUR_ECRAN` pixels une fois affiché.
///
/// La surface est mise à l'échelle : une vidéo de 1022 pixels de haut tient
/// dans 340, et un bandeau dimensionné en proportion de l'image rétrécissait
/// d'autant — illisible (21/09). On part donc de la taille voulue à l'écran
/// et on la divise par l'échelle.
///
/// `echelle` vaut « pixels écran par pixel de média ». Zéro ou absente, on
/// retombe sur une proportion de l'image.
// Mesuré à 52 : trop haut, les commandes mangeaient le bas de l'image
// (21/09). 38 donne une rangée de l'ordre de ce que font les lecteurs du web.
const HAUTEUR_ECRAN: f32 = 38.0;

/// Largeur d'un compteur, en multiples du côté des commandes.
///
/// Chaque caractère est large de quatre fois l'unité de la police, et l'unité
/// vaut un sixième du côté. « 0:07 / 1:06 » fait onze caractères, « 0:07 »
/// seulement quatre : quand la place manque, on garde la position plutôt que
/// de tout supprimer — c'est l'information qu'on regarde.
/// Onze caractères pour « 0:07 / 1:06 », chacun large de 3,4 unités —
/// trois pour le glyphe, 0,4 d'espace — et l'unité vaut un huitième du côté.
/// Au sixième, le compteur complet ne tenait presque jamais et disparaissait
/// au profit de la seule position, ce qui privait de la durée (21/09).
const UNITE_EN_COTES: f32 = 1.0 / 8.0;
const COMPTEUR_EN_COTES: f32 = 11.0 * 3.4 * UNITE_EN_COTES;
const COMPTEUR_COURT_EN_COTES: f32 = 4.0 * 3.4 * UNITE_EN_COTES;

/// Ce que la rangée doit contenir, en multiples du côté, selon la place.
///
/// Un lecteur étroit ne peut pas tout porter : à 263 pixels de large, la
/// rangée complète en réclamait 350 et tout se tassait (21/09). On retire
/// alors des éléments, comme le font les lecteurs du web — d'abord le
/// compteur, puis la jauge de volume. Le bouton de lecture et le plein écran
/// restent toujours.
const RANGEE_COMPLETE: f32 = 1.0 + 2.0 + COMPTEUR_EN_COTES + 1.0 + 5.0 * 0.25;
const RANGEE_COMPTEUR_COURT: f32 = 1.0 + 2.0 + COMPTEUR_COURT_EN_COTES + 1.0 + 5.0 * 0.25;
const RANGEE_SANS_JAUGE: f32 = 1.0 + 1.0 + COMPTEUR_COURT_EN_COTES + 1.0 + 4.0 * 0.25;
const RANGEE_MINIMALE: f32 = 1.0 + 1.0 + 1.0 + 3.0 * 0.25;

/// Côté minimal d'une commande pour rester cliquable, en pixels d'écran.
///
/// Abaissé de 20 à 17 : garder la durée à l'écran vaut mieux que trois pixels
/// de plus sur les boutons, et dix-sept restent confortables à viser.
const COTE_ECRAN_MIN: f32 = 17.0;

/// Ce que le compteur affiche, selon la largeur disponible.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Compteur {
    /// « 0:07 / 1:06 »
    Complet,
    /// « 0:07 » — la position seule, quand la durée ne tient pas.
    Court,
    Aucun,
}

/// Découpe du bandeau, en pixels de l'image. Le front pose ses zones de clic
/// aux mêmes endroits, d'où l'export.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Zones {
    pub bandeau_y: u32,
    pub bandeau_h: u32,
    /// Épaisseur de la barre de progression, en haut du bandeau.
    pub barre_h: u32,
    pub bouton_x: u32,
    pub bouton_l: u32,
    pub barre_x: u32,
    pub barre_l: u32,
    pub volume_x: u32,
    pub volume_l: u32,
    pub compteur_x: u32,
    pub plein_x: u32,
    pub plein_l: u32,
    /// Ordonnée de la rangée de commandes, depuis le haut du bandeau.
    pub rangee_y: u32,
    /// Côté des commandes carrées.
    pub taille: u32,
    /// Ce que le compteur peut montrer, selon la place.
    pub compteur: Compteur,
    /// Faux quand seule l'icône de volume tient, sans sa jauge.
    pub avec_jauge: bool,
}

/// Calcule la découpe pour une image donnée.
///
/// Le côté des commandes est le point de départ : il vient de la hauteur
/// voulue à l'écran, mais il est **borné par la largeur disponible**. Sans
/// cette seconde borne, une vidéo verticale affichée en petit donnait un
/// bandeau si haut que le compteur sortait du cadre et que le plein écran
/// disparaissait (21/09).
pub fn zones(largeur: u32, hauteur: u32, echelle: f32) -> Zones {
    let voulu = if echelle > 0.01 {
        HAUTEUR_ECRAN / echelle
    } else {
        (hauteur as f32 / 10.0).clamp(28.0, 64.0)
    };
    // On choisit la disposition la plus riche dont les commandes restent
    // assez grandes pour être visées. `cote_ecran_min` traduit ce minimum en
    // pixels de l'image, l'affichage étant réduit.
    let cote_plancher = if echelle > 0.01 {
        COTE_ECRAN_MIN / echelle
    } else {
        10.0
    };
    let idealle = (voulu * 0.58).min(hauteur as f32 / 6.0);
    // Du plus riche au plus dépouillé : on garde la première disposition
    // dont les commandes restent assez grandes pour être visées.
    let (rangee, compteur, avec_jauge) = [
        (RANGEE_COMPLETE, Compteur::Complet, true),
        (RANGEE_COMPTEUR_COURT, Compteur::Court, true),
        (RANGEE_SANS_JAUGE, Compteur::Court, false),
        (RANGEE_MINIMALE, Compteur::Aucun, false),
    ]
    .into_iter()
    .find(|(besoin, _, _)| largeur as f32 / besoin >= cote_plancher)
    .unwrap_or((RANGEE_MINIMALE, Compteur::Aucun, false));

    let cote = idealle.min(largeur as f32 / rangee).max(6.0);

    let marge = (cote / 4.0).max(2.0);
    let barre_h = (cote / 2.5).max(4.0);
    let rangee_y = barre_h + marge;
    let h = rangee_y + cote + marge;

    let taille = cote as u32;
    let bouton_x = marge;
    let volume_x = bouton_x + cote + marge;
    let volume_l = if avec_jauge { cote * 2.0 } else { cote };
    let compteur_x = volume_x + volume_l + marge;
    let plein_x = (largeur as f32 - marge - cote).max(0.0);

    Zones {
        bandeau_y: hauteur.saturating_sub(h as u32),
        bandeau_h: h as u32,
        barre_h: barre_h as u32,
        bouton_x: bouton_x as u32,
        bouton_l: taille,
        barre_x: 0,
        barre_l: largeur,
        volume_x: volume_x as u32,
        volume_l: volume_l as u32,
        compteur_x: compteur_x as u32,
        plein_x: plein_x as u32,
        plein_l: taille,
        rangee_y: rangee_y as u32,
        taille,
        compteur,
        avec_jauge,
    }
}

/// Police minimale : chaque chiffre et le deux-points sur une grille 3×5.
/// Un moteur de police complet serait hors de proportion pour afficher
/// « 0:07 / 1:06 ».
const GLYPHES: [(char, [u8; 5]); 12] = [
    ('0', [0b111, 0b101, 0b101, 0b101, 0b111]),
    ('1', [0b010, 0b110, 0b010, 0b010, 0b111]),
    ('2', [0b111, 0b001, 0b111, 0b100, 0b111]),
    ('3', [0b111, 0b001, 0b111, 0b001, 0b111]),
    ('4', [0b101, 0b101, 0b111, 0b001, 0b001]),
    ('5', [0b111, 0b100, 0b111, 0b001, 0b111]),
    ('6', [0b111, 0b100, 0b111, 0b101, 0b111]),
    ('7', [0b111, 0b001, 0b010, 0b010, 0b010]),
    ('8', [0b111, 0b101, 0b111, 0b101, 0b111]),
    ('9', [0b111, 0b101, 0b111, 0b001, 0b111]),
    (':', [0b000, 0b010, 0b000, 0b010, 0b000]),
    ('/', [0b001, 0b001, 0b010, 0b100, 0b100]),
];

/// « 3:07 » à partir de millisecondes.
pub fn mmss(ms: u64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

fn dessiner_texte(pixmap: &mut Pixmap, texte: &str, x: f32, y: f32, echelle: f32, couleur: Color) {
    let mut peinture = Paint::default();
    peinture.set_color(couleur);
    peinture.anti_alias = false;
    let mut curseur = x;
    for c in texte.chars() {
        if c == ' ' {
            curseur += echelle * 1.7;
            continue;
        }
        if let Some((_, motif)) = GLYPHES.iter().find(|(g, _)| *g == c) {
            for (ligne, bits) in motif.iter().enumerate() {
                for colonne in 0..3 {
                    if bits & (0b100 >> colonne) != 0 {
                        if let Some(r) = Rect::from_xywh(
                            curseur + colonne as f32 * echelle,
                            y + ligne as f32 * echelle,
                            echelle,
                            echelle,
                        ) {
                            pixmap.fill_rect(r, &peinture, Transform::identity(), None);
                        }
                    }
                }
            }
        }
        curseur += echelle * 3.4;
    }
}

fn rectangle(pixmap: &mut Pixmap, x: f32, y: f32, l: f32, h: f32, couleur: Color) {
    if l <= 0.0 || h <= 0.0 {
        return;
    }
    let mut peinture = Paint::default();
    peinture.set_color(couleur);
    if let Some(r) = Rect::from_xywh(x, y, l, h) {
        pixmap.fill_rect(r, &peinture, Transform::identity(), None);
    }
}

/// Dessine le bandeau sur un calque transparent, de la taille de l'image.
pub fn dessiner(
    largeur: u32,
    hauteur: u32,
    echelle: f32,
    etat: &EtatIncrustation,
) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(largeur, hauteur)?;
    let z = zones(largeur, hauteur, echelle);
    let y0 = z.bandeau_y as f32;
    let blanc = Color::from_rgba8(245, 245, 245, 255);
    let accent = Color::from_rgba8(120, 170, 255, 255);

    // Dégradé simulé : deux bandes d'opacité croissante vers le bas. Un aplat
    // uniforme fait tache sur une image claire.
    let h = z.bandeau_h as f32;
    rectangle(&mut pixmap, 0.0, y0, largeur as f32, h / 2.0,
              Color::from_rgba8(0, 0, 0, 110));
    rectangle(&mut pixmap, 0.0, y0 + h / 2.0, largeur as f32, h / 2.0,
              Color::from_rgba8(0, 0, 0, 175));

    // Barre de progression, en haut, sur toute la largeur.
    let bh = z.barre_h as f32;
    rectangle(&mut pixmap, 0.0, y0, largeur as f32, bh,
              Color::from_rgba8(255, 255, 255, 60));
    if etat.duree_ms > 0 {
        let avance = (etat.position_ms as f32 / etat.duree_ms as f32).clamp(0.0, 1.0);
        rectangle(&mut pixmap, 0.0, y0, largeur as f32 * avance, bh, accent);

        // Pastille : à la position visée tant qu'on glisse, sinon à la
        // position réelle. Elle grossit et s'entoure d'un halo pendant le
        // geste, pour qu'on la voie sous le curseur.
        let (fraction, saisie) = match etat.apercu_ms {
            Some(ms) => ((ms as f32 / etat.duree_ms as f32).clamp(0.0, 1.0), true),
            None => (avance, false),
        };
        // Trait clair jusqu'à la position visée : on lit d'un coup d'œil où
        // l'on va atterrir.
        if saisie {
            rectangle(&mut pixmap, 0.0, y0, largeur as f32 * fraction, bh,
                      Color::from_rgba8(255, 255, 255, 190));
        }
        let r = if saisie { bh * 2.4 } else { bh * 1.7 };
        let cx = (largeur as f32 * fraction).clamp(r, largeur as f32 - r);
        let cy = y0 + bh / 2.0;
        let mut peinture = Paint::default();
        peinture.anti_alias = true;
        if saisie {
            let mut halo = PathBuilder::new();
            halo.push_circle(cx, cy, r * 1.9);
            if let Some(p) = halo.finish() {
                peinture.set_color(Color::from_rgba8(120, 170, 255, 90));
                pixmap.fill_path(&p, &peinture, FillRule::Winding, Transform::identity(), None);
            }
        }
        let mut rond = PathBuilder::new();
        rond.push_circle(cx, cy, r);
        if let Some(p) = rond.finish() {
            peinture.set_color(if saisie { blanc } else { accent });
            pixmap.fill_path(&p, &peinture, FillRule::Winding, Transform::identity(), None);
        }
    }

    let ry = y0 + z.rangee_y as f32;
    let cote = z.taille as f32;
    let milieu = ry + cote / 2.0;

    // Lecture / pause.
    let bx = z.bouton_x as f32;
    if etat.en_pause {
        let mut chemin = PathBuilder::new();
        chemin.move_to(bx + cote * 0.2, ry + cote * 0.12);
        chemin.line_to(bx + cote * 0.85, milieu);
        chemin.line_to(bx + cote * 0.2, ry + cote * 0.88);
        chemin.close();
        if let Some(p) = chemin.finish() {
            let mut peinture = Paint::default();
            peinture.set_color(blanc);
            peinture.anti_alias = true;
            pixmap.fill_path(&p, &peinture, FillRule::Winding, Transform::identity(), None);
        }
    } else {
        let l = cote * 0.22;
        rectangle(&mut pixmap, bx + cote * 0.22, ry + cote * 0.12, l, cote * 0.76, blanc);
        rectangle(&mut pixmap, bx + cote * 0.56, ry + cote * 0.12, l, cote * 0.76, blanc);
    }

    // Haut-parleur, puis sa jauge.
    let vx = z.volume_x as f32;
    let ic = cote * 0.7;
    let icy = milieu - ic / 2.0;
    rectangle(&mut pixmap, vx, icy + ic * 0.3, ic * 0.35, ic * 0.4, blanc);
    let mut cone = PathBuilder::new();
    cone.move_to(vx + ic * 0.35, icy + ic * 0.3);
    cone.line_to(vx + ic * 0.8, icy);
    cone.line_to(vx + ic * 0.8, icy + ic);
    cone.line_to(vx + ic * 0.35, icy + ic * 0.7);
    cone.close();
    if let Some(p) = cone.finish() {
        let mut peinture = Paint::default();
        peinture.set_color(blanc);
        peinture.anti_alias = true;
        pixmap.fill_path(&p, &peinture, FillRule::Winding, Transform::identity(), None);
    }
    if z.avec_jauge {
        let jx = vx + ic;
        let jl = (z.volume_l as f32 - ic).max(0.0);
        let jh = (cote * 0.12).max(2.0);
        rectangle(&mut pixmap, jx, milieu - jh / 2.0, jl, jh,
                  Color::from_rgba8(255, 255, 255, 70));
        let part = (etat.volume / 1.5).clamp(0.0, 1.0);
        rectangle(&mut pixmap, jx, milieu - jh / 2.0, jl * part, jh, blanc);
        // Pastille de saisie, comme sur la barre de progression : sans elle,
        // rien n'indique que la jauge se règle au glissement.
        let r = (cote * 0.16).max(2.5);
        let mut rond = PathBuilder::new();
        rond.push_circle((jx + jl * part).clamp(jx, jx + jl), milieu, r);
        if let Some(p) = rond.finish() {
            let mut peinture = Paint::default();
            peinture.set_color(blanc);
            peinture.anti_alias = true;
            pixmap.fill_path(&p, &peinture, FillRule::Winding, Transform::identity(), None);
        }
    } else if etat.volume == 0.0 {
        // Sans jauge, une croix dit au moins que le son est coupé.
        let cx = vx + ic * 1.1;
        let e = (cote * 0.09).max(1.0);
        rectangle(&mut pixmap, cx, milieu - e / 2.0, ic * 0.5, e, blanc);
    }

    // Compteur « 0:07 / 1:06 », seulement si la largeur le permet.
    let echelle_texte = (cote * UNITE_EN_COTES).max(2.0).floor();
    let texte = match z.compteur {
        Compteur::Complet => Some(format!("{} / {}", mmss(etat.position_ms), mmss(etat.duree_ms))),
        Compteur::Court => Some(mmss(etat.position_ms)),
        Compteur::Aucun => None,
    };
    if let Some(texte) = texte {
    dessiner_texte(
        &mut pixmap,
        &texte,
        z.compteur_x as f32,
        milieu - echelle_texte * 2.5,
        echelle_texte,
        blanc,
    );
    }

    // Plein écran : deux équerres opposées.
    let px = z.plein_x as f32;
    let ep = (cote / 8.0).max(1.0);
    let br = cote * 0.38;
    rectangle(&mut pixmap, px, ry, br, ep, blanc);
    rectangle(&mut pixmap, px, ry, ep, br, blanc);
    rectangle(&mut pixmap, px + cote - br, ry + cote - ep, br, ep, blanc);
    rectangle(&mut pixmap, px + cote - ep, ry + cote - br, ep, br, blanc);

    Some(pixmap)
}

/// Compose un calque RGBA sur des plans I420, en place.
///
/// La luminance se mélange pixel par pixel ; la chrominance, sous-échantillonnée
/// de moitié, se traite par bloc de 2×2 en prenant l'opacité du coin haut
/// gauche. L'approximation ne se voit pas sur des formes aussi simples, et
/// elle divise le travail par quatre sur les deux plans de couleur.
pub fn composer_sur_i420(
    calque: &Pixmap,
    y: &mut [u8],
    u: &mut [u8],
    v: &mut [u8],
    largeur: u32,
    hauteur: u32,
) {
    let l = largeur as usize;
    let h = hauteur as usize;
    let demi = l.div_ceil(2);
    let pixels = calque.pixels();

    for ligne in 0..h {
        for colonne in 0..l {
            let p = pixels[ligne * l + colonne];
            let a = p.alpha() as u32;
            if a == 0 {
                continue;
            }
            // tiny-skia prémultiplie : on démultiplie pour retrouver la
            // couleur réelle avant conversion.
            let (r, g, b) = (
                p.red() as u32 * 255 / a.max(1),
                p.green() as u32 * 255 / a.max(1),
                p.blue() as u32 * 255 / a.max(1),
            );
            let yc = (77 * r + 150 * g + 29 * b) >> 8;
            let idx = ligne * l + colonne;
            if idx < y.len() {
                y[idx] = ((y[idx] as u32 * (255 - a) + yc * a) / 255) as u8;
            }
            if ligne % 2 == 0 && colonne % 2 == 0 {
                let uc = ((-43 * r as i32 - 84 * g as i32 + 127 * b as i32) >> 8) + 128;
                let vc = ((127 * r as i32 - 106 * g as i32 - 21 * b as i32) >> 8) + 128;
                let cidx = (ligne / 2) * demi + colonne / 2;
                if cidx < u.len() && cidx < v.len() {
                    u[cidx] = ((u[cidx] as u32 * (255 - a) + uc.clamp(0, 255) as u32 * a) / 255) as u8;
                    v[cidx] = ((v[cidx] as u32 * (255 - a) + vc.clamp(0, 255) as u32 * a) / 255) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Le cas qui a cassé l'affichage : une vidéo verticale, affichée bien
    /// plus petite que sa résolution. La hauteur voulue à l'écran réclamerait
    /// un bandeau énorme, que la largeur ne peut pas contenir.
    /// Le cas mesuré le 21/09 : lecteur de 263 pixels de large à l'écran,
    /// pour une toile de 1146.
    ///
    /// On ne fige pas ICI la disposition retenue — c'est un réglage, il
    /// bougera. Ce qui doit tenir, c'est l'invariant : tout rentre dans la
    /// largeur, et les commandes restent visables à l'écran.
    #[test]
    fn un_lecteur_etroit_reste_utilisable() {
        let echelle = 263.0 / 1146.0;
        let z = zones(1146, 1022, echelle);

        let cote_ecran = z.taille as f32 * echelle;
        assert!(cote_ecran >= 16.0, "commandes trop petites : {cote_ecran} px");
        // Un lecteur étroit garde au moins la position : c'est ce qu'on
        // regarde, et la supprimer rendait le bandeau muet.
        assert_ne!(z.compteur, Compteur::Aucun);

        let fin = match z.compteur {
            Compteur::Complet => z.compteur_x as f32 + z.taille as f32 * COMPTEUR_EN_COTES,
            Compteur::Court => z.compteur_x as f32 + z.taille as f32 * COMPTEUR_COURT_EN_COTES,
            Compteur::Aucun => (z.volume_x + z.volume_l) as f32,
        };
        assert!(fin <= z.plein_x as f32, "la rangée déborde sur le plein écran");
    }


    #[test]
    fn le_compteur_complet_tient_sur_une_bulle_etroite() {
        // Cas mesuré : vidéo verticale de 576 px de toile, affichée dans 191.
        let z = zones(576, 1022, 191.0 / 576.0);
        assert_eq!(
            z.compteur,
            Compteur::Complet,
            "la durée doit rester visible : c'est elle qui situe la lecture"
        );
    }

    #[test]
    fn un_lecteur_large_garde_tout() {
        let large = zones(1920, 1080, 1.0);
        assert_eq!(large.compteur, Compteur::Complet);
        assert!(large.avec_jauge);
    }

    #[test]
    fn tout_tient_dans_la_largeur_meme_sur_une_video_verticale() {
        let z = zones(576, 1022, 0.4);
        let fin_compteur = match z.compteur {
            Compteur::Complet => z.compteur_x as f32 + z.taille as f32 * COMPTEUR_EN_COTES,
            Compteur::Court => z.compteur_x as f32 + z.taille as f32 * COMPTEUR_COURT_EN_COTES,
            Compteur::Aucun => (z.volume_x + z.volume_l) as f32,
        };
        assert!(
            fin_compteur <= z.plein_x as f32,
            "le compteur ({fin_compteur}) mord sur le plein écran ({})",
            z.plein_x
        );
        assert!(z.plein_x + z.plein_l <= 576);
    }

    #[test]
    fn le_bandeau_grandit_quand_la_video_est_reduite_a_l_ecran() {
        // À l'échelle 1, la hauteur voulue suffit…
        let pleine = zones(1920, 1080, 1.0);
        // …et à un tiers, il faut environ trois fois plus de pixels image
        // pour occuper la même place à l'écran.
        let reduite = zones(1920, 1080, 1.0 / 3.0);
        assert!(reduite.bandeau_h > pleine.bandeau_h * 2);
    }

    #[test]
    fn les_zones_ne_se_chevauchent_pas() {
        let z = zones(800, 450, 1.0);
        // La barre couvre toute la largeur, en haut du bandeau.
        assert_eq!((z.barre_x, z.barre_l), (0, 800));
        // La rangée s'ordonne : lecture, volume, compteur… puis plein écran.
        assert!(z.bouton_x + z.bouton_l <= z.volume_x);
        assert!(z.volume_x + z.volume_l <= z.compteur_x);
        assert!(z.compteur_x < z.plein_x);
        assert!(z.plein_x + z.plein_l <= 800);
        assert_eq!(z.bandeau_y + z.bandeau_h, 450);
    }

    #[test]
    fn une_image_minuscule_ne_produit_pas_de_zone_negative() {
        // Les soustractions doivent rester saturantes : une vidéo plus étroite
        // que le bandeau ne doit pas faire paniquer le rendu.
        let z = zones(40, 40, 1.0);
        assert!(z.barre_l <= 40);
        assert!(z.plein_x < 40);
    }

    #[test]
    fn la_composition_eclaircit_la_zone_du_bandeau_et_laisse_le_reste_intact() {
        // Taille réaliste : sur une image plus petite que le bandeau, celui-ci
        // couvrirait tout et le test ne prouverait rien.
        let (l, h) = (320u32, 240u32);
        let mut y = vec![10u8; (l * h) as usize];
        let mut u = vec![128u8; (l * h / 4) as usize];
        let mut v = vec![128u8; (l * h / 4) as usize];
        let etat = EtatIncrustation {
            position_ms: 1000,
            duree_ms: 2000,
            en_pause: false,
            volume: 1.0,
            apercu_ms: None,
        };
        let calque = dessiner(l, h, 1.0, &etat).expect("calque");
        let opaques = calque.pixels().iter().filter(|p| p.alpha() > 0).count();
        assert!(opaques > 0, "le calque doit contenir des pixels peints");
        composer_sur_i420(&calque, &mut y, &mut u, &mut v, l, h);
        // Le haut de l'image n'est pas touché…
        assert_eq!(y[0], 10);
        // …le bas porte le voile, donc une luminance différente.
        let bas = ((h - 1) * l) as usize;
        assert!(y[bas] != 10, "le bandeau doit modifier la luminance du bas");
    }

    #[test]
    fn le_compteur_se_formate_en_minutes_et_secondes() {
        assert_eq!(mmss(0), "0:00");
        assert_eq!(mmss(7_000), "0:07");
        assert_eq!(mmss(66_000), "1:06");
        assert_eq!(mmss(3_600_000), "60:00");
    }
}
