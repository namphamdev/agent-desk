import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/**
 * react-grab's default serializer hard-caps element text at 100 chars
 * (`slice(0, 100) + "..."`), which cuts off agent messages when grabbing
 * a paragraph. Provide full text + the component stack instead.
 */
if (import.meta.env.DEV) {
  void import("react-grab").then(({ getGlobalApi }) => {
    const api = getGlobalApi();
    if (!api) return;

    api.setOptions({
      getContent: async (elements) => {
        const parts = await Promise.all(
          elements.map(async (el) => {
            const tag = el.tagName.toLowerCase();
            const text =
              (el instanceof HTMLElement ? el.innerText : el.textContent) ?? "";
            const attrs = el instanceof HTMLElement && el.className
              ? ` class="${String(el.className).trim()}"`
              : "";
            const stack = await api.getStackContext(el);
            return `[<${tag}${attrs}>${text}</${tag}>${stack}]`;
          }),
        );
        return parts.join("\n");
      },
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
