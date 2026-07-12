import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_URL,
  getSessionBrowserState,
  patchSessionBrowser,
  pruneSessionBrowserMap,
  resolveBrowserPanelSession,
  toggleSessionBrowser,
} from "./useSessionBrowserState";

describe("session browser state helpers", () => {
  it("defaults when session missing or null", () => {
    expect(getSessionBrowserState({}, null)).toEqual({
      open: false,
      url: DEFAULT_BROWSER_URL,
    });
    expect(getSessionBrowserState({}, "s1")).toEqual({
      open: false,
      url: DEFAULT_BROWSER_URL,
    });
  });

  it("isolates open/url per session id", () => {
    let map = {};
    map = toggleSessionBrowser(map, "s1");
    map = patchSessionBrowser(map, "s1", { url: "https://x.com" });
    expect(getSessionBrowserState(map, "s1")).toEqual({
      open: true,
      url: "https://x.com",
    });

    // Other session still default.
    expect(getSessionBrowserState(map, "s2")).toEqual({
      open: false,
      url: DEFAULT_BROWSER_URL,
    });

    map = patchSessionBrowser(map, "s2", {
      open: true,
      url: "https://example.org",
    });
    expect(getSessionBrowserState(map, "s2").url).toBe("https://example.org");
    // s1 unchanged
    expect(getSessionBrowserState(map, "s1").url).toBe("https://x.com");
  });

  it("no-ops when session id is null", () => {
    const map = { s1: { open: true, url: "https://a.com" } };
    expect(toggleSessionBrowser(map, null)).toBe(map);
    expect(patchSessionBrowser(map, null, { url: "https://b.com" })).toBe(map);
  });

  it("prunes deleted sessions", () => {
    const map = {
      s1: { open: true, url: "https://a.com" },
      s2: { open: false, url: "https://b.com" },
    };
    const next = pruneSessionBrowserMap(map, new Set(["s2"]));
    expect(next).toEqual({ s2: map.s2 });
    expect(pruneSessionBrowserMap(map, new Set(["s1", "s2"]))).toBe(map);
  });

  it("resolveBrowserPanelSession prefers agent-driven open over inactive active chat", () => {
    const map = {
      s1: { open: false, url: DEFAULT_BROWSER_URL },
      s2: { open: true, url: "https://x.com" },
    };
    // Agent opened s2 while user is still on s1 — panel must still mount for s2.
    expect(resolveBrowserPanelSession(map, "s1", "s2")).toBe("s2");
    expect(resolveBrowserPanelSession(map, "s1", null)).toBeNull();
    expect(
      resolveBrowserPanelSession(
        { s1: { open: true, url: "https://a.com" } },
        "s1",
        null,
      ),
    ).toBe("s1");
  });
});
