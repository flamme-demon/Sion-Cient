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
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    backend: {
      loadPath: "/locales/{{lng}}/translation.json",
    },
  });

export default i18n;
