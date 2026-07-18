import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // jsdom partout : certains modules importés (stores zustand) touchent
    // localStorage/navigator dès l'import.
    environment: "jsdom",
  },
});
