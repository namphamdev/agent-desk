import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite builds the webview (React app) into dist/. Electrobun copies dist/
// into the bundle as the webview at views://mainview/index.html.
// In HMR mode (bun run dev:hmr) the webview loads http://localhost:5173 instead.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/mainview",
  base: "./",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
