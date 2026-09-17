import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "highlight.js/styles/github-dark.css";
import "./index.css";
import { openExternalUrl } from "./utils/openExternal";
import { hydrateSessionFromAppData, startSettingsMirror } from "./services/sessionPersist";
import { attachConsole } from "@tauri-apps/plugin-log";
import { installMemoryDiagnostics } from "./services/memoryDiagnostics";

// Route Rust `log::*` records into the webview console — the only way to see
// them on the shipped Windows build (no terminal). Pairs with the Rust
// logger's Webview target. No-op outside Tauri.
attachConsole().catch(() => {});

// DIAGNOSTIC DEV : compteurs mémoire (messages retenus, blobs vivants) dans la
// console/le log — pour expliquer la courbe RSS du processus WebKit.
installMemoryDiagnostics();

// Intercept all clicks on external links to open in default browser (Tauri)
document.addEventListener("click", (e) => {
  // If a more specific handler has already cancelled the default action
  // (e.g. mention pills opening the user context menu), don't try to open
  // the link externally.
  if (e.defaultPrevented) return;

  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;

  // Mention pills (matrix.to/#/@user:server) are handled in-app — never open
  // them externally even if no other handler called preventDefault.
  if (
    href.startsWith("https://matrix.to/#/@") ||
    href.startsWith("https://matrix.to/#/%40")
  ) {
    e.preventDefault();
    return;
  }

  // Only intercept external URLs (http/https), not internal anchors
  if (href.startsWith("http://") || href.startsWith("https://")) {
    e.preventDefault();
    openExternalUrl(href);
  }
});

// Block webview default keyboard shortcuts that open dialogs we don't
// want (Ctrl+S "Save page", Ctrl+P "Print", Ctrl+O "Open file", Ctrl+U "View
// source"). Keep Ctrl+R (reload) and Ctrl+F (find) alive — users genuinely
// expect those to work, and the real cause of spurious reloads was Vite
// watching .log files, not Ctrl+R.
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s" || k === "p" || k === "o" || k === "u") {
    e.preventDefault();
    e.stopPropagation();
  }
}, { capture: true });

// IMPORTANT: App, i18n et themeService sont importés dynamiquement seulement
// APRÈS l'hydratation. Un import ES statique est évalué avant ce code : App
// charge alors les stores Zustand sur un localStorage encore vide et garde les
// valeurs par défaut en mémoire, même si hydrateSessionFromAppData remplit le
// stockage quelques millisecondes plus tard. La première modification finit
// ensuite par écraser la sauvegarde globale (notamment voiceSounds).
async function bootstrap() {
  await hydrateSessionFromAppData();

  // i18n lit directement sion-settings à l'évaluation du module.
  await import("./i18n");
  const [{ default: App }, { installThemeSync }, { useSettingsStore }] = await Promise.all([
    import("./App"),
    import("./services/themeService"),
    import("./stores/useSettingsStore"),
  ]);

  // Thème : appliqué avant le premier rendu React (aucun flash du thème par
  // défaut), mais après restauration de son store persistant.
  installThemeSync();

  // Langue : tant que l'utilisateur n'a pas choisi explicitement (store
  // `language` vide = « Système »), on lit la locale OS côté Rust. Sous
  // WRY/WebKitGTK, `navigator.language` peut annoncer en-US sur un système
  // français ; la locale OS fait donc foi pour la détection automatique.
  if (!useSettingsStore.getState().language) {
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<string>("system_locale").then((loc) => {
        const lng = loc.slice(0, 2).toLowerCase();
        if (lng === "fr" || lng === "en") {
          import("i18next").then((i) => i.default.changeLanguage(lng)).catch(() => {});
        }
      }).catch(() => {}),
    ).catch(() => {});
  }
  // Keep the settings snapshot in app-data fresh as the user changes them.
  startSettingsMirror();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
