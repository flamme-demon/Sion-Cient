import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "highlight.js/styles/github-dark.css";
import "./index.css";
import App from "./App";
import { openExternalUrl } from "./utils/openExternal";
import { installCefAudioShim } from "./services/cefAudioShim";
import { installDenoiseShim } from "./services/denoiseShim";

// Override enumerateDevices/getUserMedia in CEF so WebRTC sees real devices.
// Denoise shim wraps getUserMedia *after* cefAudioShim so both chains compose.
installCefAudioShim().catch(() => {}).finally(() => {
  installDenoiseShim();
});

// Intercept all clicks on external links to open in default browser (Tauri/CEF)
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

// Block browser/CEF default keyboard shortcuts that open dialogs we don't
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
