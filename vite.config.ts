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
  // Resolve shared + session modules from project root (App imports ../session, ../shared).
  resolve: {
    alias: {
      // electrobun/view only exists in the desktop app; browser builds still typecheck.
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ["mermaid"],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Allow importing from src/session and src/shared outside root.
  optimizeDeps: {
    exclude: ["electrobun"],
  },
});
