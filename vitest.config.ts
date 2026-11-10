import { defineConfig } from "vitest/config";

// Tests live in both web/ and sidecar/, so use the project root, not the Vite root.
export default defineConfig({
  test: {
    root: ".",
    include: ["web/**/*.test.ts", "sidecar/**/*.test.ts"],
  },
});
