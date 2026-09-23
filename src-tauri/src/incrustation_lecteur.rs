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
//! ## Peint à la résolution de l'écran
//!
//! La toile a la résolution du MÉDIA, et la surface la réduit pour la faire
//! tenir dans la bulle — d'un facteur trois ou quatre pour une vidéo de
//! téléphone. Le GPU réduit en bilinéaire sans mipmaps : chaque pixel d'écran
//! lit quatre texels sur les neuf ou seize qu'il couvre, et saute les autres.
//! Un contour lissé à la résolution du média ressortait donc crénelé, et le
//! compteur semblait tapé au pochoir (22/09).
//!
//! Le bandeau est donc peint à la résolution de l'ÉCRAN, puis agrandi en
//! bilinéaire jusqu'à celle du média. Ainsi agrandi, il ne contient plus aucun
//! détail plus fin qu'un pixel d'écran : quand le GPU le réduit, il retombe
//! sur les pixels d'origine au lieu d'en sauter.
//!
//! ## Les clics restent au DOM
//!
//! La surface laisse passer les événements, sa région d'entrée étant vide. Le
//! front garde donc des zones transparentes aux mêmes endroits : Rust dessine,
//! la page écoute. Rien à réimplémenter côté survol ou clavier.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use std::sync::OnceLock;
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, Path, PathBuilder, Pixmap, Stroke, Transform,
};

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
    /// Faux pour un média muet : le haut-parleur s'affiche barré, sans jauge
    /// à régler, plutôt que de promettre un son qui n'existe pas.
    pub a_du_son: bool,
}

/// Comment la toile est affichée. Déclaré par le front à chaque changement
/// de taille, gardé hors de la lecture pour survivre aux déplacements.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Affichage {
    /// Pixels d'écran (CSS) par pixel de média.
    pub echelle: f32,
    /// Pixels physiques par pixel CSS : 2 sur un écran à double densité.
    /// Sans elle, le bandeau serait peint à la moitié de la finesse visible.
    pub densite: f32,
    /// Change l'icône : quatre coins sortants pour entrer, rentrants pour
    /// sortir.
    pub plein_ecran: bool,
}

impl Default for Affichage {
    fn default() -> Self {
        Affichage {
            echelle: 1.0,
            densite: 1.0,
            plein_ecran: false,
        }
    }
}

// Toutes les cotes qui suivent sont en pixels d'ÉCRAN (CSS). Elles sont
// converties en pixels de l'image selon l'échelle d'affichage.

/// Hauteur visée du bandeau.
///
/// Mesuré à 52 : trop haut, les commandes mangeaient le bas de l'image
/// (21/09). 38 donne une rangée de l'ordre de ce que font les lecteurs du web.
const HAUTEUR_ECRAN: f32 = HAUT_RANGEE + BOUTON + BAS;
/// Hauteur d'affichage à partir de laquelle le bandeau grandit, et jusqu'où.
///
/// Dans une bulle, 38 pixels suffisent. En plein écran sur 1440 pixels de
/// haut, le même bandeau — texte de 12 — devenait un liseré qu'on ne lisait
/// plus (22/09). Les lecteurs du web grossissent leurs commandes en plein
/// écran ; ici elles suivent la hauteur, bornées à ×1,6.
const HAUTEUR_REFERENCE: f32 = 700.0;
const AGRANDI_MAX: f32 = 1.6;
/// Côté idéal d'une commande — sa zone de clic, pas son dessin.
const BOUTON: f32 = 24.0;
/// Côté minimal pour rester cliquable.
///
/// Abaissé de 20 à 17 : garder la durée à l'écran vaut mieux que trois pixels
/// de plus sur les boutons, et dix-sept restent confortables à viser.
const BOUTON_MIN: f32 = 17.0;
/// Part du bouton qu'occupe la grille de 24 de l'icône. Le glyphe lui-même
/// n'en couvre que les deux tiers, comme les icônes Material.
const ICONE: f32 = 0.92;
/// Centre de la piste de progression, depuis le haut du bandeau.
const CENTRE_BARRE: f32 = 5.0;
/// Haut de la rangée de commandes, depuis le haut du bandeau.
const HAUT_RANGEE: f32 = 11.0;
const BAS: f32 = 3.0;
const EPAISSEUR_BARRE: f32 = 3.0;
/// La piste s'épaissit pendant qu'on la fait glisser : elle dit qu'elle
/// est saisie.
const EPAISSEUR_BARRE_SAISIE: f32 = 5.0;
const PASTILLE: f32 = 4.5;
const PASTILLE_SAISIE: f32 = 6.5;
/// Longueur de la jauge de volume, et le vide de part et d'autre : la
/// pastille déborde de la piste à ses deux bouts.
const JAUGE: f32 = 44.0;
/// La jauge raccourcit jusque-là avant de disparaître. Exiger toute sa
/// longueur, et des boutons de 20, la retirait d'une bulle de 190 pixels où
/// l'ancien bandeau la gardait (22/09).
const JAUGE_MIN: f32 = 32.0;
const PAS_JAUGE: f32 = 5.0;
const EPAISSEUR_JAUGE: f32 = 3.0;
const ECART_LECTURE: f32 = 2.0;
const ECART_TEXTE: f32 = 5.0;
const ECART_PLEIN: f32 = 4.0;
/// Bouton de fermeture, en haut à droite de l'image : son côté, et son
/// retrait des bords.
const FERMER: f32 = 24.0;
const MARGE_FERMER: f32 = 8.0;
/// Corps du compteur, en pixels par cadratin — comme un `font-size` CSS.
const TEXTE: f32 = 12.0;
/// Hauteur du fondu AU-DESSUS du bandeau. Un voile qui commence net fait
/// une marche visible sur une image claire ; celui-ci part de rien.
const DEGRADE: f32 = 34.0;
/// Opacité du voile tout en bas de l'image.
const VOILE: f32 = 0.8;

/// `--color-primary` du thème sombre de l'application.
const ACCENT: (u8, u8, u8) = (168, 199, 250);

/// Police du compteur : Noto Sans Medium réduite aux chiffres, au
/// deux-points, à la barre oblique et à l'espace — 3 Ko au lieu de 600.
///
/// Ses chiffres ont tous la même chasse : le compteur ne tremble pas quand
/// « 0:11 » devient « 0:12 ». La licence (SIL OFL 1.1) est conservée dans les
/// métadonnées du fichier. Regénérer avec :
/// `pyftsubset NotoSans-Medium.ttf --text="0123456789:/ " --name-IDs='*'
///  --no-hinting --desubroutinize --layout-features=''`
const POLICE: &[u8] = include_bytes!("../assets/NotoSans-Medium-chiffres.ttf");

fn police() -> Option<&'static FontRef<'static>> {
    static P: OnceLock<Option<FontRef<'static>>> = OnceLock::new();
    P.get_or_init(|| FontRef::try_from_slice(POLICE).ok()).as_ref()
}

/// `PxScale` d'`ab_glyph` fixe la hauteur ascendante + descendante, pas le
/// cadratin : sans conversion, un corps 12 sortait en 8,8.
fn echelle_police(font: &FontRef<'static>, cadratin: f32) -> PxScale {
    let unites = font.units_per_em().unwrap_or(1000.0);
    PxScale::from(cadratin * font.height_unscaled() / unites)
}

/// Largeur d'un texte, en pixels, pour un corps donné.
fn largeur_texte(texte: &str, cadratin: f32) -> f32 {
    let Some(font) = police() else {
        // Sans police rien ne sera peint ; la place réservée reste plausible.
        return texte.chars().count() as f32 * cadratin * 0.55;
    };
    let f = font.as_scaled(echelle_police(font, cadratin));
    texte.chars().map(|c| f.h_advance(f.glyph_id(c))).sum()
}

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
    /// Épaisseur de la piste de progression.
    pub barre_h: u32,
    /// Centre de la piste, depuis le haut du bandeau.
    pub barre_y: u32,
    pub bouton_x: u32,
    pub bouton_l: u32,
    /// La piste, en retrait des bords comme le reste de la rangée.
    pub barre_x: u32,
    pub barre_l: u32,
    /// Icône du haut-parleur, puis la jauge s'il y en a une.
    pub volume_x: u32,
    pub volume_l: u32,
    /// La piste de la jauge : c'est sur elle que se lit le niveau, pas sur
    /// toute la zone de volume, qui commence par l'icône.
    pub jauge_x: u32,
    pub jauge_l: u32,
    pub compteur_x: u32,
    pub compteur_l: u32,
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
    /// Bouton de fermeture, carré, en haut à droite de l'image.
    pub fermer_x: u32,
    pub fermer_y: u32,
    pub fermer_l: u32,
}

/// La découpe en flottants, en pixels de l'image. `Zones` en est l'arrondi
/// exporté ; le dessin garde les fractions.
#[derive(Clone, Copy, Debug)]
struct Geometrie {
    /// Pixels de l'image par pixel d'écran.
    u: f32,
    /// Rapport du côté retenu au côté idéal. Les cotes verticales le suivent,
    /// pour que le bandeau garde ses proportions quand la place manque.
    k: f32,
    bandeau_y: f32,
    bandeau_h: f32,
    barre_x: f32,
    barre_l: f32,
    barre_y: f32,
    rangee_y: f32,
    cote: f32,
    bouton_x: f32,
    volume_x: f32,
    volume_l: f32,
    jauge_x: f32,
    jauge_l: f32,
    compteur_x: f32,
    compteur_l: f32,
    /// Corps du compteur, en pixels de l'image.
    texte: f32,
    plein_x: f32,
    compteur: Compteur,
    avec_jauge: bool,
    fermer_x: f32,
    fermer_y: f32,
    fermer: f32,
}

/// « 3:07 » à partir de millisecondes.
pub fn mmss(ms: u64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

/// Calcule la découpe pour une image donnée.
///
/// On part des tailles voulues À L'ÉCRAN, puis on retire des éléments quand
/// la largeur manque, comme le font les lecteurs du web — d'abord la jauge de
/// volume, puis la durée, puis la position. Le bouton de lecture et le plein
/// écran restent toujours.
///
/// La durée fixe la place du compteur : « 12:34 » est plus large que « 0:48 ».
fn geometrie(largeur: u32, hauteur: u32, echelle: f32, duree_ms: u64) -> Geometrie {
    let par_pixel_ecran = if echelle > 0.01 {
        1.0 / echelle
    } else {
        // Échelle inconnue : on retombe sur une proportion de l'image.
        (hauteur as f32 / 10.0).clamp(28.0, 64.0) / HAUTEUR_ECRAN
    };
    let agrandi =
        (hauteur as f32 / par_pixel_ecran / HAUTEUR_REFERENCE).clamp(1.0, AGRANDI_MAX);
    // Les cotes sont des pixels d'écran, multipliés par l'agrandissement.
    let u = par_pixel_ecran * agrandi;
    let l = largeur as f32 / u;
    let h = hauteur as f32 / u;
    let marge = (l * 0.035).clamp(6.0, 12.0);
    // Au plus un sixième de la hauteur : sur une image très plate, un
    // bandeau de taille normale recouvrirait tout.
    let ideal = BOUTON.min(h / 6.0);

    let complet = largeur_texte(&format!("{} / {}", mmss(duree_ms), mmss(duree_ms)), TEXTE);
    let court = largeur_texte(&mmss(duree_ms), TEXTE);
    let fixe = 2.0 * marge + ECART_LECTURE + ECART_PLEIN;
    // Trois boutons carrés se partagent ce que le reste laisse.
    let cote_possible = |occupe: f32| (l - fixe - occupe) / 3.0;
    let plancher = BOUTON_MIN.min(ideal);

    // Tout porter d'abord : la jauge cède de sa longueur, puis les boutons
    // de leur taille, avant qu'on retire quoi que ce soit.
    let autour_jauge = 2.0 * PAS_JAUGE + ECART_TEXTE + complet;
    let jauge_ideale = l - fixe - 3.0 * ideal - autour_jauge;
    let cote_jauge_min = cote_possible(autour_jauge + JAUGE_MIN);
    let (avec_jauge, compteur, cote, jauge_l) = if jauge_ideale >= JAUGE_MIN {
        (true, Compteur::Complet, ideal, jauge_ideale.min(JAUGE))
    } else if cote_jauge_min >= plancher {
        (true, Compteur::Complet, cote_jauge_min.min(ideal), JAUGE_MIN)
    } else {
        // Puis on retire, dans l'ordre : la jauge, la durée, la position.
        let (compteur, occupe) = [
            (Compteur::Complet, ECART_TEXTE + complet),
            (Compteur::Court, ECART_TEXTE + court),
            (Compteur::Aucun, 0.0),
        ]
        .into_iter()
        .find(|&(_, occupe)| cote_possible(occupe) >= plancher)
        .unwrap_or((Compteur::Aucun, 0.0));
        (false, compteur, ideal.min(cote_possible(occupe)).max(4.0), 0.0)
    };
    let k = cote / BOUTON;
    // Le texte ne rapetisse qu'en dernier recours : la place a été comptée
    // pour le corps plein, il tient donc toujours.
    let texte = TEXTE.min(cote * 0.62);

    let bouton_x = marge;
    let volume_x = bouton_x + cote + ECART_LECTURE;
    let (jauge_x, volume_l) = if avec_jauge {
        (volume_x + cote + PAS_JAUGE, cote + 2.0 * PAS_JAUGE + jauge_l)
    } else {
        (volume_x + cote, cote)
    };
    let compteur_x = volume_x + volume_l + ECART_TEXTE;
    let compteur_l = match compteur {
        Compteur::Complet => complet,
        Compteur::Court => court,
        Compteur::Aucun => 0.0,
    } * texte
        / TEXTE;
    let plein_x = (l - marge - cote).max(0.0);
    let rangee_y = HAUT_RANGEE * k;
    let bandeau_h = (rangee_y + cote + BAS * k) * u;

    Geometrie {
        u,
        k,
        bandeau_y: (hauteur as f32 - bandeau_h).max(0.0),
        bandeau_h: bandeau_h.min(hauteur as f32),
        barre_x: marge * u,
        barre_l: (l - 2.0 * marge).max(0.0) * u,
        barre_y: CENTRE_BARRE * k * u,
        rangee_y: rangee_y * u,
        cote: cote * u,
        bouton_x: bouton_x * u,
        volume_x: volume_x * u,
        volume_l: volume_l * u,
        jauge_x: jauge_x * u,
        jauge_l: jauge_l * u,
        compteur_x: compteur_x * u,
        compteur_l: compteur_l * u,
        texte: texte * u,
        plein_x: plein_x * u,
        compteur,
        avec_jauge,
        fermer_x: (l - (MARGE_FERMER + FERMER) * k).max(0.0) * u,
        fermer_y: MARGE_FERMER * k * u,
        fermer: FERMER * k * u,
    }
}

/// Découpe du bandeau pour le front.
pub fn zones(largeur: u32, hauteur: u32, echelle: f32, duree_ms: u64) -> Zones {
    let g = geometrie(largeur, hauteur, echelle, duree_ms);
    let arrondi = |v: f32| v.max(0.0).round() as u32;
    let bandeau_h = arrondi(g.bandeau_h).min(hauteur);
    Zones {
        bandeau_y: hauteur - bandeau_h,
        bandeau_h,
        barre_h: arrondi(EPAISSEUR_BARRE * g.k * g.u),
        barre_y: arrondi(g.barre_y),
        bouton_x: arrondi(g.bouton_x),
        bouton_l: arrondi(g.cote),
        barre_x: arrondi(g.barre_x),
        barre_l: arrondi(g.barre_l),
        volume_x: arrondi(g.volume_x),
        volume_l: arrondi(g.volume_l),
        jauge_x: arrondi(g.jauge_x),
        jauge_l: arrondi(g.jauge_l),
        compteur_x: arrondi(g.compteur_x),
        compteur_l: arrondi(g.compteur_l),
        plein_x: arrondi(g.plein_x),
        plein_l: arrondi(g.cote),
        rangee_y: arrondi(g.rangee_y),
        taille: arrondi(g.cote),
        compteur: g.compteur,
        avec_jauge: g.avec_jauge,
        fermer_x: arrondi(g.fermer_x),
        fermer_y: arrondi(g.fermer_y),
        fermer_l: arrondi(g.fermer),
    }
}

/// Pixels du calque de travail par pixel de l'image.
///
/// Autant que de pixels physiques à l'écran, sans jamais dépasser la
/// résolution du média : une vidéo agrandie n'a rien de plus fin à montrer.
/// Près de 1, on ne rééchantillonne pas du tout — la surface affiche alors
/// la toile presque telle quelle et l'aller-retour ne ferait que flouter.
fn finesse(affichage: &Affichage) -> f32 {
    if affichage.echelle <= 0.01 {
        return 1.0;
    }
    let s = affichage.echelle * affichage.densite.max(1.0);
    if s >= 0.85 {
        1.0
    } else {
        s.max(0.05)
    }
}

/// Position affichée : la cible pendant un glissement, la lecture sinon.
fn position_montree(etat: &EtatIncrustation) -> u64 {
    etat.apercu_ms.unwrap_or(etat.position_ms)
}

/// Ce qui, de l'état, se VOIT à l'écran.
///
/// La position change à chaque image, mais le compteur n'avance qu'à la
/// seconde et la pastille qu'au demi-pixel. Redessiner le bandeau à chaque
/// image pour rien coûtait une rastérisation et un agrandissement par image ;
/// comparer cette clé les réserve aux images où quelque chose bouge.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Cle {
    largeur: u32,
    hauteur: u32,
    echelle: u32,
    densite: u32,
    plein_ecran: bool,
    en_pause: bool,
    a_du_son: bool,
    volume: u32,
    saisie: bool,
    duree_s: u64,
    seconde: u64,
    /// Avance de la pastille, en demi-pixels physiques.
    pastille: i64,
}

pub fn cle(largeur: u32, hauteur: u32, affichage: &Affichage, etat: &EtatIncrustation) -> Cle {
    let g = geometrie(largeur, hauteur, affichage.echelle, etat.duree_ms);
    let montree = position_montree(etat);
    let fraction = if etat.duree_ms > 0 {
        (montree as f64 / etat.duree_ms as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let par_pixel = if affichage.echelle > 0.01 { affichage.echelle } else { 1.0 / g.u };
    let physiques = g.barre_l as f64 * par_pixel as f64 * affichage.densite.max(1.0) as f64;
    Cle {
        largeur,
        hauteur,
        echelle: affichage.echelle.to_bits(),
        densite: affichage.densite.to_bits(),
        plein_ecran: affichage.plein_ecran,
        en_pause: etat.en_pause,
        a_du_son: etat.a_du_son,
        volume: etat.volume.to_bits(),
        saisie: etat.apercu_ms.is_some(),
        duree_s: etat.duree_ms / 1000,
        seconde: montree / 1000,
        pastille: (fraction * physiques * 2.0).round() as i64,
    }
}

/// Commandes prêtes à être mélangées aux plans I420.
///
/// Elles ne couvrent que des bandes, pas toute la toile : le bandeau collé en
/// bas, et le coin du bouton de fermeture. Peindre la toile entière coûtait,
/// sur une vidéo 1536x1920, onze mégaoctets alloués puis effacés et deux
/// millions neuf cent mille pixels parcourus PAR IMAGE. Le lecteur plafonnait
/// à 4,5 images par seconde sur une vidéo à 60 (mesuré le 22/09).
pub struct Calque {
    bandes: Vec<Bande>,
}

/// Un rectangle du calque. Les couleurs y sont déjà converties et
/// pré-multipliées : la composition, qui tourne à chaque image, n'a plus
/// qu'une multiplication par pixel.
struct Bande {
    /// Coin haut gauche dans l'image. Toujours pair, pour que les blocs de
    /// chrominance de la bande et de l'image coïncident.
    x: u32,
    y: u32,
    largeur: u32,
    lignes: u32,
    /// Par pixel de luminance : ce qu'il reste de l'image, sur 255…
    y_garde: Vec<u8>,
    /// …et ce qu'y ajoute le bandeau, Y × alpha.
    y_ajout: Vec<u16>,
    /// Même chose par bloc de chrominance 2×2.
    c_garde: Vec<u8>,
    u_ajout: Vec<u16>,
    v_ajout: Vec<u16>,
}

#[cfg(test)]
impl Calque {
    /// Ligne où commence le bandeau du bas, et sa hauteur.
    fn bandeau(&self) -> (u32, u32) {
        let b = &self.bandes[0];
        (b.y, b.lignes)
    }
}

fn couleur(rgb: (u8, u8, u8), opacite: f32) -> Color {
    Color::from_rgba8(rgb.0, rgb.1, rgb.2, (opacite.clamp(0.0, 1.0) * 255.0).round() as u8)
}

const BLANC: (u8, u8, u8) = (255, 255, 255);
const NOIR: (u8, u8, u8) = (0, 0, 0);

fn remplir(p: &mut Pixmap, chemin: Option<Path>, teinte: Color, t: Transform) {
    let Some(chemin) = chemin else { return };
    let mut peinture = Paint::default();
    peinture.set_color(teinte);
    peinture.anti_alias = true;
    p.fill_path(&chemin, &peinture, FillRule::Winding, t, None);
}

/// Trait aux bouts et aux angles arrondis : c'est ce qui donne aux icônes
/// leur air d'icônes, et pas de figures géométriques.
fn tracer(p: &mut Pixmap, chemin: Option<Path>, teinte: Color, epaisseur: f32, t: Transform) {
    let Some(chemin) = chemin else { return };
    let mut peinture = Paint::default();
    peinture.set_color(teinte);
    peinture.anti_alias = true;
    let trait_ = Stroke {
        width: epaisseur,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Default::default()
    };
    p.stroke_path(&chemin, &peinture, &trait_, t, None);
}

fn rectangle_arrondi(x: f32, y: f32, l: f32, h: f32, r: f32) -> Option<Path> {
    if l <= 0.0 || h <= 0.0 {
        return None;
    }
    let r = r.min(l / 2.0).min(h / 2.0).max(0.0);
    // Approximation d'un quart de cercle par une cubique.
    let c = 0.552_284_8 * r;
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + l - r, y);
    pb.cubic_to(x + l - r + c, y, x + l, y + r - c, x + l, y + r);
    pb.line_to(x + l, y + h - r);
    pb.cubic_to(x + l, y + h - r + c, x + l - r + c, y + h, x + l - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + r - c, y + h, x, y + h - r + c, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - c, x + r - c, y, x + r, y);
    pb.close();
    pb.finish()
}

/// Piste horizontale aux bouts ronds, centrée sur `cy`.
fn piste(x: f32, cy: f32, l: f32, epaisseur: f32) -> Option<Path> {
    rectangle_arrondi(x, cy - epaisseur / 2.0, l, epaisseur, epaisseur / 2.0)
}

/// Repère d'une icône : la grille de 24 des icônes Material, posée au centre
/// d'un bouton.
struct Grille {
    x: f32,
    y: f32,
    pas: f32,
}

impl Grille {
    fn new(cx: f32, cy: f32, cote: f32) -> Self {
        let pas = cote * ICONE / 24.0;
        Grille {
            x: cx - 12.0 * pas,
            y: cy - 12.0 * pas,
            pas,
        }
    }

    fn point(&self, gx: f32, gy: f32) -> (f32, f32) {
        (self.x + gx * self.pas, self.y + gy * self.pas)
    }

    fn ligne(&self, points: &[(f32, f32)], fermee: bool) -> Option<Path> {
        let mut pb = PathBuilder::new();
        for (i, &(gx, gy)) in points.iter().enumerate() {
            let (x, y) = self.point(gx, gy);
            if i == 0 {
                pb.move_to(x, y);
            } else {
                pb.line_to(x, y);
            }
        }
        if fermee {
            pb.close();
        }
        pb.finish()
    }

    /// Arc de cercle, en degrés, 0 pointant à droite.
    fn arc(&self, cx: f32, cy: f32, r: f32, de: f32, a: f32) -> Option<Path> {
        let pas = 24;
        let mut pb = PathBuilder::new();
        for i in 0..=pas {
            let angle = (de + (a - de) * i as f32 / pas as f32).to_radians();
            let (x, y) = self.point(cx + r * angle.cos(), cy + r * angle.sin());
            if i == 0 {
                pb.move_to(x, y);
            } else {
                pb.line_to(x, y);
            }
        }
        pb.finish()
    }
}

/// Peint un texte glyphe par glyphe.
///
/// La couverture exacte d'`ab_glyph` vaut mieux, à cette taille, que le
/// suréchantillonnage de tiny-skia : les chiffres restent pleins et ronds.
/// Rend l'abscisse où s'arrête le texte.
fn peindre_texte(
    p: &mut Pixmap,
    texte: &str,
    x: f32,
    ligne_de_base: f32,
    cadratin: f32,
    rgb: (u8, u8, u8),
    opacite: f32,
) -> f32 {
    let Some(font) = police() else { return x };
    let echelle = echelle_police(font, cadratin);
    let f = font.as_scaled(echelle);
    let (l, h) = (p.width() as i32, p.height() as i32);
    let mut stylo = x;
    for c in texte.chars() {
        let id = f.glyph_id(c);
        let glyphe = id.with_scale_and_position(echelle, ab_glyph::point(stylo, ligne_de_base));
        if let Some(contour) = font.outline_glyph(glyphe) {
            let boite = contour.px_bounds();
            let donnees = p.data_mut();
            contour.draw(|gx, gy, couverture| {
                let px = boite.min.x as i32 + gx as i32;
                let py = boite.min.y as i32 + gy as i32;
                if px < 0 || py < 0 || px >= l || py >= h {
                    return;
                }
                let i = (py * l + px) as usize * 4;
                // Source pré-multipliée par-dessus ce qui est déjà peint.
                let a = (couverture * opacite).clamp(0.0, 1.0);
                let reste = 1.0 - a;
                for (canal, valeur) in [rgb.0, rgb.1, rgb.2, 255].into_iter().enumerate() {
                    let d = &mut donnees[i + canal];
                    *d = (valeur as f32 * a + *d as f32 * reste).round() as u8;
                }
            });
        }
        stylo += f.h_advance(id);
    }
    stylo
}

/// Dessine le bandeau pour une image de `largeur` × `hauteur`.
pub fn dessiner(
    largeur: u32,
    hauteur: u32,
    affichage: &Affichage,
    etat: &EtatIncrustation,
) -> Option<Calque> {
    let g = geometrie(largeur, hauteur, affichage.echelle, etat.duree_ms);
    let s = finesse(affichage);
    let origine_y = ((g.bandeau_y - DEGRADE * g.k * g.u).max(0.0) as u32) & !1;
    let lignes = hauteur.saturating_sub(origine_y);
    if largeur == 0 || lignes == 0 {
        return None;
    }
    let mut p = Pixmap::new(
        ((largeur as f32 * s).ceil() as u32).max(1),
        ((lignes as f32 * s).ceil() as u32).max(1),
    )?;
    // Tout le dessin se fait en coordonnées de l'IMAGE ; cette transformation
    // les porte sur le calque réduit.
    let t = Transform::from_row(s, 0.0, 0.0, s, 0.0, -(origine_y as f32) * s);
    let u = g.u;
    let k = g.k;

    // Le voile n'est pas peint ici : uniforme en largeur, il est calculé
    // ligne par ligne à l'agrandissement. Voir `voile`.

    // Progression : une piste fine, la part lue en couleur, une pastille.
    let saisie = etat.apercu_ms.is_some();
    let cy = g.bandeau_y + g.barre_y;
    let epaisseur = if saisie { EPAISSEUR_BARRE_SAISIE } else { EPAISSEUR_BARRE } * k * u;
    remplir(&mut p, piste(g.barre_x, cy, g.barre_l, epaisseur), couleur(BLANC, 0.3), t);
    if etat.duree_ms > 0 {
        let fraction =
            (position_montree(etat) as f32 / etat.duree_ms as f32).clamp(0.0, 1.0);
        let fin = g.barre_x + g.barre_l * fraction;
        remplir(&mut p, piste(g.barre_x, cy, fin - g.barre_x, epaisseur), couleur(ACCENT, 1.0), t);
        let r = if saisie { PASTILLE_SAISIE } else { PASTILLE } * k * u;
        if saisie {
            remplir(&mut p, PathBuilder::from_circle(fin, cy, r * 2.0), couleur(ACCENT, 0.25), t);
        }
        // Un liseré sombre détache la pastille d'une image de même teinte.
        remplir(&mut p, PathBuilder::from_circle(fin, cy, r + 0.75 * u), couleur(NOIR, 0.3), t);
        remplir(&mut p, PathBuilder::from_circle(fin, cy, r), couleur(ACCENT, 1.0), t);
    }

    let ry = g.bandeau_y + g.rangee_y;
    let milieu = ry + g.cote / 2.0;
    let encre = couleur(BLANC, 0.95);

    // Lecture / pause.
    let grille = Grille::new(g.bouton_x + g.cote / 2.0, milieu, g.cote);
    if etat.en_pause {
        // Un triangle rempli PUIS cerné d'un trait rond : les pointes
        // s'arrondissent sans que la forme maigrisse.
        let triangle = || grille.ligne(&[(8.5, 6.2), (18.2, 12.0), (8.5, 17.8)], true);
        remplir(&mut p, triangle(), encre, t);
        tracer(&mut p, triangle(), encre, 1.6 * grille.pas, t);
    } else {
        for x in [6.0, 14.0] {
            let (bx, by) = grille.point(x, 5.0);
            let barre = rectangle_arrondi(bx, by, 4.0 * grille.pas, 14.0 * grille.pas, 1.2 * grille.pas);
            remplir(&mut p, barre, encre, t);
        }
    }

    // Haut-parleur : ondes selon le niveau, barré quand le son est coupé.
    let grille = Grille::new(g.volume_x + g.cote / 2.0, milieu, g.cote);
    let muet = !etat.a_du_son || etat.volume <= 0.0;
    let teinte_hp = if etat.a_du_son { encre } else { couleur(BLANC, 0.5) };
    let hp = || {
        grille.ligne(
            &[(3.5, 9.0), (7.0, 9.0), (11.5, 4.8), (11.5, 19.2), (7.0, 15.0), (3.5, 15.0)],
            true,
        )
    };
    remplir(&mut p, hp(), teinte_hp, t);
    tracer(&mut p, hp(), teinte_hp, 1.0 * grille.pas, t);
    let trait_icone = 1.9 * grille.pas;
    if muet {
        tracer(&mut p, grille.ligne(&[(15.5, 9.25), (21.0, 14.75)], false), teinte_hp, trait_icone, t);
        tracer(&mut p, grille.ligne(&[(21.0, 9.25), (15.5, 14.75)], false), teinte_hp, trait_icone, t);
    } else {
        tracer(&mut p, grille.arc(12.0, 12.0, 3.8, -48.0, 48.0), encre, trait_icone, t);
        // Au-delà du tiers de la course — le niveau normal est à deux
        // tiers, puisque la jauge monte jusqu'à 150 %.
        if etat.volume >= 0.5 {
            tracer(&mut p, grille.arc(12.0, 12.0, 7.6, -52.0, 52.0), encre, trait_icone, t);
        }
    }

    // Jauge de volume. La part au-delà de 100 % — le son est alors amplifié —
    // prend la couleur d'accent.
    if g.avec_jauge && etat.a_du_son {
        let e = EPAISSEUR_JAUGE * k * u;
        remplir(&mut p, piste(g.jauge_x, milieu, g.jauge_l, e), couleur(BLANC, 0.3), t);
        let niveau = (etat.volume / 1.5).clamp(0.0, 1.0);
        let normal = niveau.min(1.0 / 1.5);
        if niveau > normal {
            remplir(&mut p, piste(g.jauge_x, milieu, g.jauge_l * niveau, e), couleur(ACCENT, 1.0), t);
        }
        remplir(&mut p, piste(g.jauge_x, milieu, g.jauge_l * normal, e), encre, t);
        let cx = g.jauge_x + g.jauge_l * niveau;
        let r = PASTILLE * k * u;
        remplir(&mut p, PathBuilder::from_circle(cx, milieu, r + 0.75 * u), couleur(NOIR, 0.3), t);
        remplir(&mut p, PathBuilder::from_circle(cx, milieu, r), couleur(BLANC, 1.0), t);
    }

    // Compteur : la position en blanc, la durée en retrait.
    let montree = position_montree(etat);
    let morceaux: &[(String, f32)] = &match g.compteur {
        Compteur::Complet => vec![
            (mmss(montree), 0.95),
            (format!(" / {}", mmss(etat.duree_ms)), 0.7),
        ],
        Compteur::Court => vec![(mmss(montree), 0.95)],
        Compteur::Aucun => vec![],
    };
    if !morceaux.is_empty() {
        // Les chiffres de Noto Sans montent à 0,714 cadratin : on centre
        // cette hauteur-là, pas la boîte de la police, qui prévoit des
        // jambages que les chiffres n'ont pas.
        let base = milieu + g.texte * 0.714 / 2.0;
        let vers_calque = |x: f32, y: f32| (x * s, (y - origine_y as f32) * s);
        let (x0, base0) = vers_calque(g.compteur_x, base);
        let corps = g.texte * s;
        // Ombre d'un pixel d'écran : sur une image très claire, le voile ne
        // suffit plus à détacher des chiffres aussi fins.
        let decalage = u * s;
        let mut x = x0;
        for (texte, _) in morceaux {
            x = peindre_texte(&mut p, texte, x, base0 + decalage, corps, NOIR, 0.35);
        }
        let mut x = x0;
        for (texte, opacite) in morceaux {
            x = peindre_texte(&mut p, texte, x, base0, corps, BLANC, *opacite);
        }
    }

    // Plein écran : quatre coins, sortants pour entrer, rentrants pour sortir.
    let grille = Grille::new(g.plein_x + g.cote / 2.0, milieu, g.cote);
    let coins: [[(f32, f32); 3]; 4] = if affichage.plein_ecran {
        [
            [(5.0, 9.0), (9.0, 9.0), (9.0, 5.0)],
            [(15.0, 5.0), (15.0, 9.0), (19.0, 9.0)],
            [(19.0, 15.0), (15.0, 15.0), (15.0, 19.0)],
            [(9.0, 19.0), (9.0, 15.0), (5.0, 15.0)],
        ]
    } else {
        [
            [(5.0, 9.5), (5.0, 5.0), (9.5, 5.0)],
            [(14.5, 5.0), (19.0, 5.0), (19.0, 9.5)],
            [(19.0, 14.5), (19.0, 19.0), (14.5, 19.0)],
            [(9.5, 19.0), (5.0, 19.0), (5.0, 14.5)],
        ]
    };
    for coin in coins {
        tracer(&mut p, grille.ligne(&coin, false), encre, 2.0 * grille.pas, t);
    }

    let bandeau = agrandir(&p, s, 0, origine_y, largeur, lignes, true);

    // Fermer : un ✕ dans une pastille sombre, en haut à droite. Il ferme le
    // lecteur — dans la bulle comme dans le mini-lecteur — là où un lien sous
    // la vidéo mangeait la légende.
    let x0 = ((g.fermer_x - u) as u32).min(largeur) & !1;
    let bas = ((g.fermer_y + g.fermer + u).ceil() as u32).min(hauteur);
    let mut bandes = vec![bandeau];
    if x0 < largeur && bas > 0 {
        let (l_coin, h_coin) = (largeur - x0, (bas + 1) & !1);
        let h_coin = h_coin.min(hauteur);
        if let Some(mut coin) = Pixmap::new(
            ((l_coin as f32 * s).ceil() as u32).max(1),
            ((h_coin as f32 * s).ceil() as u32).max(1),
        ) {
            let t = Transform::from_row(s, 0.0, 0.0, s, -(x0 as f32) * s, 0.0);
            let (cx, cy) = (g.fermer_x + g.fermer / 2.0, g.fermer_y + g.fermer / 2.0);
            remplir(&mut coin, PathBuilder::from_circle(cx, cy, g.fermer / 2.0), couleur(NOIR, 0.5), t);
            let grille = Grille::new(cx, cy, g.fermer);
            for trait_ in [[(8.0, 8.0), (16.0, 16.0)], [(16.0, 8.0), (8.0, 16.0)]] {
                tracer(&mut coin, grille.ligne(&trait_, false), encre, 2.0 * grille.pas, t);
            }
            bandes.push(agrandir(&coin, s, x0, 0, l_coin, h_coin, false));
        }
    }
    Some(Calque { bandes })
}

/// Opacité du voile, de 0 en haut du calque à `VOILE` tout en bas, en
/// accélérant : le bandeau reste lisible sur une image claire sans assombrir
/// la vidéo au-dessus.
///
/// Remplir ce dégradé avec tiny-skia coûtait 3,6 ms sur une vidéo de 1920
/// pixels de large — plus que tout le reste du bandeau. Uniforme en largeur,
/// il se calcule une fois par ligne, pendant l'agrandissement.
fn voile(fraction: f32) -> f32 {
    VOILE * fraction.clamp(0.0, 1.0).powf(1.4)
}

/// Contribution d'un pixel pré-multiplié aux plans Y, U, V, déjà multipliée
/// par son opacité — sur 255 × 255.
///
/// BT.601 en plage réduite, comme le shader et `libyuv::I420ToARGB` qui
/// affichent la toile. Les coefficients pleine plage employés jusqu'au 22/09
/// décalaient les teintes : l'accent bleu ressortait délavé.
fn vers_yuv(r: f32, v: f32, b: f32, a: f32) -> [f32; 4] {
    [
        a,
        16.0 * a + 219.0 * (0.299 * r + 0.587 * v + 0.114 * b),
        128.0 * a + 224.0 * (-0.168_736 * r - 0.331_264 * v + 0.5 * b),
        128.0 * a + 224.0 * (0.5 * r - 0.418_688 * v - 0.081_312 * b),
    ]
}

/// Passe du calque de travail, à la résolution de l'écran, à celle de
/// l'image.
///
/// L'interpolation porte sur les contributions pré-multipliées, pas sur les
/// couleurs : elles sont linéaires, donc les interpoler revient exactement à
/// interpoler l'image puis à la convertir.
///
/// `x` et `y` situent la bande dans l'image ; `voile` y ajoute le dégradé
/// sombre du bandeau.
fn agrandir(
    p: &Pixmap,
    s: f32,
    x: u32,
    y: u32,
    largeur: u32,
    lignes: u32,
    voile_sous: bool,
) -> Bande {
    let origine = (x, y);
    let (pl, ph) = (p.width() as usize, p.height() as usize);
    // Un plan par canal : opacité, Y, U, V.
    let mut plans: [Vec<f32>; 4] = std::array::from_fn(|_| vec![0f32; pl * ph]);
    for (i, c) in p.pixels().iter().enumerate() {
        let q = vers_yuv(c.red() as f32, c.green() as f32, c.blue() as f32, c.alpha() as f32);
        for (plan, valeur) in plans.iter_mut().zip(q) {
            plan[i] = valeur;
        }
    }

    // Voisins et poids d'une coordonnée de l'image dans le calque de travail.
    // `centre` est la position continue, en pixels de l'image.
    let voisins = |centre: f32, n: usize| -> (usize, usize, f32) {
        let x = (centre * s - 0.5).clamp(0.0, (n - 1) as f32);
        let x0 = x.floor() as usize;
        (x0, (x0 + 1).min(n - 1), x - x0 as f32)
    };
    // Agrandissement séparable : chaque ligne du calque de travail est étirée
    // une fois en largeur, puis chaque ligne de l'image mélange les deux
    // lignes étirées qui l'encadrent. Fait point par point, le bilinéaire
    // coûtait 11 ms sur une vidéo 1536x1920 — et le bandeau se redessine
    // plusieurs fois par seconde, sur le fil qui doit tenir 60 images.
    let etirer = |plan: &[f32], colonnes: &[(usize, usize, f32)]| -> Vec<f32> {
        let n = colonnes.len();
        let mut sortie = vec![0f32; n * ph];
        for (source, cible) in plan.chunks_exact(pl).zip(sortie.chunks_exact_mut(n)) {
            for (c, &(x0, x1, f)) in cible.iter_mut().zip(colonnes) {
                *c = source[x0] + (source[x1] - source[x0]) * f;
            }
        }
        sortie
    };
    let melanger = |etire: &[f32], (y0, y1, f): (usize, usize, f32), cible: &mut [f32]| {
        let n = cible.len();
        let (haut, bas) = (&etire[y0 * n..(y0 + 1) * n], &etire[y1 * n..(y1 + 1) * n]);
        for ((c, &h), &b) in cible.iter_mut().zip(haut).zip(bas) {
            *c = h + (b - h) * f;
        }
    };
    // `as` sature de lui-même, et l'arrondi par +0,5 évite l'appel à `roundf`
    // qu'impose `f32::round` sur une cible sans SSE4.1.
    let garde = |a: f32| 255 - (a + 0.5) as u8;
    let ajout = |v: f32| (v + 0.5).min(65025.0) as u16;

    // Le bandeau par-dessus le voile, en pré-multiplié : ce que le bandeau
    // laisse passer, le voile le noircit. Le noir vaut Y = 16 et U = V = 128
    // en plage réduite. Le voile est pris au centre de la ligne ou du bloc.
    let (l, n) = (largeur as usize, lignes as usize);
    let sous_le_bandeau = |centre: f32, a: f32| {
        if voile_sous {
            voile(centre / n as f32) * (255.0 - a)
        } else {
            0.0
        }
    };
    let colonnes: Vec<_> = (0..l).map(|x| voisins(x as f32 + 0.5, pl)).collect();
    let (etire_a, etire_y) = (etirer(&plans[0], &colonnes), etirer(&plans[1], &colonnes));
    let mut y_garde = vec![255u8; l * n];
    let mut y_ajout = vec![0u16; l * n];
    let (mut a, mut y) = (vec![0f32; l], vec![0f32; l]);
    for ligne in 0..n {
        let rang = voisins(ligne as f32 + 0.5, ph);
        melanger(&etire_a, rang, &mut a);
        melanger(&etire_y, rang, &mut y);
        let debut = ligne * l;
        let centre = ligne as f32 + 0.5;
        for x in 0..l {
            let noir = sous_le_bandeau(centre, a[x]);
            y_garde[debut + x] = garde(a[x] + noir);
            y_ajout[debut + x] = ajout(y[x] + 16.0 * noir);
        }
    }

    // Un échantillon au centre de chaque bloc 2×2 : c'est la moyenne des
    // quatre pixels, que la chrominance sous-échantillonnée représente.
    let (cl, cn) = (l.div_ceil(2), n.div_ceil(2));
    let colonnes: Vec<_> = (0..cl).map(|x| voisins(2.0 * x as f32 + 1.0, pl)).collect();
    let etires: [Vec<f32>; 3] = std::array::from_fn(|i| {
        // Opacité, U, V : le plan Y n'a rien à faire ici.
        etirer(&plans[[0, 2, 3][i]], &colonnes)
    });
    let mut c_garde = vec![255u8; cl * cn];
    let mut u_ajout = vec![0u16; cl * cn];
    let mut v_ajout = vec![0u16; cl * cn];
    let (mut a, mut u, mut v) = (vec![0f32; cl], vec![0f32; cl], vec![0f32; cl]);
    for ligne in 0..cn {
        let rang = voisins(2.0 * ligne as f32 + 1.0, ph);
        melanger(&etires[0], rang, &mut a);
        melanger(&etires[1], rang, &mut u);
        melanger(&etires[2], rang, &mut v);
        let debut = ligne * cl;
        let centre = 2.0 * ligne as f32 + 1.0;
        for x in 0..cl {
            let noir = sous_le_bandeau(centre, a[x]);
            c_garde[debut + x] = garde(a[x] + noir);
            u_ajout[debut + x] = ajout(u[x] + 128.0 * noir);
            v_ajout[debut + x] = ajout(v[x] + 128.0 * noir);
        }
    }

    Bande {
        x: origine.0,
        y: origine.1,
        largeur,
        lignes,
        y_garde,
        y_ajout,
        c_garde,
        u_ajout,
        v_ajout,
    }
}

/// Compose le calque sur des plans I420, en place.
pub fn composer_sur_i420(
    calque: &Calque,
    y: &mut [u8],
    u: &mut [u8],
    v: &mut [u8],
    largeur: u32,
    hauteur: u32,
) {
    for bande in &calque.bandes {
        composer_bande(bande, y, u, v, largeur, hauteur);
    }
}

fn composer_bande(b: &Bande, y: &mut [u8], u: &mut [u8], v: &mut [u8], largeur: u32, hauteur: u32) {
    if b.x + b.largeur > largeur {
        return;
    }
    let (l, h) = (largeur as usize, hauteur as usize);
    let (bx, by, bl) = (b.x as usize, b.y as usize, b.largeur as usize);
    let melange = |fond: u8, garde: u8, ajout: u16| {
        ((fond as u32 * garde as u32 + ajout as u32 + 127) / 255) as u8
    };

    for ligne in 0..b.lignes as usize {
        let absolue = by + ligne;
        let debut = absolue * l + bx;
        if absolue >= h || debut + bl > y.len() {
            break;
        }
        let fond = &mut y[debut..debut + bl];
        let garde = &b.y_garde[ligne * bl..(ligne + 1) * bl];
        let ajout = &b.y_ajout[ligne * bl..(ligne + 1) * bl];
        for ((f, &g), &a) in fond.iter_mut().zip(garde).zip(ajout) {
            if g != 255 {
                *f = melange(*f, g, a);
            }
        }
    }

    // L'origine est paire : les blocs de chrominance de la bande et ceux de
    // l'image portent sur les mêmes pixels.
    let (cl, ch) = (l.div_ceil(2), h.div_ceil(2));
    let cbl = bl.div_ceil(2);
    for ligne in 0..(b.lignes as usize).div_ceil(2) {
        let absolue = by / 2 + ligne;
        let debut = absolue * cl + bx / 2;
        if absolue >= ch || debut + cbl > u.len().min(v.len()) {
            break;
        }
        for x in 0..cbl {
            let g = b.c_garde[ligne * cbl + x];
            if g == 255 {
                continue;
            }
            let i = debut + x;
            u[i] = melange(u[i], g, b.u_ajout[ligne * cbl + x]);
            v[i] = melange(v[i], g, b.v_ajout[ligne * cbl + x]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUREE: u64 = 48_000;

    fn fin_compteur(z: &Zones) -> u32 {
        match z.compteur {
            Compteur::Aucun => z.volume_x + z.volume_l,
            _ => z.compteur_x + z.compteur_l,
        }
    }

    /// Le cas qui a cassé l'affichage : une vidéo verticale, affichée bien
    /// plus petite que sa résolution. Mesuré le 21/09 : lecteur de 263 pixels
    /// de large à l'écran, pour une toile de 1146.
    ///
    /// On ne fige pas ICI la disposition retenue — c'est un réglage, il
    /// bougera. Ce qui doit tenir, c'est l'invariant : tout rentre dans la
    /// largeur, et les commandes restent visables à l'écran.
    #[test]
    fn un_lecteur_etroit_reste_utilisable() {
        let echelle = 263.0 / 1146.0;
        let z = zones(1146, 1022, echelle, DUREE);

        let cote_ecran = z.taille as f32 * echelle;
        assert!(cote_ecran >= 16.0, "commandes trop petites : {cote_ecran} px");
        // Un lecteur étroit garde au moins la position : c'est ce qu'on
        // regarde, et la supprimer rendait le bandeau muet.
        assert_ne!(z.compteur, Compteur::Aucun);
        assert!(fin_compteur(&z) <= z.plein_x, "la rangée déborde sur le plein écran");
    }

    #[test]
    fn le_compteur_complet_tient_sur_une_bulle_etroite() {
        // Cas mesuré : vidéo verticale de 576 px de toile, affichée dans 191.
        let z = zones(576, 1022, 191.0 / 576.0, DUREE);
        assert_eq!(
            z.compteur,
            Compteur::Complet,
            "la durée doit rester visible : c'est elle qui situe la lecture"
        );
        assert!(fin_compteur(&z) <= z.plein_x);
    }

    /// Le cas signalé le 22/09 : une bulle de 190 pixels perdait la jauge
    /// de volume, que l'ancien bandeau y gardait.
    #[test]
    fn une_bulle_de_190_pixels_garde_la_jauge_et_la_duree() {
        let echelle = 190.0 / 720.0;
        let z = zones(720, 1280, echelle, 53_000);
        assert!(z.avec_jauge, "la jauge de volume doit rester");
        assert_eq!(z.compteur, Compteur::Complet);
        assert!(z.taille as f32 * echelle >= 16.5, "boutons trop petits");
        assert!(z.jauge_l as f32 * echelle >= 31.0, "jauge trop courte pour être réglée");
        assert!(fin_compteur(&z) <= z.plein_x);
    }

    #[test]
    fn une_duree_longue_elargit_le_compteur() {
        let court = zones(1920, 1080, 1.0, DUREE);
        let long = zones(1920, 1080, 1.0, 75 * 60_000);
        assert!(long.compteur_l > court.compteur_l);
    }

    #[test]
    fn un_lecteur_large_garde_tout() {
        let large = zones(1920, 1080, 1.0, DUREE);
        assert_eq!(large.compteur, Compteur::Complet);
        assert!(large.avec_jauge);
    }

    #[test]
    fn tout_tient_dans_la_largeur_meme_sur_une_video_verticale() {
        let z = zones(576, 1022, 0.4, DUREE);
        assert!(
            fin_compteur(&z) <= z.plein_x,
            "le compteur ({}) mord sur le plein écran ({})",
            fin_compteur(&z),
            z.plein_x
        );
        assert!(z.plein_x + z.plein_l <= 576);
    }

    #[test]
    fn le_bandeau_garde_sa_taille_a_l_ecran_quand_la_video_est_reduite() {
        // Réduite au tiers, l'image doit porter un bandeau trois fois plus
        // haut en pixels du média pour occuper la même place à l'écran.
        let reduite = zones(1920, 1080, 1.0 / 3.0, DUREE);
        let a_l_ecran = reduite.bandeau_h as f32 / 3.0;
        assert!((a_l_ecran - HAUTEUR_ECRAN).abs() < 1.5, "{a_l_ecran} px à l'écran");
    }

    /// En plein écran sur 1440 pixels, un bandeau de bulle devenait un
    /// liseré illisible (22/09).
    #[test]
    fn le_bandeau_grandit_en_plein_ecran_sans_exces() {
        let bulle = zones(720, 1280, 190.0 / 720.0, DUREE);
        let plein = zones(1382, 1382, 1.0, DUREE);
        let bulle_ecran = bulle.bandeau_h as f32 * 190.0 / 720.0;
        let plein_ecran = plein.bandeau_h as f32;
        assert!(plein_ecran > bulle_ecran * 1.4, "{plein_ecran} contre {bulle_ecran}");
        assert!(plein_ecran <= HAUTEUR_ECRAN * AGRANDI_MAX + 1.0);
    }

    #[test]
    fn les_zones_ne_se_chevauchent_pas() {
        let z = zones(800, 450, 1.0, DUREE);
        // La piste suit les marges de la rangée.
        assert!(z.barre_x > 0 && z.barre_x + z.barre_l <= 800);
        // La rangée s'ordonne : lecture, volume, compteur… puis plein écran.
        assert!(z.bouton_x + z.bouton_l <= z.volume_x);
        assert!(z.volume_x + z.volume_l <= z.compteur_x);
        assert!(z.compteur_x < z.plein_x);
        assert!(z.plein_x + z.plein_l <= 800);
        assert_eq!(z.bandeau_y + z.bandeau_h, 450);
    }

    /// Le front lit le niveau sur la piste de la jauge, et coupe le son sur
    /// l'icône : les deux doivent être dans la zone de volume, sans se
    /// recouvrir. Jusqu'au 22/09 il supposait l'icône large d'un cinquième de
    /// la zone quand elle en prenait plus du tiers.
    #[test]
    fn la_jauge_suit_l_icone_dans_la_zone_de_volume() {
        let z = zones(1920, 1080, 1.0, DUREE);
        assert!(z.avec_jauge);
        assert!(z.jauge_x >= z.volume_x + z.taille);
        assert!(z.jauge_x + z.jauge_l <= z.volume_x + z.volume_l);
    }

    /// Le bouton de fermeture est peint en haut à droite, dans l'image, et
    /// sa zone de clic tombe au même endroit.
    #[test]
    fn le_bouton_de_fermeture_est_peint_la_ou_il_se_clique() {
        let (l, h) = (320u32, 240u32);
        let mut y = vec![200u8; (l * h) as usize];
        let mut u = vec![128u8; (l * h / 4) as usize];
        let mut v = vec![128u8; (l * h / 4) as usize];
        let z = zones(l, h, 1.0, DUREE);
        assert!(z.fermer_x + z.fermer_l <= l && z.fermer_x > l / 2);
        assert!(z.fermer_y + z.fermer_l < h / 2);
        let calque = dessiner(l, h, &Affichage::default(), &etat(1000)).expect("calque");
        composer_sur_i420(&calque, &mut y, &mut u, &mut v, l, h);
        // Le bord de la pastille, hors du ✕ : assombri.
        let bord = ((z.fermer_y + z.fermer_l / 2) * l + z.fermer_x + 2) as usize;
        assert!(y[bord] < 160, "pastille absente : {}", y[bord]);
        // À gauche du bouton, rien.
        assert_eq!(y[((z.fermer_y + z.fermer_l / 2) * l + z.fermer_x - 12) as usize], 200);
    }

    #[test]
    fn une_image_minuscule_ne_produit_pas_de_zone_negative() {
        // Les soustractions doivent rester saturantes : une vidéo plus étroite
        // que le bandeau ne doit pas faire paniquer le rendu.
        let z = zones(40, 40, 1.0, DUREE);
        assert!(z.barre_l <= 40);
        assert!(z.plein_x < 40);
        let etat = EtatIncrustation {
            position_ms: 1000,
            duree_ms: DUREE,
            en_pause: false,
            volume: 1.0,
            apercu_ms: None,
            a_du_son: true,
        };
        let _ = dessiner(40, 40, &Affichage::default(), &etat);
    }

    fn etat(position_ms: u64) -> EtatIncrustation {
        EtatIncrustation {
            position_ms,
            duree_ms: DUREE,
            en_pause: false,
            volume: 1.0,
            apercu_ms: None,
            a_du_son: true,
        }
    }

    #[test]
    fn la_composition_assombrit_le_bas_et_laisse_le_haut_intact() {
        // Taille réaliste : sur une image plus petite que le bandeau, celui-ci
        // couvrirait tout et le test ne prouverait rien.
        let (l, h) = (320u32, 240u32);
        let mut y = vec![200u8; (l * h) as usize];
        let mut u = vec![128u8; (l * h / 4) as usize];
        let mut v = vec![128u8; (l * h / 4) as usize];
        let calque = dessiner(l, h, &Affichage::default(), &etat(1000)).expect("calque");
        // Le calque ne couvre QUE sa bande : c'est ce qui fait tenir la
        // cadence. Peindre toute la toile ramenait une vidéo 1536x1920 à
        // 4,5 images par seconde.
        let (origine, lignes) = calque.bandeau();
        assert!(lignes < h, "le calque doit être une bande, pas toute l'image");
        assert_eq!(origine + lignes, h);
        assert_eq!(origine % 2, 0, "l'origine doit tomber sur un bloc de chrominance");
        composer_sur_i420(&calque, &mut y, &mut u, &mut v, l, h);
        // Le haut de l'image n'est pas touché, hors du coin de fermeture…
        assert_eq!(y[0], 200);
        assert_eq!(y[(h / 2 * l) as usize], 200);
        // …le coin bas droit, hors des commandes, porte le voile.
        let bas = ((h - 1) * l + l / 2) as usize;
        assert!(y[bas] < 150, "le voile doit assombrir le bas : {}", y[bas]);
    }

    /// Le blanc des icônes et l'accent doivent ressortir tels quels APRÈS le
    /// shader, qui lit du BT.601 plage réduite.
    #[test]
    fn les_couleurs_survivent_a_la_conversion_du_shader() {
        let affiche = |r: f32, g: f32, b: f32| {
            let [a, y, u, v] = vers_yuv(r, g, b, 255.0);
            let (y, u, v) = (y / a / 255.0, u / a / 255.0 - 0.5, v / a / 255.0 - 0.5);
            let y = (y - 0.0625) * 1.164_383;
            [
                (y + 1.596_027 * v) * 255.0,
                (y - 0.391_762 * u - 0.812_968 * v) * 255.0,
                (y + 2.017_232 * u) * 255.0,
            ]
        };
        for rgb in [(255.0, 255.0, 255.0), (168.0, 199.0, 250.0), (0.0, 0.0, 0.0)] {
            let sortie = affiche(rgb.0, rgb.1, rgb.2);
            for (attendu, obtenu) in [rgb.0, rgb.1, rgb.2].iter().zip(sortie) {
                assert!((attendu - obtenu).abs() < 1.5, "{rgb:?} ressort en {sortie:?}");
            }
        }
    }

    #[test]
    fn le_bandeau_n_est_redessine_que_si_quelque_chose_bouge() {
        let affichage = Affichage { echelle: 0.3, densite: 1.0, plein_ecran: false };
        let cle = |ms| cle(576, 1022, &affichage, &etat(ms));
        // Une image plus tard, à 60 par seconde : ni le compteur ni la
        // pastille n'ont bougé d'un demi-pixel.
        assert_eq!(cle(10_000), cle(10_016));
        // Une seconde de plus : le compteur change.
        assert_ne!(cle(10_000), cle(11_000));
    }

    #[test]
    fn le_bandeau_est_peint_a_la_resolution_de_l_ecran() {
        // Réduit au tiers : le calque de travail a trois fois moins de
        // pixels par côté que l'image.
        assert_eq!(finesse(&Affichage { echelle: 1.0 / 3.0, densite: 1.0, plein_ecran: false }), 1.0 / 3.0);
        // Sur un écran à double densité, deux fois plus.
        let dense = finesse(&Affichage { echelle: 1.0 / 3.0, densite: 2.0, plein_ecran: false });
        assert!((dense - 2.0 / 3.0).abs() < 1e-6);
        // Jamais plus fin que le média lui-même.
        assert_eq!(finesse(&Affichage { echelle: 2.0, densite: 2.0, plein_ecran: false }), 1.0);
    }

    #[test]
    fn le_compteur_se_formate_en_minutes_et_secondes() {
        assert_eq!(mmss(0), "0:00");
        assert_eq!(mmss(7_000), "0:07");
        assert_eq!(mmss(66_000), "1:06");
        assert_eq!(mmss(3_600_000), "60:00");
    }

    /// Aperçu de ce que l'écran montrera — pas un test, un outil de réglage.
    ///
    /// `SION_APERCU=image.yuv:largeur:hauteur:echelle:densite:sortie[:options]
    /// cargo test -j4 --lib apercu -- --ignored` compose le bandeau sur une
    /// image I420 brute, la réduit comme le fait le GPU — bilinéaire, sans
    /// mipmaps — et écrit `sortie.png`, plus `sortie-x4.png`, le bas de
    /// l'image agrandi quatre fois pour juger au pixel près. `options` combine,
    /// séparés par des virgules, `pause`, `saisie`, `muet`, `plein`.
    #[test]
    #[ignore]
    fn apercu() {
        let Ok(spec) = std::env::var("SION_APERCU") else { return };
        let p: Vec<&str> = spec.split(':').collect();
        let (l, h): (u32, u32) = (p[1].parse().unwrap(), p[2].parse().unwrap());
        let (echelle, densite): (f32, f32) = (p[3].parse().unwrap(), p[4].parse().unwrap());
        let brut = std::fs::read(p[0]).unwrap();
        let n = (l * h) as usize;
        let mut y = brut[..n].to_vec();
        let mut u = brut[n..n + n / 4].to_vec();
        let mut v = brut[n + n / 4..n + n / 2].to_vec();
        let options: Vec<&str> = p.get(6).map_or(vec![], |o| o.split(',').collect());
        let etat = EtatIncrustation {
            en_pause: options.contains(&"pause"),
            apercu_ms: options.contains(&"saisie").then_some(31_000),
            volume: if options.contains(&"muet") { 0.0 } else { 1.0 },
            ..etat(17_000)
        };
        let affichage = Affichage { echelle, densite, plein_ecran: options.contains(&"plein") };
        let calque = dessiner(l, h, &affichage, &etat).unwrap();
        composer_sur_i420(&calque, &mut y, &mut u, &mut v, l, h);

        let sl = (l as f32 * echelle * densite).round() as u32;
        let sh = (h as f32 * echelle * densite).round() as u32;
        // `texture()` en GL_LINEAR, centre de texel à 0,5.
        let lire = |plan: &[u8], pl: u32, ph: u32, fx: f32, fy: f32| {
            let x = (fx * pl as f32 - 0.5).clamp(0.0, (pl - 1) as f32);
            let y = (fy * ph as f32 - 0.5).clamp(0.0, (ph - 1) as f32);
            let (x0, y0) = (x.floor() as u32, y.floor() as u32);
            let (x1, y1) = ((x0 + 1).min(pl - 1), (y0 + 1).min(ph - 1));
            let t = |a: u32, b: u32| plan[(b * pl + a) as usize] as f32 / 255.0;
            let haut = t(x0, y0) + (t(x1, y0) - t(x0, y0)) * (x - x0 as f32);
            let bas = t(x0, y1) + (t(x1, y1) - t(x0, y1)) * (x - x0 as f32);
            haut + (bas - haut) * (y - y0 as f32)
        };
        let mut ecran = Pixmap::new(sl, sh).unwrap();
        for j in 0..sh {
            for i in 0..sl {
                let (fx, fy) = ((i as f32 + 0.5) / sl as f32, (j as f32 + 0.5) / sh as f32);
                let yy = (lire(&y, l, h, fx, fy) - 0.0625) * 1.164_383;
                let uu = lire(&u, l / 2, h / 2, fx, fy) - 0.5;
                let vv = lire(&v, l / 2, h / 2, fx, fy) - 0.5;
                let rgb = [
                    yy + 1.596_027 * vv,
                    yy - 0.391_762 * uu - 0.812_968 * vv,
                    yy + 2.017_232 * uu,
                ];
                let k = ((j * sl + i) * 4) as usize;
                let d = ecran.data_mut();
                for c in 0..3 {
                    d[k + c] = (rgb[c] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
                d[k + 3] = 255;
            }
        }
        ecran.save_png(format!("{}.png", p[5])).unwrap();

        let z = 4;
        let bas = sh.min((70.0 * densite) as u32);
        let mut gros = Pixmap::new(sl * z, bas * z).unwrap();
        let (source, cible) = (ecran.data().to_vec(), gros.data_mut());
        for j in 0..bas * z {
            for i in 0..sl * z {
                let s = (((sh - bas + j / z) * sl + i / z) * 4) as usize;
                let d = ((j * sl * z + i) * 4) as usize;
                cible[d..d + 4].copy_from_slice(&source[s..s + 4]);
            }
        }
        gros.save_png(format!("{}-x4.png", p[5])).unwrap();
    }

    #[test]
    fn la_police_couvre_tout_ce_que_le_compteur_affiche() {
        let font = police().expect("police embarquée");
        for c in "0123456789:/ ".chars() {
            assert_ne!(font.glyph_id(c).0, 0, "glyphe manquant : {c:?}");
        }
    }
}
