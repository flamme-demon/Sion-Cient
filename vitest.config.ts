import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // jsdom partout : certains modules importés (stores zustand) touchent
    // localStorage/navigator dès l'import.
    environment: "jsdom",
    server: {
      deps: {
        // La 0.4.0 importe un de ses fichiers sans l'extension `.js`
        // (`color_spec_2025.js`) : Vite le résout, pas le chargeur ESM de
        // Node. Transformée par Vite, comme dans l'application.
        inline: ["@material/material-color-utilities"],
      },
    },
  },
});
