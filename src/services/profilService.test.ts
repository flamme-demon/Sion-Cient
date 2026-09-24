import { beforeAll, describe, expect, it, vi } from "vitest";

// Les stores persistés touchent localStorage dès leur évaluation : stub avant
// l'import dynamique (même schéma que layoutFile.test.ts).
const stockage: Record<string, string> = {};
const appels: { cmd: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    appels.push({ cmd, args });
    if (cmd === "profil_extraire") {
      const { noms } = args as { noms: string[] };
      return Object.fromEntries(noms.map((n) => [n, `/donnees/profils/import-1/${n.slice("fichiers/".length)}`]));
    }
    return null;
  },
}));

let mod: typeof import("./profilService");
let layout: typeof import("../stores/useLayoutStore");
let reglages: typeof import("../stores/useSettingsStore");
let themes: typeof import("../stores/useThemeStore");
beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => stockage[k] ?? null,
      setItem: (k: string, v: string) => { stockage[k] = v; },
      removeItem: (k: string) => { delete stockage[k]; },
      clear: () => { for (const k of Object.keys(stockage)) delete stockage[k]; },
    },
  });
  layout = await import("../stores/useLayoutStore");
  reglages = await import("../stores/useSettingsStore");
  themes = await import("../stores/useThemeStore");
  mod = await import("./profilService");
});

const tous = { disposition: true, theme: true, fonds: true, sons: true };

describe("profils Sion", () => {
  it("compose un manifeste et la liste de ses fichiers", () => {
    layout.useLayoutStore.getState().setPanelBackground("chat", { path: "/images/plage.JPG", opacity: 0.4, anchor: "tc" });
    reglages.useSettingsStore.getState().setVoiceSound("join", { path: "/sons/coucou.ogg", start: 0.2, end: 1.5, gain: 1.2 });
    themes.useThemeStore.getState().setThemeId("sion-light");
    themes.useThemeStore.getState().setAccent("#7e57c2");

    const { manifeste, fichiers } = mod.composerProfil(tous);
    const m = JSON.parse(manifeste);
    expect(m.kind).toBe("sion-profile");
    expect(m.theme).toEqual({ id: "sion-light", accent: "#7e57c2" });
    expect(m.backgrounds.chat).toEqual({ file: "fichiers/fond-chat.jpg", opacity: 0.4, anchor: "tc" });
    expect(m.voiceSounds.join).toEqual({ file: "fichiers/son-join.ogg", start: 0.2, end: 1.5, gain: 1.2 });
    expect(fichiers).toEqual([
      { nom: "fichiers/fond-chat.jpg", source: "/images/plage.JPG" },
      { nom: "fichiers/son-join.ogg", source: "/sons/coucou.ogg" },
    ]);

    // Sections décochées : ni clé dans le manifeste, ni fichier.
    const leger = mod.composerProfil({ ...tous, fonds: false, sons: false });
    expect(JSON.parse(leger.manifeste).backgrounds).toBeUndefined();
    expect(leger.fichiers).toEqual([]);
  });

  it("relit ce qu'il compose", () => {
    const { manifeste, fichiers } = mod.composerProfil(tous);
    const r = mod.analyserManifeste("/p.sionprofil", manifeste, new Set(fichiers.map((f) => f.nom)));
    if (!("profil" in r)) throw new Error("rejeté");
    expect(mod.sectionsPresentes(r.profil)).toEqual(tous);
    expect(r.profil.theme).toMatchObject({ custom: false, accent: "#7e57c2" });
    expect(r.profil.theme!.theme.id).toBe("sion-light");
  });

  it("refuse ce qui n'est pas un profil, et écarte ce qui ne tient pas", () => {
    expect(mod.analyserManifeste("x", "pas du json", new Set())).toEqual({ error: "notAProfile" });
    expect(mod.analyserManifeste("x", JSON.stringify({ kind: "sion-layout", format: 1 }), new Set())).toEqual({ error: "notAProfile" });
    expect(mod.analyserManifeste("x", JSON.stringify({ kind: "sion-profile", format: 9 }), new Set())).toEqual({ error: "tooRecent" });

    const r = mod.analyserManifeste("x", JSON.stringify({
      kind: "sion-profile",
      format: 1,
      theme: { id: "thème-inconnu", accent: "rouge" },
      backgrounds: {
        chat: { file: "fichiers/absent.png", opacity: 0.5 },
        memeboard: { file: "fichiers/fond.png", opacity: 7, mode: "néon", anchor: "zz" },
        nulle_part: { file: "fichiers/fond.png", opacity: 0.5 },
      },
      voiceSounds: {
        join: { file: "fichiers/son.ogg", start: 2, end: 1, gain: 1 },
        leave: { file: "fichiers/son.ogg", start: 0, end: 1, gain: 99 },
        chanter: { file: "fichiers/son.ogg", start: 0, end: 1, gain: 1 },
      },
    }), new Set(["fichiers/fond.png", "fichiers/son.ogg"]));
    if (!("profil" in r)) throw new Error("rejeté");
    // Thème livré inconnu : pas de section thème.
    expect(r.profil.theme).toBeUndefined();
    // Fichier absent, portée inconnue : écartés ; valeurs ramenées dans leurs bornes.
    expect(r.profil.fonds).toEqual({ memeboard: { file: "fichiers/fond.png", opacity: 1 } });
    // Fin avant le début, événement inconnu : écartés ; gain borné.
    expect(r.profil.sons).toEqual({ leave: { file: "fichiers/son.ogg", start: 0, end: 1, gain: 4 } });
  });

  it("applique les sections choisies, fonds et sons remplaçant les siens", async () => {
    layout.useLayoutStore.getState().setPanelBackground("channels", { path: "/images/ancien.png", opacity: 0.3 });
    const { manifeste, fichiers } = mod.composerProfil(tous);
    // Le profil vient d'ailleurs : le fond « channels » n'y est pas.
    const m = JSON.parse(manifeste);
    delete m.backgrounds.channels;
    const r = mod.analyserManifeste("/p.sionprofil", JSON.stringify(m), new Set(fichiers.map((f) => f.nom)));
    if (!("profil" in r)) throw new Error("rejeté");

    themes.useThemeStore.getState().setThemeId("sion-dark");
    themes.useThemeStore.getState().setAccent(null);
    appels.length = 0;
    await mod.appliquerProfil(r.profil, { ...tous, disposition: false });

    const extraction = appels.find((a) => a.cmd === "profil_extraire");
    expect((extraction!.args as { noms: string[] }).noms.sort()).toEqual(["fichiers/fond-chat.jpg", "fichiers/son-join.ogg"]);
    expect(themes.useThemeStore.getState()).toMatchObject({ themeId: "sion-light", accent: "#7e57c2" });
    const fonds = layout.useLayoutStore.getState().panelBackgrounds;
    expect(fonds.chat?.path).toBe("/donnees/profils/import-1/fond-chat.jpg");
    expect(fonds.channels).toBeUndefined();
    expect(reglages.useSettingsStore.getState().voiceSounds.join?.path).toBe("/donnees/profils/import-1/son-join.ogg");
    // Le ménage garde ce que les réglages citent désormais.
    const menage = appels.find((a) => a.cmd === "profil_nettoyer");
    expect((menage!.args as { conserves: string[] }).conserves).toContain("/donnees/profils/import-1/fond-chat.jpg");
  });
});
