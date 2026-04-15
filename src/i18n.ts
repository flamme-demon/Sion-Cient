import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import HttpBackend from "i18next-http-backend";

// Check if user has a saved language preference
const savedSettings = JSON.parse(localStorage.getItem("sion-settings") || "{}");
const savedLang = savedSettings?.state?.language;

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    lng: savedLang || undefined, // Use saved language, or let detector decide
    fallbackLng: "fr",
    supportedLngs: ["fr", "en"],
    // Strip the region code before matching: "fr-FR" / "fr-CA" → "fr".
    // navigator.language typically returns region-qualified codes on
    // Windows ("en-US", "fr-FR"), which wouldn't match our bare
    // "fr" / "en" supportedLngs without this.
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    backend: {
      loadPath: "/locales/{{lng}}/translation.json",
    },
    detection: {
      // Detection order: saved user preference → browser → fallback.
      // Persist what we detect into localStorage under our own key so we
      // don't fight the Zustand `sion-settings` store.
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "i18nextLng",
      caches: ["localStorage"],
    },
  });

export default i18n;
