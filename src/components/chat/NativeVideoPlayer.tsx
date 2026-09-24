// Lecteur vidéo natif — la vidéo est décodée par Rust et peinte dans la
// surface native, pas par le moteur web.
//
// Ce composant n'affiche RIEN : ni l'image, ni les contrôles. Il réserve un
// rectangle, l'annonce à Rust, et pose par-dessus des zones transparentes qui
// captent les clics.
//
// C'est imposé par la surface : le compositeur la pose au-dessus de la
// fenêtre, donc aucun élément de la page ne peut s'afficher devant elle —
// aucun `z-index` n'y change quoi que ce soit. Les contrôles sont donc peints
// par Rust dans les images elles-mêmes. Elle laisse en revanche passer les
// événements, sa région d'entrée étant vide : la page reste maîtresse des
// clics, du survol et du clavier.
//
// Voir docs/lecteur-video-natif.md et src-tauri/src/incrustation_lecteur.rs.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SENDER_LECTEUR,
  etatLecteurVideo,
  fermerLecteurVideo,
  ouvrirLecteurVideo,
  precharcherVideo,
  type ProgresVideo,
  pauseLecteurVideo,
  registerNativeVideoSurface,
  resolutionLecteurVideo,
  apercuLecteurVideo,
  seekLecteurVideo,
  volumeLecteurVideo,
  zonesLecteurVideo,
  type EtatLecteurVideo,
  type ZonesLecteur,
} from "../../services/voiceNativeService";
import { useSettingsStore } from "../../stores/useSettingsStore";

interface Props {
  /** Chemin local ou URL HTTP — ffmpeg lit les deux. */
  source: string;
  onClose: () => void;
  /** Proportions de l'affiche qu'on remplace, pour occuper exactement la
   *  même place dès le montage. Sans elles, le lecteur n'a aucune dimension
   *  tant que la première image n'est pas arrivée : la bulle se rétracte puis
   *  se rouvre, et la mise en lecture paraît sauter (21/09). */
  ratio?: string;
  /** Hauteur maximale hors plein écran, en pixels : 340 dans le fil, moins
   *  dans une zone d'aperçu plus basse. */
  hauteurMax?: number;
}

/** Voile de téléchargement, posé sur les pixels de la vidéo : il doit rester
 *  lisible sur l'image quel que soit le thème, comme la letterbox du partage.
 *  Marqué `theme-exempt` pour le garde anti-couleurs-en-dur. */
const VOILE_FOND = "rgba(0,0,0,0.55)"; // theme-exempt — voile posé sur le média
const VOILE_ENCRE = "#fff"; // theme-exempt — voile posé sur le média
/** Fond du mini-lecteur : la letterbox du média, noire quel que soit le
 *  thème, comme celle de la surface native qu'elle prolonge. */
const MINI_FOND = "#000"; // theme-exempt — letterbox du média
/** Boîte du mini-lecteur, en pixels CSS. La vidéo y tient en gardant ses
 *  proportions : une vidéo verticale y est plus haute que large. */
const MINI_LARGEUR = 320;
const MINI_HAUTEUR = 280;
/** Écart entre le mini-lecteur et les bords de la liste des messages. */
const MINI_MARGE = 16;

/** Premier ancêtre qui fait défiler son contenu : la liste des messages. */
function conteneurDefilant(element: HTMLElement | null): HTMLElement | null {
  for (let e = element?.parentElement ?? null; e; e = e.parentElement) {
    const { overflowY } = getComputedStyle(e);
    if (overflowY === "auto" || overflowY === "scroll") return e;
  }
  return null;
}

export function NativeVideoPlayer({ source, onClose, ratio, hauteurMax = 340 }: Props) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const cadreRef = useRef<HTMLDivElement>(null);
  const [pleinEcran, setPleinEcran] = useState(false);
  // Plein écran « de fenêtre » : le repli quand le navigateur refuse le vrai
  // (voir `basculerPleinEcran`). La fenêtre de Sion passe en plein écran et le
  // cadre s'étale dessus.
  const [pleinFenetre, setPleinFenetre] = useState(false);
  const pleinFenetreRef = useRef(false);
  const [etat, setEtat] = useState<EtatLecteurVideo | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // Avancement du rapatriement, avant que la moindre image existe.
  const [progres, setProgres] = useState<ProgresVideo | null>(null);
  const [zones, setZones] = useState<ZonesLecteur | null>(null);
  // Le volume suit l'utilisateur d'une vidéo à l'autre : il part du dernier
  // niveau retenu, pas de 100 %.
  const [volume, setVolume] = useState(() => useSettingsStore.getState().videoVolume);
  const retenirVolume = useSettingsStore((s) => s.setVideoVolume);
  // Volume d'avant la coupure, pour que le second clic rétablisse le niveau
  // choisi plutôt qu'un 100 % arbitraire.
  const [avantMuet, setAvantMuet] = useState(() => useSettingsStore.getState().videoVolume || 1);

  const largeurMedia = etat?.largeur ?? 0;

  const basculerPause = useCallback(() => {
    setEtat((precedent) => {
      if (!precedent?.actif) return precedent;
      const versPause = !precedent.en_pause;
      // Reprendre relance le film côté Rust : on prend l'état qu'il rend.
      void pauseLecteurVideo(versPause).then(setEtat).catch(() => { /* lecteur fermé */ });
      return { ...precedent, en_pause: versPause };
    });
  }, []);

  // La surface doit être déclarée AVANT d'ouvrir le fichier : les premières
  // images arrivent dès l'ouverture, et sans rectangle publié elles tombent.
  useEffect(() => {
    const canvas = surfaceRef.current;
    if (!canvas) return;
    let vivant = true;
    let liberer: (() => void) | null = null;

    void (async () => {
      liberer = await registerNativeVideoSurface(canvas, SENDER_LECTEUR);
      if (!vivant) {
        liberer?.();
        return;
      }
      try {
        // Le fichier d'abord, la lecture ensuite : l'ouverture est synchrone
        // côté Rust, donc y télécharger figerait la fenêtre entière.
        await precharcherVideo(source, (p) => { if (vivant) setProgres(p); });
        if (!vivant) return;
        setProgres(null);
        // Le niveau d'abord : Rust l'applique dès le premier échantillon.
        // Réglé après l'ouverture, un son coupé jouait un instant à fond.
        await volumeLecteurVideo(useSettingsStore.getState().videoVolume);
        const e = await ouvrirLecteurVideo(source);
        if (!vivant) return;
        setEtat(e);
      } catch (err) {
        if (vivant) setErreur(String(err));
      }
    })();

    return () => {
      vivant = false;
      void fermerLecteurVideo();
      liberer?.();
    };
  }, [source]);

  /**
   * Déclare l'échelle d'affichage et récupère la découpe du bandeau.
   *
   * À refaire chaque fois que la taille change — redimensionnement de la
   * fenêtre, passage en plein écran — sinon le bandeau serait dessiné pour
   * une taille qui n'est plus la bonne, et les zones de clic tomberaient à
   * côté.
   */
  const hauteurMedia = etat?.hauteur ?? 0;
  // Place du canvas DANS le cadre, en pixels. Les zones de clic s'y réfèrent :
  // en plein écran le canvas est centré et n'occupe plus tout le cadre, donc
  // des pourcentages du cadre tombaient à côté (21/09).
  const [boiteCanvas, setBoiteCanvas] = useState({ left: 0, top: 0, width: 0, height: 0 });
  // Dernier affichage déclaré à Rust. La densité et le plein écran en font
  // partie : glisser la fenêtre sur un écran plus dense ne change pas la
  // taille CSS, mais le bandeau doit être repeint plus finement.
  const dernierAffichage = useRef({ echelle: 0, densite: 0, plein: false });
  // Taille physique déclarée à Rust pour la toile. Envoyée seulement une fois
  // la géométrie posée : le passage en plein écran traverse plusieurs tailles
  // intermédiaires, et chacune coûterait une relance de ffmpeg.
  const derniereResolution = useRef("");
  const minuterieResolution = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(minuterieResolution.current), []);
  const mesurer = useCallback((force = false) => {
    const boite = surfaceRef.current?.getBoundingClientRect();
    const cadre = cadreRef.current?.getBoundingClientRect();
    if (!boite?.width || !cadre || !largeurMedia || !hauteurMedia) return;
    const place = {
      left: boite.left - cadre.left,
      top: boite.top - cadre.top,
      width: boite.width,
      height: boite.height,
    };
    // Ne remplacer que si la place a réellement bougé : un nouvel objet à
    // chaque mesure ferait un rendu par notification du ResizeObserver.
    setBoiteCanvas((ancienne) =>
      Math.abs(ancienne.left - place.left) < 0.5
      && Math.abs(ancienne.top - place.top) < 0.5
      && Math.abs(ancienne.width - place.width) < 0.5
      && Math.abs(ancienne.height - place.height) < 0.5
        ? ancienne
        : place,
    );
    const echelle = boite.width / largeurMedia;
    const densite = window.devicePixelRatio || 1;
    const plein = document.fullscreenElement === cadreRef.current || pleinFenetreRef.current;
    const physique = { l: Math.round(boite.width * densite), h: Math.round(boite.height * densite) };
    const cle = `${physique.l}x${physique.h}`;
    // Toute nouvelle mesure annule l'envoi en attente — y compris celle qui
    // revient à la taille déjà envoyée : sortie du plein écran en moins de
    // 400 ms, l'envoi prévu pour lui relançait ffmpeg à contretemps.
    window.clearTimeout(minuterieResolution.current);
    if (cle !== derniereResolution.current) {
      minuterieResolution.current = window.setTimeout(() => {
        derniereResolution.current = cle;
        void resolutionLecteurVideo(physique.l, physique.h)
          .then(setEtat)
          .catch(() => { /* lecture terminée */ });
      }, 400);
    }
    const dernier = dernierAffichage.current;
    // Seuil de 2 % : sans lui, le moindre pixel de variation renvoyait une
    // échelle, qui redessinait le bandeau, qui pouvait faire varier la
    // mesure suivante. On coupe la boucle plutôt que d'en amortir les effets.
    if (
      !force
      && dernier.densite === densite
      && dernier.plein === plein
      && Math.abs(echelle - dernier.echelle) < dernier.echelle * 0.02
    ) {
      return;
    }
    dernierAffichage.current = { echelle, densite, plein };
    void zonesLecteurVideo(largeurMedia, hauteurMedia, echelle, densite, plein)
      .then(setZones)
      .catch(() => { /* lecture terminée */ });
  }, [largeurMedia, hauteurMedia]);

  /** Remesure sur plusieurs échéances : la géométrie d'un passage en plein
   *  écran change en plusieurs reflows, pas en une image (voir plus bas). */
  const remesurer = useCallback(() => {
    for (const delai of [0, 120, 350, 700]) {
      window.setTimeout(() => mesurer(true), delai);
    }
  }, [mesurer]);

  const pleinEcranFenetre = useCallback((plein: boolean) => {
    pleinFenetreRef.current = plein;
    setPleinFenetre(plein);
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(plein))
      .catch((err) => console.warn("[Sion][lecteur] plein écran de la fenêtre impossible", err));
    remesurer();
  }, [remesurer]);

  useEffect(() => {
    mesurer();
    const canvas = surfaceRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observateur = new ResizeObserver(() => mesurer());
    observateur.observe(canvas);
    return () => observateur.disconnect();
  }, [mesurer]);

  // Position et état : Rust les tient, la page les relit. Quatre fois par
  // seconde, assez pour que la barre incrustée paraisse continue.
  useEffect(() => {
    if (!etat?.actif) return;
    const timer = window.setInterval(() => {
      // Rust renvoie les dimensions : les recopier depuis l'ancien état les
      // perdait, et l'échelle retombait à zéro (21/09).
      void etatLecteurVideo().then(setEtat);
    }, 250);
    return () => window.clearInterval(timer);
  }, [etat?.actif]);

  // Fin du film : Rust a tout démonté, `actif` retombe à faux. On rend la
  // main à la carte, qui remontre son affiche et sa pastille de lecture —
  // rouvrir revient alors à relire depuis le début.
  useEffect(() => {
    if (etat && !etat.actif) onClose();
  }, [etat, onClose]);

  const actif = etat?.actif ?? false;

  // Mini-lecteur. Sortie du champ, la bulle continuait de jouer — le son
  // sans l'image ni les commandes — jusqu'à la fin du film (22/09). Le
  // lecteur flotte désormais dans le coin de la liste, et regagne sa bulle
  // quand elle réapparaît.
  //
  // C'est le MÊME cadre qui passe en position fixe : le déplacer ailleurs
  // dans le DOM remonterait le composant, donc fermerait la lecture.
  const placeRef = useRef<HTMLDivElement>(null);
  const [horsChamp, setHorsChamp] = useState(false);
  useEffect(() => {
    const place = placeRef.current;
    if (!place || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entree]) => {
      // Hystérésis : sortie sous 30 % visible, retour au-delà de 60 %. Un
      // seuil unique ferait hésiter le lecteur au bord de la liste.
      if (entree.intersectionRatio < 0.3) setHorsChamp(true);
      else if (entree.intersectionRatio >= 0.6) setHorsChamp(false);
    }, { threshold: [0, 0.3, 0.6, 1] });
    io.observe(place);
    return () => io.disconnect();
  }, []);
  const flottant = horsChamp && actif && !pleinEcran && !pleinFenetre;
  // Coin bas droit de la liste des messages, recalculé si la fenêtre change.
  const [coin, setCoin] = useState({ droite: MINI_MARGE, bas: MINI_MARGE, largeurMax: MINI_LARGEUR });
  useEffect(() => {
    if (!flottant) return;
    const placer = () => {
      const liste = conteneurDefilant(placeRef.current)?.getBoundingClientRect()
        ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      setCoin({
        droite: window.innerWidth - liste.right + MINI_MARGE,
        bas: window.innerHeight - liste.bottom + MINI_MARGE,
        largeurMax: Math.max(120, liste.width - 2 * MINI_MARGE),
      });
    };
    placer();
    window.addEventListener("resize", placer);
    return () => window.removeEventListener("resize", placer);
  }, [flottant]);
  const mini = (() => {
    const proportions = etat?.largeur && etat.hauteur ? etat.largeur / etat.hauteur : 16 / 9;
    let largeur = Math.min(MINI_LARGEUR, coin.largeurMax);
    let hauteur = largeur / proportions;
    if (hauteur > MINI_HAUTEUR) {
      hauteur = MINI_HAUTEUR;
      largeur = hauteur * proportions;
    }
    return { largeur, hauteur };
  })();
  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      // Les raccourcis écoutent toute la fenêtre : une frappe destinée à un
      // champ ne les concerne pas. Sans ce filtre, taper un espace dans un
      // message pendant qu'une vidéo jouait la mettait en pause, et l'espace
      // n'était jamais écrit (23/09).
      const cible = e.target as HTMLElement | null;
      if (cible && (cible.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName))) return;
      // Échap sort d'abord du plein écran de fenêtre, comme il sort du vrai.
      if (e.key === "Escape") {
        if (pleinFenetreRef.current) pleinEcranFenetre(false);
        else onClose();
      }
      if (e.key === " " && actif) {
        e.preventDefault();
        basculerPause();
      }
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, [onClose, actif, basculerPause, pleinEcranFenetre]);

  /**
   * Convertit une abscisse de la page en fraction d'une zone du média.
   *
   * Rust dessine en pixels de la vidéo, la page mesure en pixels d'écran, et
   * la surface est mise à l'échelle pour tenir dans le cadre : il faut
   * repasser par le ratio plutôt que de comparer des pixels entre eux.
   */
  const fractionDansZone = useCallback(
    (clientX: number, debut: number, longueur: number): number => {
      const boite = surfaceRef.current?.getBoundingClientRect();
      if (!boite?.width || !largeurMedia || !longueur) return 0;
      const echelle = boite.width / largeurMedia;
      const x = (clientX - boite.left) / echelle;
      return Math.min(1, Math.max(0, (x - debut) / longueur));
    },
    [largeurMedia],
  );

  // Les zones de clic sont exprimées en pourcentages du média : la surface
  // est redimensionnée à l'affichage, les proportions sont le seul repère
  // stable entre ce que Rust peint et ce que la page mesure.
  const zoneStyle = (x: number, l: number, y: number, h: number): React.CSSProperties | null => {
    if (!zones || !etat?.largeur || !etat.hauteur || !boiteCanvas.width) return null;
    const kx = boiteCanvas.width / etat.largeur;
    const ky = boiteCanvas.height / etat.hauteur;
    return {
      position: 'absolute',
      left: boiteCanvas.left + x * kx,
      width: l * kx,
      top: boiteCanvas.top + y * ky,
      height: h * ky,
      cursor: 'pointer',
    };
  };

  // La barre court sur toute la largeur, mais sa zone de clic ne doit couvrir
  // QUE sa propre bande. Étendue à tout le bandeau, elle recouvrait le bouton,
  // le volume et le plein écran : cliquer « pause » déclenchait un
  // déplacement dans la vidéo (21/09).
  const rangeeY = zones ? zones.bandeau_y + zones.rangee_y : 0;
  // Zone de saisie du temps : elle déborde largement au-dessus du bandeau.
  // La barre visible ne fait que quelques pixels une fois la vidéo réduite —
  // quatre à l'écran sur le cas mesuré — et viser une cible pareille est
  // impossible (21/09). On accepte de mordre sur le bas de l'image : rien n'y
  // est cliquable, et la lecture-pause reste accessible partout ailleurs.
  // Elle couvre toute la largeur, marges comprises : la piste est en retrait
  // des bords, mais un clic juste à côté de son extrémité doit viser le
  // début ou la fin, pas mettre en pause.
  const styleBarre = zones && etat
    ? zoneStyle(
        0,
        etat.largeur,
        Math.max(0, zones.bandeau_y - zones.taille),
        zones.taille + zones.rangee_y,
      )
    : null;
  const styleBouton = zones ? zoneStyle(zones.bouton_x, zones.bouton_l, rangeeY, zones.taille) : null;
  const styleVolume = zones ? zoneStyle(zones.volume_x, zones.volume_l, rangeeY, zones.taille) : null;
  const stylePlein = zones ? zoneStyle(zones.plein_x, zones.plein_l, rangeeY, zones.taille) : null;
  const styleFermer = zones ? zoneStyle(zones.fermer_x, zones.fermer_l, zones.fermer_y, zones.fermer_l) : null;

  /**
   * Plein écran sur le canvas lui-même.
   *
   * Le rectangle publié à Rust couvre alors tout l'écran, et la surface le
   * suit : les contrôles incrustés grandissent avec l'image, sans rien de
   * particulier à prévoir.
   */
  const basculerPleinEcran = () => {
    const cadre = cadreRef.current;
    if (!cadre) return;
    if (pleinFenetreRef.current) {
      pleinEcranFenetre(false);
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* déjà sorti */ });
    } else {
      // Le navigateur n'accorde le plein écran qu'à un vrai geste de
      // l'utilisateur. Sous Windows, les clics sur la vidéo arrivent à la
      // page REJOUÉS depuis la fenêtre vidéo native, qui capte la souris : le
      // plein écran était refusé (24/09). La fenêtre de Sion prend alors le
      // relais.
      void cadre.requestFullscreen().catch(() => pleinEcranFenetre(true));
    }
  };

  // Lecteur fermé en plein écran de fenêtre : la fenêtre revient à sa taille.
  useEffect(() => () => {
    if (pleinFenetreRef.current) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(false))
        .catch(() => { /* fenêtre fermée */ });
    }
  }, []);

  // Le plein écran porte sur le CADRE, jamais sur le canvas : mis en plein
  // écran, un élément se voit imposer toute la surface et perd son ratio. Le
  // canvas passait ainsi à 5120×1440 pour une vidéo de 576×1022, réduite à
  // un timbre au milieu (21/09). Le cadre, lui, reste un conteneur centré et
  // le canvas y garde ses contraintes — seule la hauteur disponible change.
  useEffect(() => {
    const suivre = () => {
      setPleinEcran(document.fullscreenElement === cadreRef.current);
      // La géométrie change du tout au tout, et pas en une seule image : le
      // retour à la taille normale passe par plusieurs reflows, et une
      // mesure unique attrapait une taille intermédiaire — le bandeau restait
      // alors dessiné pour le plein écran, donc minuscule (21/09).
      //
      // On remesure sur plusieurs échéances, en forçant le renvoi : le seuil
      // anti-oscillation n'a pas à filtrer un changement aussi franc.
      for (const delai of [0, 120, 350, 700]) {
        window.setTimeout(() => mesurer(true), delai);
      }
    };
    document.addEventListener("fullscreenchange", suivre);
    return () => document.removeEventListener("fullscreenchange", suivre);
  }, [mesurer]);

  // La croix du bandeau n'existe qu'une fois la lecture partie : en erreur ou
  // pendant le téléchargement, c'est ce bouton-ci qui ferme le lecteur.
  const boutonFermer = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      title={t("chat.closePlayer")}
      aria-label={t("chat.closePlayer")}
      style={{
        position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14,
        border: 'none', cursor: 'pointer', pointerEvents: 'auto', fontSize: 14, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--color-surface-container-highest)', color: 'var(--color-on-surface)',
      }}
    >
      ✕
    </button>
  );

  if (erreur) {
    return (
      <div style={{ position: 'relative', padding: '10px 44px 10px 14px', borderRadius: 12, background: 'var(--color-surface-container-high)', color: 'var(--color-error)', fontSize: 12 }}>
        {t("chat.videoPlayFailed", { defaultValue: "Lecture impossible" })} — {erreur}
        {boutonFermer}
      </div>
    );
  }

  return (
    // Le lecteur remplit le cadre que la carte lui donne : elle garde sa
    // taille et sa légende, on n'échange que le contenu. Un arbre séparé
    // faisait démonter la carte au démarrage, et toute la liste sursautait.
    <div ref={placeRef} style={{ position: 'absolute', inset: 0 }}>
      {/* La bulle, pendant que le lecteur flotte ailleurs. */}
      {flottant && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-outline)',
            fontSize: 12,
            pointerEvents: 'none',
          }}
        >
          {t("chat.videoInMiniPlayer", { defaultValue: "Lecture dans le mini-lecteur" })}
        </div>
      )}
      <div
        ref={cadreRef}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          // Aligné à gauche hors plein écran, comme l'affiche qu'il remplace :
          // centré, il semblait se déplacer au démarrage.
          justifyContent: pleinEcran || pleinFenetre ? 'center' : 'flex-start',
          alignItems: 'center',
          // Avant la première image, on occupe la place de l'affiche.
          ...(etat ? {} : { aspectRatio: ratio, maxHeight: hauteurMax, alignSelf: 'flex-start' }),
          // En plein écran, le cadre occupe l'écran et c'est lui qui donne sa
          // hauteur au canvas, qui garde son ratio.
          ...(pleinEcran ? { background: 'var(--color-surface-container-lowest)', height: '100%' } : {}),
          // Plein écran de fenêtre : le cadre recouvre toute la fenêtre, déjà
          // passée en plein écran, au-dessus de tout le reste de la page.
          ...(pleinFenetre
            ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 1500, background: 'var(--color-surface-container-lowest)' }
            : {}),
          ["--sion-share-max-height" as string]: pleinEcran || pleinFenetre ? '96vh' : `${hauteurMax}px`,
          ...(flottant
            ? {
                position: 'fixed',
                right: coin.droite,
                bottom: coin.bas,
                width: mini.largeur,
                height: mini.hauteur,
                // Au-dessus de la liste, sous les menus et les fenêtres :
                // ses zones de clic ne doivent pas leur voler la souris.
                zIndex: 30,
                justifyContent: 'center',
                borderRadius: 12,
                overflow: 'hidden',
                background: MINI_FOND,
                boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                ["--sion-share-max-height" as string]: `${mini.hauteur}px`,
              }
            : {}),
        } as React.CSSProperties}
      >
        <canvas
          ref={surfaceRef}
          onClick={basculerPause}
          onDoubleClick={basculerPleinEcran}
          // Pas d'infobulle sur l'image : celle du système s'affiche en plein
          // milieu de la vidéo au moindre survol, et le geste est assez
          // courant pour se passer d'explication.
          style={{
            width: '100%',
            display: 'block',
            background: 'transparent',
            cursor: 'pointer',
          }}
        />

        {/* Le transfert, tant qu'il n'y a rien à montrer. Sans ce retour, un
            gros fichier laisse un rectangle noir sans explication. */}
        {progres && !etat && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              background: VOILE_FOND,
              color: VOILE_ENCRE,
              fontSize: 12,
              pointerEvents: 'none',
            }}
          >
            <span>
              {t("chat.videoDownloading", { defaultValue: "Téléchargement…" })}
              {progres.total > 0
                ? ` ${Math.round((progres.recus / progres.total) * 100)} %`
                : ` ${Math.round(progres.recus / 1048576)} Mo`}
            </span>
            <div style={{ width: '60%', maxWidth: 260, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: progres.total > 0 ? `${(progres.recus / progres.total) * 100}%` : '100%',
                  background: 'var(--color-primary)',
                  transition: 'width 120ms linear',
                }}
              />
            </div>
            {boutonFermer}
          </div>
        )}

        {/* Zones transparentes alignées sur ce que Rust dessine. Elles ne
            montrent rien : toute l'apparence est dans l'image. */}
        {styleBouton && (
          <div
            onClick={(e) => { e.stopPropagation(); basculerPause(); }}
            title={etat?.en_pause ? t("chat.play", { defaultValue: "Lire" }) : t("chat.pause", { defaultValue: "Pause" })}
            style={styleBouton}
          />
        )}
        {styleBarre && zones && (
          <div
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!etat?.duree_ms) return;
              const duree = etat.duree_ms;
              // Glisser plutôt que cliquer : on suit la souris, et on ne
              // relance ffmpeg qu'au relâchement. Un saut par pixel parcouru
              // redémarrerait les deux processus des dizaines de fois.
              const viser = (x: number) =>
                fractionDansZone(x, zones.barre_x, zones.barre_l) * duree;
              let cible = viser(e.clientX);
              void apercuLecteurVideo(cible);
              // Un envoi toutes les 40 ms suffit à suivre la souris sans
              // saturer le pont : le rendu, lui, tourne à la cadence de la
              // vidéo.
              let dernier = 0;
              const bouge = (ev: MouseEvent) => {
                cible = viser(ev.clientX);
                const t = performance.now();
                if (t - dernier < 40) return;
                dernier = t;
                void apercuLecteurVideo(cible);
              };
              const relache = () => {
                window.removeEventListener("mousemove", bouge);
                window.removeEventListener("mouseup", relache);
                void apercuLecteurVideo(null);
                void seekLecteurVideo(cible).then(setEtat).catch(() => { /* lecture finie */ });
              };
              window.addEventListener("mousemove", bouge);
              window.addEventListener("mouseup", relache);
            }}
            title={t("chat.seek", { defaultValue: "Aller à cette position" })}
            style={styleBarre}
          />
        )}
        {styleVolume && zones && etat?.a_du_son && (
          <div
            onMouseDown={(e) => {
              e.stopPropagation();
              // Le niveau se lit sur la piste de la jauge, que Rust situe
              // après l'icône : supposer une proportion de la zone faisait
              // tomber la pastille à côté du pointeur.
              const niveau = (x: number) => fractionDansZone(x, zones.jauge_x, zones.jauge_l) * 1.5;
              // Un clic sur l'icône coupe le son au lieu de le mettre à zéro,
              // et un second rend le niveau d'avant. Sans jauge, toute la zone
              // est l'icône.
              if (!zones.avec_jauge || fractionDansZone(e.clientX, zones.volume_x, zones.taille) < 1) {
                const coupe = volume > 0;
                if (coupe) setAvantMuet(volume);
                const v = coupe ? 0 : avantMuet || 1;
                setVolume(v);
                retenirVolume(v);
                void volumeLecteurVideo(v);
                return;
              }
              // Glissement : le volume s'applique en direct, il n'y a rien à
              // relancer — contrairement au déplacement dans la vidéo.
              let dernier = niveau(e.clientX);
              const appliquer = (x: number) => {
                dernier = niveau(x);
                setVolume(dernier);
                void volumeLecteurVideo(dernier);
              };
              appliquer(e.clientX);
              const bouge = (ev: MouseEvent) => appliquer(ev.clientX);
              // Retenu au relâchement seulement : les réglages sont réécrits
              // en entier à chaque changement, pas à chaque pixel parcouru.
              const relache = () => {
                window.removeEventListener("mousemove", bouge);
                window.removeEventListener("mouseup", relache);
                retenirVolume(dernier);
              };
              window.addEventListener("mousemove", bouge);
              window.addEventListener("mouseup", relache);
            }}
            title={t("chat.volume", { defaultValue: "Volume" })}
            style={styleVolume}
          />
        )}
        {stylePlein && (
          <div
            onClick={(e) => { e.stopPropagation(); basculerPleinEcran(); }}
            title={t("chat.fullscreen", { defaultValue: "Plein écran" })}
            style={stylePlein}
          />
        )}
        {styleFermer && (
          <div
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title={t("chat.closePlayer", { defaultValue: "Fermer le lecteur" })}
            style={styleFermer}
          />
        )}
      </div>

    </div>
  );
}
