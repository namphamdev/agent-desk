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
    name: "Terminal React",
    identifier: "com.github.namphamdev.terminal-react",
    version: "0.1.0",
    description:
      "Desktop terminal that renders coding-agent output as rich React UI via ACP",
  },
  build: {
    // Vite builds to dist/, Electrobun copies that into the bundle as the webview.
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
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
    },
    linux: { bundleCEF: false },
    win: {
      bundleCEF: false,
      // Optional: "assets/icon.ico" (16/32/48/256) for installer + taskbar.
    },
  },
  release: {
    // Set to your static host (S3/R2/GitHub Releases URL) for delta updates.
    // baseUrl: "https://example.com/terminal-react/",
    generatePatch: false,
  },
} satisfies ElectrobunConfig;
