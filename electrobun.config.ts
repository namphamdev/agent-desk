import type { ElectrobunConfig } from "electrobun";

/**
 * Electrobun builds for the host platform only.
 * - macOS → .app + DMG + update tarball (canary/stable)
 * - Windows → self-extracting Setup.exe + update tarball (canary/stable)
 * Use CI matrix (or local machines) to produce both.
 *
 * Signing: set build.mac.codesign/notarize true and provide
 * ELECTROBUN_APPLEID / ELECTROBUN_APPLEIDPASS / ELECTROBUN_TEAMID
 * (or App Store Connect API key env vars) when ready.
 */
export default {
  app: {
    name: "AgentDesk",
    identifier: "com.github.namphamdev.terminal-react",
    version: "0.1.0",
    description:
      "Desktop app that renders coding-agent output as rich React UI via ACP",
  },
  // Electrobun's packaged CLI fails to resolve rcedit (baked CI path), so
  // build.win.icon never embeds. postBuild/postPackage re-apply assets/icon.ico.
  scripts: {
    postBuild: "scripts/embed-win-icon.mjs",
    postPackage: "scripts/embed-win-icon.mjs",
  },
  build: {
    // Vite builds to dist/, Electrobun copies that into the bundle as the webview.
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      // Public brand assets (Vite copies these to dist/ root).
      "dist/favicon.ico": "views/mainview/favicon.ico",
      "dist/favicon.png": "views/mainview/favicon.png",
      "dist/logo.png": "views/mainview/logo.png",
      // In-app browser MCP stdio server (spawned by Claude Code per session).
      "src/bun/browser-mcp-stdio.ts": "bun/browser-mcp-stdio.ts",
    },
    watchIgnore: ["dist/**"],
    buildFolder: "build",
    artifactFolder: "artifacts",
    mac: {
      bundleCEF: false,
      // Unsigned local/CI builds until Apple credentials are configured.
      codesign: false,
      notarize: false,
      createDmg: true,
      // Default path is icon.iconset; kept explicit for clarity.
      icons: "icon.iconset",
    },
    linux: {
      bundleCEF: false,
      icon: "assets/app-icon.png",
    },
    win: {
      bundleCEF: false,
      icon: "assets/icon.ico",
    },
  },
  release: {
    // Set to your static host (S3/R2/GitHub Releases URL) for delta updates.
    // baseUrl: "https://example.com/terminal-react/",
    generatePatch: false,
  },
} satisfies ElectrobunConfig;
