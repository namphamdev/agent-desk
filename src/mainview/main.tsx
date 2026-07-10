import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ReactGrabAPI } from "react-grab";
import App from "./App";
import "./index.css";
import { getRpc } from "./rpc";

/**
 * Vite only sets import.meta.env.DEV during `vite serve`.
 * `vite build` always has DEV=false — even for local electrobun `dev`.
 * Honor MODE=development so `vite build --mode development` still ships
 * react-grab into the desktop webview.
 */
const enableReactGrab =
  import.meta.env.DEV || import.meta.env.MODE === "development";

function isElectrobunWebview(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __electrobunWebviewId?: number })
      .__electrobunWebviewId
  );
}

/**
 * Write text to the system clipboard.
 * Prefer Electrobun native FFI — WKWebView often rejects document.execCommand
 * / navigator.clipboard after async work, and some WebKits ignore JS patches
 * to document.execCommand entirely.
 */
async function writeTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (isElectrobunWebview()) {
    try {
      const res = await getRpc().request.writeClipboard({ text });
      if (res.ok) {
        console.info("[clipboard] native write ok,", text.length, "chars");
        return true;
      }
      console.warn("[clipboard] native write failed:", res.error);
    } catch (err) {
      console.warn("[clipboard] native write error:", err);
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      console.info("[clipboard] navigator write ok,", text.length, "chars");
      return true;
    }
  } catch (err) {
    console.warn("[clipboard] navigator.clipboard failed:", err);
  }

  // Last-ditch: focused on-screen textarea (some WebKits require focus).
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0.01;z-index:2147483647";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) {
      console.info("[clipboard] execCommand write ok,", text.length, "chars");
      return true;
    }
  } catch (err) {
    console.warn("[clipboard] execCommand fallback failed:", err);
  }

  return false;
}

async function buildGrabContent(
  api: ReactGrabAPI,
  elements: Element[],
): Promise<string> {
  const parts = await Promise.all(
    elements.map(async (el) => {
      const tag = el.tagName.toLowerCase();
      const text =
        (el instanceof HTMLElement ? el.innerText : el.textContent) ?? "";
      const attrs =
        el instanceof HTMLElement && el.className
          ? ` class="${String(el.className).trim()}"`
          : "";
      let stack = "";
      try {
        // Cap stack resolution so a hung source-map fetch can't block copy.
        stack = await Promise.race([
          api.getStackContext(el),
          new Promise<string>((resolve) => setTimeout(() => resolve(""), 400)),
        ]);
      } catch (err) {
        console.warn("[react-grab] getStackContext failed:", err);
      }
      return `[<${tag}${attrs}>${text}</${tag}>${stack}]`;
    }),
  );
  return parts.join("\n");
}

async function copyElements(
  api: ReactGrabAPI,
  elements: Element[],
): Promise<boolean> {
  if (elements.length === 0) return false;
  const content = await buildGrabContent(api, elements);
  if (!content.trim()) {
    console.warn("[clipboard] empty grab content");
    return false;
  }
  return writeTextToClipboard(content);
}

/**
 * react-grab ends copies in document.execCommand("copy"). That fails in
 * Electrobun's WKWebView, and patching execCommand is unreliable there.
 *
 * Two intercepts:
 * 1. Capture-phase ⌘/Ctrl+C while grab is active — fully owns the copy so
 *    react-grab never reaches its failing execCommand path (no "Failed to copy").
 * 2. onElementSelect while isCopying — covers toolbar / context-menu copy by
 *    returning a Promise that writes natively; react-grab skips sn→execCommand.
 */
function installReactGrab(api: ReactGrabAPI) {
  // 1) Keyboard: win the race with react-grab's keydown handler.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented || e.repeat) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "c" && e.key !== "C" && e.code !== "KeyC") return;
      if (!api.isActive()) return;

      const state = api.getState();
      const el = state.targetElement;
      if (!el || !(el instanceof Element)) return;

      // Stop react-grab (and the browser) from handling this shortcut.
      e.preventDefault();
      e.stopImmediatePropagation();

      void copyElements(api, [el]).then((ok) => {
        if (!ok) {
          console.warn(
            "[clipboard] keyboard grab copy failed — check native bridge",
          );
        }
      });
    },
    true,
  );

  // 2) Toolbar / context-menu copy path (no keydown).
  api.registerPlugin({
    name: "electrobun-clipboard",
    hooks: {
      onElementSelect: (element) => {
        // Only intercept during an actual copy. Returning a Promise during
        // normal hover-select would break selection.
        if (!api.getState().isCopying) return;

        return copyElements(api, [element]);
      },
    },
  });

  // Still used by prompt mode / serializers that don't go through select.
  api.setOptions({
    getContent: async (elements) => buildGrabContent(api, elements),
  });

  console.info(
    "[react-grab] electrobun clipboard interceptor ready",
    isElectrobunWebview() ? "(native bridge)" : "(web fallbacks)",
  );
}

if (enableReactGrab) {
  void import("react-grab")
    .then(({ getGlobalApi }) => {
      const api = getGlobalApi();
      if (!api) {
        console.warn("[react-grab] getGlobalApi() returned null");
        return;
      }
      installReactGrab(api);
    })
    .catch((err) => {
      console.warn("[react-grab] failed to load:", err);
    });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
