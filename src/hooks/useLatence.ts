import { useEffect, useState } from "react";

/** Latence jusqu'au serveur vocal (aller-retour mesuré par WebRTC), relue
 *  toutes les 2 s pendant un appel. Affichée par la 1.x, disparue avec
 *  l'ancien moteur vocal JS, revenue avec le moteur natif (01/10). */
export function useLatence(actif: boolean): number | null {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!actif) return;
    let vivant = true;
    const lire = () => {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<number | null>("voice_native_latence"))
        .then((v) => { if (vivant) setMs(v ?? null); })
        .catch(() => {});
    };
    lire();
    const minuteur = setInterval(lire, 2000);
    return () => { vivant = false; clearInterval(minuteur); };
  }, [actif]);
  return actif ? ms : null;
}
