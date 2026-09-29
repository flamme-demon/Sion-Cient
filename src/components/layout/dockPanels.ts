/**
 * Panneaux de la dock : composants (chargés à la demande) et titres. Partagés
 * par la dock du bureau et la feuille du téléphone (`MobilePanelSheet`).
 */
import { lazy, type ComponentType } from "react";
import { useLayoutStore, DOCK_ZONE_IDS, type DockPanelId } from "../../stores/useLayoutStore";
import { VoiceStatusPanel } from "../chat/VoiceStatusPanel";

// Blocs lourds chargés à la demande (perf mémoire, 2026-09-12) : le soundboard
// embarquait dans le chunk de démarrage tout son sous-graphe (panneau vocal,
// modal d'upload, trimballeur, hotkeys) alors qu'il n'est peint que si le
// bloc est docké ET le salon soundboard présent. Idem membres et
// transcription. Le chunk de boot ne garde que la coquille de la dock.
const MemberPanel = lazy(() =>
  import("../chat/MemberPanel").then((m) => ({ default: m.MemberPanel })),
);
const SoundboardPanel = lazy(() =>
  import("../chat/SoundboardPanel").then((m) => ({ default: m.SoundboardPanel })),
);
const MemeboardPanel = lazy(() =>
  import("../chat/MemeboardPanel").then((m) => ({ default: m.MemeboardPanel })),
);
const PinnedPanel = lazy(() =>
  import("../chat/PinnedListPanel").then((m) => ({ default: m.PinnedListPanel })),
);
const TranscriptPanel = lazy(() =>
  import("../chat/TranscriptPanel").then((m) => ({ default: m.TranscriptPanel })),
);

export const PANEL_TITLE_KEYS: Record<DockPanelId, string> = {
  members: "members.title",
  soundboard: "soundboard.title",
  memeboard: "memeboard.title",
  transcript: "transcript.title",
  voice: "layout.voicePanelTitle",
  pinned: "chat.pinnedList",
};

export const PANEL_BODIES: Record<DockPanelId, ComponentType> = {
  members: MemberPanel,
  soundboard: SoundboardPanel,
  memeboard: MemeboardPanel,
  transcript: TranscriptPanel,
  voice: VoiceStatusPanel,
  pinned: PinnedPanel,
};

/** Le bloc vocal a sa propre barre sur téléphone (MobileVoiceBar). */
const HORS_FEUILLE: ReadonlySet<DockPanelId> = new Set(["voice"]);

/** Panneaux ouverts (dock ou cartes flottantes), hors bloc vocal. */
export function panneauxOuverts(): DockPanelId[] {
  const { dockZones, floatingPanels } = useLayoutStore.getState();
  const docks = DOCK_ZONE_IDS.flatMap((id) => dockZones[id].panels);
  const flottants = Object.keys(floatingPanels) as DockPanelId[];
  return [...docks, ...flottants].filter((p) => !HORS_FEUILLE.has(p));
}

/** Retour d'Android : ferme la feuille ouverte, s'il y en a une. */
export function fermerFeuilleMobile(): boolean {
  const ouverts = panneauxOuverts();
  const dernier = ouverts[ouverts.length - 1];
  if (!dernier) return false;
  useLayoutStore.getState().closeDockPanel(dernier);
  return true;
}
