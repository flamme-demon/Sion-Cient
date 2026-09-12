import { useEffect, useState, type CSSProperties } from "react";
import { useLayoutStore, type BackgroundScope } from "../stores/useLayoutStore";

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
      console.warn("[Sion][fond] lecture de l'image impossible:", err);
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, task);
  return task;
}

/** Choisit une image et l'associe au panneau. `false` si on annule. */
export async function pickPanelBackground(scope: BackgroundScope): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("pick_image_file");
  if (!path) return false;
  const current = useLayoutStore.getState().panelBackgrounds[scope];
  useLayoutStore.getState().setPanelBackground(scope, { path, opacity: current?.opacity ?? 0.55 });
  return true;
}

/**
 * Style de fond à étaler sur le conteneur du panneau (ou `undefined`).
 *
 * L'image est posée **dans la pile de fond** du conteneur, surmontée d'un
 * voile de la couleur de surface du thème (`color-mix`) : le contraste du
 * texte ne dépend jamais de l'image. Si le moteur ne connaît pas `color-mix`,
 * la déclaration est ignorée — pas d'image, pas de casse.
 */
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

export function usePanelBackgroundStyle(scope: BackgroundScope): CSSProperties | undefined {
  const cfg = useLayoutStore((s) => s.panelBackgrounds[scope]);
  const url = usePanelBackgroundUrl(scope);
  if (!cfg || !url) return undefined;
  // Mode « flou » : l'image vit dans une couche dédiée floutée
  // (`PanelBackgroundLayer`) — le conteneur ne porte rien.
  if (cfg.mode === "blur") return undefined;
  const veil = `color-mix(in srgb, var(--color-surface-container-low) ${Math.round((1 - cfg.opacity) * 100)}%, transparent)`;
  return {
    backgroundImage: `linear-gradient(${veil}, ${veil}), url(${url})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };
}
