import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "terminal-react",
    identifier: "terminal-react.local",
    version: "0.0.1",
  },
  build: {
    // Vite builds to dist/, Electrobun copies that into the bundle as the webview.
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
