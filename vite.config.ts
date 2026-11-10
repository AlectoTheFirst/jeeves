import { defineConfig } from "vite";

// Tauri expects a fixed port and must not clear its own console output.
export default defineConfig({
  root: "web",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/sidecar/**"] },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "safari16",
  },
});
