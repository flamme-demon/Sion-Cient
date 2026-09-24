/**
 * Profils Sion (`.sionprofil`) : exporter et importer, en une fois, la
 * disposition, le thème (et sa couleur d'accent), les fonds de panneaux et
 * les sons d'événements.
 *
 * L'archive est écrite et lue par Rust (`profil.rs`) ; ici, on compose le
 * manifeste et on le valide section par section. Rien d'un fichier reçu
 * n'atteint un store sans être passé par le même contrôle que l'import
 * isolé correspondant : `parseLayoutFile`, `parseThemeFile`, bornes des
 * fonds et des sons.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  DOCK_PANEL_DEFAULT_ZONE,
  useLayoutStore,
  type BackgroundScope,
  type BgAnchor,
  type PanelBackgroundCfg,
} from "../stores/useLayoutStore";
import { useSettingsStore, type VoiceCue, type VoiceSoundCfg } from "../stores/useSettingsStore";
import { useThemeStore } from "../stores/useThemeStore";
import { BUILTIN_THEMES } from "../themes/builtin";
import { normaliserAccent } from "../themes/accent";
import type { Theme } from "../themes/types";
import { applyLayout, layoutToJson, parseLayoutFile, type Disposition } from "./layoutFile";
import { parseThemeFile, themeToJson } from "./themeService";

const FORMAT = 1;
const GENRE = "sion-profile";

export type SectionProfil = "disposition" | "theme" | "fonds" | "sons";
export type SectionsProfil = Record<SectionProfil, boolean>;

/** Cochées par défaut à l'export : les sons restent décochés, ils peuvent
 *  peser lourd et sont plus personnels. */
export const SECTIONS_PAR_DEFAUT: SectionsProfil = { disposition: true, theme: true, fonds: true, sons: false };

// Listes complètes, vérifiées par le compilateur : un `Record` exige chaque clé.
const CUES: Record<VoiceCue, true> = {
  join: true, leave: true, timeout: true, poke: true, kick: true, memberKicked: true,
  mute: true, unmute: true, deafen: true, undeafen: true,
};
const ANCRAGES: Record<BgAnchor, true> = {
  tl: true, tc: true, tr: true, ml: true, mc: true, mr: true, bl: true, bc: true, br: true,
};
const PORTEES: BackgroundScope[] = ["chat", "channels", ...(Object.keys(DOCK_PANEL_DEFAULT_ZONE) as BackgroundScope[])];

/** Ce que la machine peut exporter, pour les cases de la fenêtre. */
export function contenuExportable() {
  const fonds = Object.values(useLayoutStore.getState().panelBackgrounds).filter(Boolean).length;
  const sons = Object.values(useSettingsStore.getState().voiceSounds).filter(Boolean).length;
  const { themeId, accent } = useThemeStore.getState();
  return { fonds, sons, themeId, accent };
}

/** Extension d'un chemin, en minuscules, ou `null`. */
function extension(chemin: string): string | null {
  const m = /\.([a-z0-9]{1,5})$/i.exec(chemin);
  return m ? m[1].toLowerCase() : null;
}

interface FichierAEcrire {
  nom: string;
  source: string;
}

/**
 * Compose le manifeste et la liste des fichiers d'un export. Pure, pour être
 * testée : lit les stores, n'écrit rien.
 */
export function composerProfil(sections: SectionsProfil): { manifeste: string; fichiers: FichierAEcrire[] } {
  const fichiers: FichierAEcrire[] = [];
  const profil: Record<string, unknown> = {
    format: FORMAT,
    kind: GENRE,
    app: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
    createdAt: new Date().toISOString(),
  };
  if (sections.disposition) profil.layout = JSON.parse(layoutToJson());
  if (sections.theme) {
    const { themeId, customThemes, accent } = useThemeStore.getState();
    const perso = customThemes.find((t) => t.id === themeId);
    profil.theme = {
      id: themeId,
      // Un thème importé voyage avec sa définition ; un thème livré, par son
      // nom seulement.
      ...(perso ? { custom: JSON.parse(themeToJson(perso)) } : {}),
      accent,
    };
  }
  if (sections.fonds) {
    const fonds: Record<string, unknown> = {};
    for (const [portee, cfg] of Object.entries(useLayoutStore.getState().panelBackgrounds)) {
      const ext = cfg ? extension(cfg.path) : null;
      if (!cfg || !ext) continue;
      const nom = `fichiers/fond-${portee}.${ext}`;
      fichiers.push({ nom, source: cfg.path });
      fonds[portee] = { file: nom, opacity: cfg.opacity, mode: cfg.mode, anchor: cfg.anchor };
    }
    profil.backgrounds = fonds;
  }
  if (sections.sons) {
    const sons: Record<string, unknown> = {};
    for (const [cue, cfg] of Object.entries(useSettingsStore.getState().voiceSounds)) {
      const ext = cfg ? extension(cfg.path) : null;
      if (!cfg || !ext) continue;
      const nom = `fichiers/son-${cue}.${ext}`;
      fichiers.push({ nom, source: cfg.path });
      sons[cue] = { file: nom, start: cfg.start, end: cfg.end, gain: cfg.gain };
    }
    profil.voiceSounds = sons;
  }
  return { manifeste: JSON.stringify(profil, null, 2), fichiers };
}

/** Choisit où enregistrer, puis écrit — là, et nulle part ailleurs : Rust
 *  n'écrit qu'à l'endroit choisi dans sa boîte de dialogue. `null` si
 *  l'utilisateur renonce ; sinon le chemin, la taille, et les fichiers
 *  laissés de côté (format inconnu, trop gros, disparu). */
export async function exporterProfil(
  sections: SectionsProfil,
): Promise<{ chemin: string; taille: number; ignores: string[] } | null> {
  const chemin = await invoke<string | null>("profil_choisir_destination");
  if (!chemin) return null;
  const { manifeste, fichiers } = composerProfil(sections);
  const ecrit = await invoke<{ taille: number; ignores: string[] }>("profil_ecrire", { manifeste, fichiers });
  return { chemin, ...ecrit };
}

// ---------------------------------------------------------------- import --

interface ThemeLu {
  /** Thème livré, ou thème importé à ajouter. */
  theme: Theme;
  custom: boolean;
  accent: string | null;
}

interface FondLu extends Omit<PanelBackgroundCfg, "path"> {
  file: string;
}

interface SonLu extends Omit<VoiceSoundCfg, "path"> {
  file: string;
}

export interface ProfilLu {
  chemin: string;
  app: string | null;
  createdAt: string | null;
  disposition?: Disposition;
  theme?: ThemeLu;
  fonds?: Partial<Record<BackgroundScope, FondLu>>;
  sons?: Partial<Record<VoiceCue, SonLu>>;
}

export type ErreurProfil = "notAProfile" | "tooRecent";

const nombre = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;

/** Valide un manifeste contre la liste des fichiers réellement présents.
 *  Une section invalide est écartée, pas le profil entier. */
export function analyserManifeste(
  chemin: string,
  texte: string,
  presents: Set<string>,
): { profil: ProfilLu } | { error: ErreurProfil } {
  let brut: Record<string, unknown>;
  try {
    brut = JSON.parse(texte);
  } catch {
    return { error: "notAProfile" };
  }
  if (!brut || typeof brut !== "object" || brut.kind !== GENRE) return { error: "notAProfile" };
  if (typeof brut.format !== "number" || brut.format > FORMAT) return { error: "tooRecent" };

  const profil: ProfilLu = {
    chemin,
    app: typeof brut.app === "string" ? brut.app.slice(0, 40) : null,
    createdAt: typeof brut.createdAt === "string" ? brut.createdAt.slice(0, 40) : null,
  };

  if (brut.layout && typeof brut.layout === "object") {
    const lu = parseLayoutFile(JSON.stringify(brut.layout));
    if ("disposition" in lu) profil.disposition = lu.disposition;
  }

  const t = brut.theme as { id?: unknown; custom?: unknown; accent?: unknown } | undefined;
  if (t && typeof t === "object") {
    const accent = normaliserAccent(t.accent);
    if (t.custom && typeof t.custom === "object") {
      const lu = parseThemeFile(JSON.stringify(t.custom));
      if ("theme" in lu) profil.theme = { theme: lu.theme, custom: true, accent };
    } else {
      const livre = BUILTIN_THEMES.find((b) => b.id === t.id);
      if (livre) profil.theme = { theme: livre, custom: false, accent };
    }
  }

  if (brut.backgrounds && typeof brut.backgrounds === "object") {
    const fonds: Partial<Record<BackgroundScope, FondLu>> = {};
    for (const [portee, v] of Object.entries(brut.backgrounds as Record<string, unknown>)) {
      const f = v as Partial<FondLu> | null;
      if (!PORTEES.includes(portee as BackgroundScope) || !f || typeof f.file !== "string" || !presents.has(f.file)) continue;
      fonds[portee as BackgroundScope] = {
        file: f.file,
        opacity: nombre(f.opacity, 0, 1) ?? 0.55,
        ...(f.mode === "veil" || f.mode === "blur" ? { mode: f.mode } : {}),
        ...(typeof f.anchor === "string" && Object.hasOwn(ANCRAGES, f.anchor) ? { anchor: f.anchor as BgAnchor } : {}),
      };
    }
    profil.fonds = fonds;
  }

  if (brut.voiceSounds && typeof brut.voiceSounds === "object") {
    const sons: Partial<Record<VoiceCue, SonLu>> = {};
    for (const [cue, v] of Object.entries(brut.voiceSounds as Record<string, unknown>)) {
      const s = v as Partial<SonLu> | null;
      // `hasOwn`, pas `in` : `toString` ou `__proto__` passeraient pour des
      // événements, hérités de `Object.prototype`.
      if (!Object.hasOwn(CUES, cue) || !s || typeof s.file !== "string" || !presents.has(s.file)) continue;
      const debut = nombre(s.start, 0, 3600);
      const fin = nombre(s.end, 0, 3600);
      const gain = nombre(s.gain, 0, 4);
      if (debut === null || fin === null || gain === null || fin <= debut) continue;
      sons[cue as VoiceCue] = { file: s.file, start: debut, end: fin, gain };
    }
    profil.sons = sons;
  }
  return { profil };
}

/** Choisit un profil et le lit, sans rien appliquer. `null` si
 *  l'utilisateur renonce. */
export async function lireProfil(): Promise<{ profil: ProfilLu } | { error: ErreurProfil | string } | null> {
  try {
    const chemin = await invoke<string | null>("profil_choisir_source");
    if (!chemin) return null;
    const lu = await invoke<{ manifeste: string; fichiers: { nom: string; taille: number }[] }>("profil_lire", { chemin });
    return analyserManifeste(chemin, lu.manifeste, new Set(lu.fichiers.map((f) => f.nom)));
  } catch (err) {
    return { error: String(err) };
  }
}

/** Sections présentes dans un profil lu. */
export function sectionsPresentes(p: ProfilLu): SectionsProfil {
  return {
    disposition: !!p.disposition,
    theme: !!p.theme,
    fonds: !!p.fonds && Object.keys(p.fonds).length > 0,
    sons: !!p.sons && Object.keys(p.sons).length > 0,
  };
}

/**
 * Applique les sections choisies. Les fonds et les sons d'un profil
 * REMPLACENT les siens : un fond ou un son que le profil ne porte pas est
 * retiré, comme chez celui qui l'a exporté.
 */
export async function appliquerProfil(p: ProfilLu, sections: SectionsProfil): Promise<void> {
  const aExtraire = [
    ...(sections.fonds ? Object.values(p.fonds ?? {}).map((f) => f!.file) : []),
    ...(sections.sons ? Object.values(p.sons ?? {}).map((s) => s!.file) : []),
  ];
  const poses = aExtraire.length > 0
    ? await invoke<Record<string, string>>("profil_extraire", { chemin: p.chemin, noms: aExtraire })
    : {};

  if (sections.disposition && p.disposition) applyLayout(p.disposition);

  if (sections.theme && p.theme) {
    const store = useThemeStore.getState();
    if (p.theme.custom) store.upsertCustomTheme(p.theme.theme);
    else store.setThemeId(p.theme.theme.id);
    store.setAccent(p.theme.accent);
  }

  if (sections.fonds && p.fonds) {
    const layout = useLayoutStore.getState();
    for (const portee of PORTEES) {
      const f = p.fonds[portee];
      const chemin = f ? poses[f.file] : undefined;
      if (f && chemin) {
        layout.setPanelBackground(portee, { path: chemin, opacity: f.opacity, mode: f.mode, anchor: f.anchor });
      } else if (layout.panelBackgrounds[portee]) {
        layout.setPanelBackground(portee, null);
      }
    }
  }

  if (sections.sons && p.sons) {
    const reglages = useSettingsStore.getState();
    for (const cue of Object.keys(CUES) as VoiceCue[]) {
      const s = p.sons[cue];
      const chemin = s ? poses[s.file] : undefined;
      reglages.setVoiceSound(cue, s && chemin ? { path: chemin, start: s.start, end: s.end, gain: s.gain } : null);
    }
  }

  // Les fichiers des imports précédents que plus rien ne cite s'en vont.
  const cites = [
    ...Object.values(useLayoutStore.getState().panelBackgrounds).map((c) => c?.path),
    ...Object.values(useSettingsStore.getState().voiceSounds).map((c) => c?.path),
  ].filter((c): c is string => !!c);
  await invoke("profil_nettoyer", { conserves: cites }).catch(() => { /* ménage : sans conséquence */ });
}
