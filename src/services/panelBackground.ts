import { useEffect, useState, type CSSProperties } from "react";
import { useLayoutStore, type BackgroundScope, type BgAnchor } from "../stores/useLayoutStore";

/**
 * Fonds d'image des panneaux (menu, chat, blocs de la dock) — logique, sans
 * composant : cache de blob URLs, lecture des octets côté Rust, hook de style.
 * Le rendu vit dans `components/layout/PanelBackground.tsx`.
 *
 * Le chemin est persisté (léger) ; les octets sont lus à la demande
 * (`read_dropped_file`, IPC binaire) et mis en cache par chemin : une image =
 * une lecture par session, partagée par tous les panneaux qui l'utilisent.
 */
const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

async function resolveBackgroundUrl(path: string): Promise<string | null> {
  const cached = urlCache.get(path);
  if (cached) return cached;
  const running = inflight.get(path);
  if (running) return running;
  const task = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = await invoke<Uint8Array>("read_dropped_file", { path });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      urlCache.set(path, url);
      return url;
    } catch (err) {
      // Journalisé côté Rust, pas seulement dans la console du navigateur :
      // un fond configuré dont le fichier a disparu ne s'affichait plus sans
      // la moindre trace lisible (18/09, fichier écrit sous `/tmp` et effacé
      // au redémarrage). Le chemin manquant est la seule information utile.
      console.warn("[Sion][fond] lecture impossible:", err);
      void import("@tauri-apps/plugin-log")
        .then(({ warn }) => warn(`[Sion][fond] fichier illisible ou absent : ${path}`))
        .catch(() => { /* hors Tauri */ });
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, task);
  return task;
}

/**
 * Efface les fonds transcodés que plus aucune configuration n'utilise.
 *
 * Chaque essai en laissait un derrière lui — 39 Mo pour quatre fichiers dont
 * un seul servait (18/09). Appelée au démarrage, une fois la configuration
 * restaurée : c'est le seul moment où l'on connaît avec certitude l'ensemble
 * des fonds encore référencés.
 */
export async function purgerFondsInutilises(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const cfgs = useLayoutStore.getState().panelBackgrounds;
    const keep = Object.values(cfgs)
      .map((c) => c?.path)
      .filter((p): p is string => !!p);
    await invoke("purge_background_files", { keep });
  } catch {
    /* hors Tauri, ou dossier inaccessible : sans conséquence */
  }
}

export async function pickPanelBackground(scope: BackgroundScope): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("pick_image_file");
  if (!path) return false;

  // Vidéo : transcodée avant d'être retenue. Le fichier d'origine tourne en
  // continu derrière l'interface, et les exemples fournis pesaient jusqu'à
  // 192 Mo en 4K (18/09) — impensable en fond. `prepare_background_video`
  // en tire une boucle 720p sans audio, de quelques mégaoctets.
  const estVideo = /\.(mp4|webm|mkv|mov)$/i.test(path);
  if (estVideo) {
    try {
      const prepare = await invoke<string>("prepare_background_video", { path });
      const courant = useLayoutStore.getState().panelBackgrounds[scope];
      // Pas de drapeau `video` : la préparation rend un WebP ANIMÉ, donc une
      // image. Elle emprunte le chemin CSS des fonds statiques, déjà éprouvé.
      useLayoutStore.getState().setPanelBackground(scope, {
        path: prepare,
        opacity: courant?.opacity ?? 0.55,
      });
      return true;
    } catch (err) {
      console.error("[Sion] Transcodage du fond vidéo impossible:", err);
      return false;
    }
  }
  const current = useLayoutStore.getState().panelBackgrounds[scope];
  useLayoutStore.getState().setPanelBackground(scope, { path, opacity: current?.opacity ?? 0.55 });
  return true;
}

export function usePanelBackgroundUrl(scope: BackgroundScope): string | null {
  const cfg = useLayoutStore((s) => s.panelBackgrounds[scope]);
  const path = cfg?.path ?? null;
  // Le cache est lu au rendu (Map module, pas d'état React) ; la résolution
  // pose le résultat en état UNIQUEMENT de façon asynchrone — un setState
  // synchrone dans l'effet déclencherait un rendu en cascade.
  const [resolved, setResolved] = useState<{ path: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    void resolveBackgroundUrl(path).then((url) => {
      if (alive) setResolved({ path, url });
    });
    return () => { alive = false; };
  }, [path]);

  if (!path) return null;
  return urlCache.get(path) ?? (resolved?.path === path ? resolved.url : null);
}

/** Ancrage → valeur CSS `background-position` (défaut : centre). C'est ce qui
 *  décide de la zone conservée quand `cover` recadre l'image (une photo
 *  portrait dans un panneau large : `tc` garde la tête). */
const ANCHOR_CSS: Record<BgAnchor, string> = {
  tl: "left top", tc: "center top", tr: "right top",
  ml: "left center", mc: "center center", mr: "right center",
  bl: "left bottom", bc: "center bottom", br: "right bottom",
};

export function bgAnchorCss(anchor?: BgAnchor): string {
  return ANCHOR_CSS[anchor ?? "mc"] ?? "center center";
}

/**
 * Style de fond à étaler sur le conteneur du panneau (ou `undefined`).
 *
 * L'image est posée **dans la pile de fond** du conteneur, surmontée d'un
 * voile de la couleur de surface du thème (`color-mix`) : le contraste du
 * texte ne dépend jamais de l'image. Si le moteur ne connaît pas `color-mix`,
 * la déclaration est ignorée — pas d'image, pas de casse.
 */
export function usePanelBackgroundStyle(scope: BackgroundScope): CSSProperties | undefined {
  const cfg = useLayoutStore((s) => s.panelBackgrounds[scope]);
  const url = usePanelBackgroundUrl(scope);
  if (!cfg || !url) return undefined;
  // Fond vidéo : rendu par `PanelBackgroundLayer`, pas par une règle CSS. Le
  // conteneur doit devenir TRANSPARENT, sinon son fond opaque masquerait la
  // couche vidéo, qui est placée derrière lui (`z-index: -1`).

  // Mode « flou » : l'image vit dans une couche dédiée floutée
  // (`PanelBackgroundLayer`) — le conteneur ne porte rien.
  if (cfg.mode === "blur") return undefined;
  const veil = `color-mix(in srgb, var(--color-surface-container-low) ${Math.round((1 - cfg.opacity) * 100)}%, transparent)`;
  return {
    backgroundImage: `linear-gradient(${veil}, ${veil}), url(${url})`,
    backgroundSize: 'cover',
    backgroundPosition: bgAnchorCss(cfg.anchor),
    backgroundRepeat: 'no-repeat',
  };
}
