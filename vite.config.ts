import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || "0.0.0"),
  },
  plugins: [react(), tailwindcss(), wasm()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: {
      // Do NOT include arbitrary user files (logs, notes, build artifacts)
      // in the watcher — any change on a non-module file Vite doesn't know
      // how to HMR will trigger a full page reload. In particular, saving
      // `*.log` files inside the project dir (e.g. from Kate while copying
      // debug output) was causing Sion to reload every Ctrl+S.
      ignored: [
        "**/src-tauri/**",
        "**/*.log",
        "**/logs/**",
        "**/dist/**",
        "**/.git/**",
        "**/build-scripts/**",
        "**/*.txt",
        "**/*.md",
      ],
    },
    headers: process.env.TAURI_ENV_PLATFORM === "android"
      ? {}
      : {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
  },
  envPrefix: ["VITE_", "TAURI_"],
  optimizeDeps: {
    exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
