import { defineConfig } from "vitest/config";

// Separate config so tests run across the whole project (the Vite config roots
// the build at src/mainview for the webview bundle).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
