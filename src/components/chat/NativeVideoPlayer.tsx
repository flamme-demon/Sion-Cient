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
  rejouerLecteurVideo,
  precharcherVideo,
  type ProgresVideo,
  pauseLecteurVideo,
  registerNativeVideoSurface,
  apercuLecteurVideo,
  seekLecteurVideo,
  volumeLecteurVideo,
  zonesLecteurVideo,
  type EtatLecteurVideo,
  type ZonesLecteur,
} from "../../services/voiceNativeService";

interface Props {
  /** Chemin local ou URL HTTP — ffmpeg lit les deux. */
  source: string;
  onClose: () => void;
  /** Proportions de l'affiche qu'on remplace, pour occuper exactement la
   *  même place dès le montage. Sans elles, le lecteur n'a aucune dimension
   *  tant que la première image n'est pas arrivée : la bulle se rétracte puis
   *  se rouvre, et la mise en lecture paraît sauter (21/09). */
  ratio?: string;
}

/** Voile de téléchargement, posé sur les pixels de la vidéo : il doit rester
 *  lisible sur l'image quel que soit le thème, comme la letterbox du partage.
 *  Marqué `theme-exempt` pour le garde anti-couleurs-en-dur. */
const VOILE_FOND = "rgba(0,0,0,0.55)"; // theme-exempt — voile posé sur le média
const VOILE_ENCRE = "#fff"; // theme-exempt — voile posé sur le média

export function NativeVideoPlayer({ source, onClose, ratio }: Props) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const cadreRef = useRef<HTMLDivElement>(null);
  const [pleinEcran, setPleinEcran] = useState(false);
  const [etat, setEtat] = useState<EtatLecteurVideo | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // Avancement du rapatriement, avant que la moindre image existe.
  const [progres, setProgres] = useState<ProgresVideo | null>(null);
  const [zones, setZones] = useState<ZonesLecteur | null>(null);
  const [volume, setVolume] = useState(1);
  // Volume d'avant la coupure, pour que le second clic rétablisse le niveau
  // choisi plutôt qu'un 100 % arbitraire.
  const [avantMuet, setAvantMuet] = useState(1);

  const largeurMedia = etat?.largeur ?? 0;

  const basculerPause = useCallback(() => {
    setEtat((precedent) => {
      if (!precedent?.actif) return precedent;
      // Après la dernière image, la pause n'a plus de sens : le fil garde
      // l'écran mais son ffmpeg est mort. Le bouton relance le film.
      if (precedent.termine) {
        void rejouerLecteurVideo().then(setEtat).catch(() => { /* lecteur fermé */ });
        return precedent;
      }
      const versPause = !precedent.en_pause;
      void pauseLecteurVideo(versPause);
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
  const derniereEchelle = useRef(0);
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
    // Seuil de 2 % : sans lui, le moindre pixel de variation renvoyait une
    // échelle, qui redessinait le bandeau, qui pouvait faire varier la
    // mesure suivante. On coupe la boucle plutôt que d'en amortir les effets.
    if (!force && Math.abs(echelle - derniereEchelle.current) < derniereEchelle.current * 0.02) {
      return;
    }
    derniereEchelle.current = echelle;
    void zonesLecteurVideo(largeurMedia, hauteurMedia, echelle)
      .then(setZones)
      .catch(() => { /* lecture terminée */ });
  }, [largeurMedia, hauteurMedia]);

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

  const actif = etat?.actif ?? false;
  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === " " && actif) {
        e.preventDefault();
        basculerPause();
      }
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, [onClose, actif, basculerPause]);

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
  const styleBarre = zones
    ? zoneStyle(
        0,
        zones.barre_l,
        Math.max(0, zones.bandeau_y - zones.taille),
        zones.taille + zones.rangee_y,
      )
    : null;
  const styleBouton = zones ? zoneStyle(zones.bouton_x, zones.bouton_l, rangeeY, zones.taille) : null;
  const styleVolume = zones ? zoneStyle(zones.volume_x, zones.volume_l, rangeeY, zones.taille) : null;
  const stylePlein = zones ? zoneStyle(zones.plein_x, zones.plein_l, rangeeY, zones.taille) : null;

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
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* déjà sorti */ });
    } else {
      void cadre.requestFullscreen().catch((err) => {
        console.warn("[Sion][lecteur] plein écran refusé", err);
      });
    }
  };

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

  if (erreur) {
    return (
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--color-surface-container-high)', color: 'var(--color-error)', fontSize: 12 }}>
        {t("chat.videoPlayFailed", { defaultValue: "Lecture impossible" })} — {erreur}
      </div>
    );
  }

  return (
    // Le lecteur remplit le cadre que la carte lui donne : elle garde sa
    // taille et sa légende, on n'échange que le contenu. Un arbre séparé
    // faisait démonter la carte au démarrage, et toute la liste sursautait.
    <div style={{ position: 'absolute', inset: 0 }}>
      <div
        ref={cadreRef}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          // Aligné à gauche hors plein écran, comme l'affiche qu'il remplace :
          // centré, il semblait se déplacer au démarrage.
          justifyContent: pleinEcran ? 'center' : 'flex-start',
          alignItems: 'center',
          // Avant la première image, on occupe la place de l'affiche.
          ...(etat ? {} : { aspectRatio: ratio, maxHeight: 340, alignSelf: 'flex-start' }),
          // En plein écran, le cadre occupe l'écran et c'est lui qui donne sa
          // hauteur au canvas, qui garde son ratio.
          ...(pleinEcran ? { background: 'var(--color-surface-container-lowest)', height: '100%' } : {}),
          ["--sion-share-max-height" as string]: pleinEcran ? '96vh' : '340px',
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
          </div>
        )}

        {/* Zones transparentes alignées sur ce que Rust dessine. Elles ne
            montrent rien : toute l'apparence est dans l'image. */}
        {styleBouton && (
          <div
            onClick={(e) => { e.stopPropagation(); basculerPause(); }}
            title={
              etat?.termine
                ? t("chat.replay", { defaultValue: "Revoir" })
                : etat?.en_pause
                  ? t("chat.play", { defaultValue: "Lire" })
                  : t("chat.pause", { defaultValue: "Pause" })
            }
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
              const niveau = (x: number) => {
                const f = fractionDansZone(x, zones.volume_x, zones.volume_l);
                // La jauge commence après l'icône, qui occupe le premier
                // cinquième de la zone.
                return Math.min(1.5, Math.max(0, ((f - 0.2) / 0.8) * 1.5));
              };
              // Un clic sur l'icône coupe le son au lieu de le mettre à zéro,
              // et un second rend le niveau d'avant.
              if (fractionDansZone(e.clientX, zones.volume_x, zones.volume_l) < 0.2) {
                const coupe = volume > 0;
                if (coupe) setAvantMuet(volume);
                const v = coupe ? 0 : avantMuet || 1;
                setVolume(v);
                void volumeLecteurVideo(v);
                return;
              }
              // Glissement : le volume s'applique en direct, il n'y a rien à
              // relancer — contrairement au déplacement dans la vidéo.
              const appliquer = (x: number) => {
                const v = niveau(x);
                setVolume(v);
                void volumeLecteurVideo(v);
              };
              appliquer(e.clientX);
              const bouge = (ev: MouseEvent) => appliquer(ev.clientX);
              const relache = () => {
                window.removeEventListener("mousemove", bouge);
                window.removeEventListener("mouseup", relache);
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
      </div>

    </div>
  );
}
