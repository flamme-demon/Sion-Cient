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
      // Détection : le choix EXPLICITE de l'utilisateur (store Zustand
      // `sion-settings`, passé en `lng` ci-dessus) gagne. Sinon on suit la
      // langue du système. On ne met volontairement PAS en cache le résultat
      // détecté (`i18nextLng`) : un ancien cache « en » restait collé après
      // un changement de langue système, et le profil webview WRY est
      // distinct du profil CEF (nouvel origin en dev).
      order: ["navigator", "htmlTag"],
      caches: [],
    },
  });

export default i18n;
