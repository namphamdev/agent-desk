import { BrowserWindow, Updater } from "electrobun/bun";

// During development, if the Vite dev server is up we load from it (HMR);
// otherwise we load the bundled webview built into views://.
const DEV_SERVER_URL = "http://localhost:5173";

async function resolveMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`[terminal-react] HMR: ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("[terminal-react] using bundled webview (no Vite dev server)");
    }
  }
  return "views://mainview/index.html";
}

const url = await resolveMainViewUrl();

new BrowserWindow({
  title: "Terminal React",
  url,
  frame: {
    width: 1280,
    height: 840,
    x: 160,
    y: 120,
  },
});

console.log("[terminal-react] started");
