/**
 * Pure helpers for built-in browser agent actions (snapshot / click / type).
 * The snapshot script is injected into the nested webview; click/type use refs.
 */

/** JS run inside the page to build an accessibility-ish snapshot with refs. */
export const SNAPSHOT_SCRIPT = `(() => {
  try {
    const interesting = new Set([
      "a", "button", "input", "textarea", "select", "summary",
      "option", "label", "h1", "h2", "h3", "h4", "h5", "h6",
    ]);
    const lines = [];
    let n = 0;
    const walk = (el, depth) => {
      if (!el || el.nodeType !== 1 || depth > 12 || n >= 200) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return;
      const style = window.getComputedStyle(el);
      if (style && (style.display === "none" || style.visibility === "hidden")) return;

      const role = el.getAttribute("role") || "";
      const isInteresting =
        interesting.has(tag) ||
        role === "button" ||
        role === "link" ||
        role === "textbox" ||
        role === "checkbox" ||
        el.onclick ||
        el.tabIndex >= 0;

      if (isInteresting) {
        n += 1;
        const ref = "e" + n;
        el.setAttribute("data-tr-ref", ref);
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
        const type = el.getAttribute("type") || "";
        const href = el.getAttribute("href") || "";
        const value =
          tag === "input" || tag === "textarea"
            ? String(el.value || "").slice(0, 60)
            : "";
        let line = "[ref=" + ref + "] <" + tag;
        if (type) line += ' type="' + type + '"';
        if (role) line += ' role="' + role + '"';
        if (href) line += ' href="' + href.slice(0, 80) + '"';
        line += ">";
        if (name) line += " " + JSON.stringify(name);
        if (value) line += " value=" + JSON.stringify(value);
        lines.push(line);
      }

      const children = el.children || [];
      for (let i = 0; i < children.length; i++) walk(children[i], depth + 1);
    };
    walk(document.body, 0);
    const payload = {
      ok: true,
      url: location.href,
      title: document.title || "",
      snapshot: lines.length
        ? lines.join("\\n")
        : "(no interactive elements found — page may still be loading)",
    };
    // Report back via hash so the host can observe did-navigate-in-page
    // (nested webview executeJavascript is fire-and-forget without a return).
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    location.hash = "tr-result=" + encoded;
    return true;
  } catch (err) {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify({
      ok: false,
      error: String(err && err.message ? err.message : err),
    }))));
    location.hash = "tr-result=" + encoded;
    return false;
  }
})()`;

export function clickScript(ref: string): string {
  const sel = JSON.stringify(`[data-tr-ref="${ref}"]`);
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`;
}

export function typeScript(ref: string, text: string, submit: boolean): string {
  const sel = JSON.stringify(`[data-tr-ref="${ref}"]`);
  const t = JSON.stringify(text);
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return false;
    el.focus();
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, (el.value || "") + ${t});
    else el.value = (el.value || "") + ${t};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (${submit ? "true" : "false"}) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else if (form) form.submit();
    }
    return true;
  })()`;
}

export function fillScript(ref: string, text: string): string {
  const sel = JSON.stringify(`[data-tr-ref="${ref}"]`);
  const t = JSON.stringify(text);
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return false;
    el.focus();
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, ${t});
    else el.value = ${t};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}

export function pressKeyScript(key: string): string {
  const k = JSON.stringify(key);
  return `(() => {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: ${k}, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: ${k}, bubbles: true }));
    return true;
  })()`;
}

/**
 * Evaluate an expression in the page and return via tr-result hash.
 * Expression should be a JS expression (not statements), e.g.
 * `localStorage.getItem("token")` or `document.cookie`.
 */
export function evaluateScript(expression: string): string {
  const expr = JSON.stringify(expression);
  return `(() => {
    try {
      const value = (0, eval)(${expr});
      let result;
      try {
        result = JSON.stringify(value);
      } catch (_e) {
        result = JSON.stringify(String(value));
      }
      const payload = {
        ok: true,
        url: location.href,
        title: document.title || "",
        result: result,
      };
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      location.hash = "tr-result=" + encoded;
      return true;
    } catch (err) {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err),
      }))));
      location.hash = "tr-result=" + encoded;
      return false;
    }
  })()`;
}

/** Parse tr-result hash payload from a navigated URL. */
export function parseTrResultHash(urlOrHash: string): unknown | null {
  try {
    const hash = urlOrHash.includes("#")
      ? urlOrHash.slice(urlOrHash.indexOf("#") + 1)
      : urlOrHash.replace(/^#/, "");
    if (!hash.startsWith("tr-result=")) return null;
    const b64 = hash.slice("tr-result=".length);
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}
