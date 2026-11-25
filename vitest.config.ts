import { defineConfig } from "vitest/config";

// Tests live in web/, sidecar/ and scripts/, so use the project root, not the Vite root.
export default defineConfig({
  test: {
    root: ".",
    include: ["web/**/*.test.ts", "sidecar/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
