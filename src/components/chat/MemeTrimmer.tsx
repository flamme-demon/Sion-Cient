// Découpe d'un meme : l'image de la vidéo, un curseur de début, un curseur de
// fin.
//
// L'image est celle de l'instant sous le curseur qu'on déplace, extraite par
// ffmpeg : la balise vidéo de la vue web ne lit pas tout, selon les greffons
// de la machine. « Tester » joue l'extrait préparé au même endroit, avec le
// lecteur natif du fil.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { blobPrepare, imageMeme, MEME_DUREE_MAX_MS } from "../../services/memeboardService";

const NativeVideoPlayer = lazy(() =>
  import("./NativeVideoPlayer").then((m) => ({ default: m.NativeVideoPlayer })),
);

interface Props {
  /** Chemin de la source déposée sur le disque. */
  source: string;
  dureeMs: number;
  onChange: (debutMs: number, finMs: number) => void;
  /** Extrait préparé à jouer dans la zone d'image, ou `null`. */
  essai: string | null;
  /** L'essai est fini, fermé, ou interrompu par un curseur. */
  onFinEssai: () => void;
}

/** Hauteur de la zone d'image — et du lecteur pendant l'essai. */
const HAUTEUR_ZONE = 240;

/** Écart minimal entre les deux curseurs. */
const DUREE_MIN_MS = 500;

/** m:ss.d */
function temps(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function MemeTrimmer({ source, dureeMs, onChange, essai, onFinEssai }: Props) {
  const { t } = useTranslation();
  const duree = Math.max(1, dureeMs);
  const [region, setRegion] = useState({ debut: 0, fin: Math.min(MEME_DUREE_MAX_MS, duree) });
  // Le curseur touché en dernier : c'est son image qu'on montre.
  const [vise, setVise] = useState<"debut" | "fin">("debut");
  const [image, setImage] = useState<string | null>(null);
  const imageRef = useRef<string | null>(null);
  const regionRef = useRef(region);
  const piste = useRef<HTMLDivElement>(null);
  const glisse = useRef<"debut" | "fin" | null>(null);
  const onChangeRef = useRef(onChange);
  const onFinEssaiRef = useRef(onFinEssai);
  const essaiRef = useRef(essai);
  useEffect(() => {
    onChangeRef.current = onChange;
    onFinEssaiRef.current = onFinEssai;
    essaiRef.current = essai;
  });

  const instant = vise === "debut" ? region.debut : Math.max(region.debut, region.fin - 40);

  // L'image de l'instant visé, une fois le curseur posé : un glissement
  // produit des dizaines de positions, on n'extrait que la dernière.
  useEffect(() => {
    let vivant = true;
    let url: string | null = null;
    const minuterie = window.setTimeout(() => {
      void imageMeme(source, instant)
        .then((chemin) => blobPrepare(chemin, "image/jpeg"))
        .then((b) => {
          if (!vivant) return;
          url = URL.createObjectURL(b);
          if (imageRef.current) URL.revokeObjectURL(imageRef.current);
          imageRef.current = url;
          setImage(url);
        })
        .catch(() => { /* instant sans image */ });
    }, 120);
    return () => {
      vivant = false;
      window.clearTimeout(minuterie);
    };
  }, [source, instant]);
  useEffect(() => () => { if (imageRef.current) URL.revokeObjectURL(imageRef.current); }, []);

  /** Place un curseur, en gardant l'extrait entre 0,5 et 10 s : l'autre
   *  curseur suit quand on dépasse. */
  const placer = (quel: "debut" | "fin", ms: number) => {
    const max = Math.min(MEME_DUREE_MAX_MS, duree);
    let { debut, fin } = regionRef.current;
    if (quel === "debut") {
      debut = Math.max(0, Math.min(ms, duree - DUREE_MIN_MS));
      if (fin - debut > max) fin = debut + max;
      if (fin - debut < DUREE_MIN_MS) fin = Math.min(duree, debut + DUREE_MIN_MS);
    } else {
      fin = Math.min(duree, Math.max(ms, DUREE_MIN_MS));
      if (fin - debut > max) debut = fin - max;
      if (fin - debut < DUREE_MIN_MS) debut = Math.max(0, fin - DUREE_MIN_MS);
    }
    const suivant = { debut: Math.round(debut), fin: Math.round(fin) };
    // Toucher un curseur pendant l'essai l'arrête : l'extrait joué ne serait
    // plus celui qu'on règle.
    if (essaiRef.current) onFinEssaiRef.current();
    regionRef.current = suivant;
    setRegion(suivant);
    setVise(quel);
    onChangeRef.current(suivant.debut, suivant.fin);
  };

  const msSous = (clientX: number): number => {
    const boite = piste.current?.getBoundingClientRect();
    if (!boite?.width) return 0;
    return Math.min(1, Math.max(0, (clientX - boite.left) / boite.width)) * duree;
  };

  const saisir = (e: React.PointerEvent, quel: "debut" | "fin") => {
    e.preventDefault();
    e.stopPropagation();
    glisse.current = quel;
    setVise(quel);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // Un clic sur la piste amène le curseur le plus proche.
  const cliquerPiste = (e: React.PointerEvent) => {
    const ms = msSous(e.clientX);
    const quel = Math.abs(ms - region.debut) <= Math.abs(ms - region.fin) ? "debut" : "fin";
    placer(quel, ms);
    glisse.current = quel;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const bouger = (e: React.PointerEvent) => {
    if (glisse.current) placer(glisse.current, msSous(e.clientX));
  };
  const lacher = () => { glisse.current = null; };

  const gauche = (region.debut / duree) * 100;
  const droite = (region.fin / duree) * 100;
  const curseur = (quel: "debut" | "fin", pct: number) => (
    <div
      onPointerDown={(e) => saisir(e, quel)}
      title={quel === "debut" ? t("memeboard.startFrame") : t("memeboard.endFrame")}
      style={{
        position: 'absolute', top: -6, bottom: -6, left: `${pct}%`, width: 14, marginLeft: -7,
        borderRadius: 7, cursor: 'ew-resize', touchAction: 'none',
        background: 'var(--color-primary)',
        boxShadow: vise === quel ? '0 0 0 3px var(--color-primary-container)' : 'none',
      }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        position: 'relative', height: HAUTEUR_ZONE, borderRadius: 10, overflow: 'hidden',
        background: 'var(--color-surface-container-lowest)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {essai ? (
          <Suspense fallback={null}>
            <NativeVideoPlayer key={essai} source={essai} onClose={onFinEssai} hauteurMax={HAUTEUR_ZONE} />
          </Suspense>
        ) : (
          image && <img src={image} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
        )}
      </div>

      <div
        ref={piste}
        onPointerDown={cliquerPiste}
        onPointerMove={bouger}
        onPointerUp={lacher}
        onPointerCancel={lacher}
        style={{
          position: 'relative', height: 10, margin: '6px 7px', borderRadius: 5, cursor: 'pointer',
          touchAction: 'none', background: 'var(--color-surface-container-highest)',
        }}
      >
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: `${gauche}%`, width: `${droite - gauche}%`,
          borderRadius: 5, background: 'var(--color-primary)', opacity: 0.45,
        }} />
        {curseur("debut", gauche)}
        {curseur("fin", droite)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
        <span>{t("memeboard.startFrame")} · {temps(region.debut)}</span>
        <span>{((region.fin - region.debut) / 1000).toFixed(1)} s</span>
        <span>{t("memeboard.endFrame")} · {temps(region.fin)}</span>
      </div>
    </div>
  );
}
