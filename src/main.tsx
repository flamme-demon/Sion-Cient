import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "highlight.js/styles/github-dark.css";
import "./index.css";
import App from "./App";
import { openExternalUrl } from "./utils/openExternal";

// Intercept all clicks on external links to open in default browser (Tauri/CEF)
document.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  // Only intercept external URLs (http/https), not internal anchors
  if (href.startsWith("http://") || href.startsWith("https://")) {
    e.preventDefault();
    openExternalUrl(href);
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
