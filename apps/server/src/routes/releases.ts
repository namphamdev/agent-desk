/**
 * Static release artifact serving + install.sh. Release files are stored on
 * the filesystem under `{DATA_DIR}/releases/`.
 */
import type { Env } from "../env";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Install.sh content — embedded at build time. Falls back to reading from
 * the filesystem if not embedded. */
let installShContent: string | undefined;

export const setInstallSh = (content: string): void => {
  installShContent = content;
};

export const serveInstallSh = (method: string): Response => {
  const body = method === "HEAD" ? null : (installShContent ?? "");
  return new Response(body, {
    headers: {
      "content-type": "application/x-sh",
      "cache-control": "public, max-age=0, must-revalidate"
    }
  });
};

export const serveRelease = (method: string, key: string, env: Env): Response => {
  if (key.length === 0 || key.includes("..")) {
    return new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  // Resolve safely under the releases directory.
  const filePath = resolve(env.DATA_DIR, "releases", key);
  const releasesDir = resolve(env.DATA_DIR, "releases");
  if (!filePath.startsWith(releasesDir + "/") && filePath !== releasesDir) {
    return new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  if (!existsSync(filePath)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }

  const stat = statSync(filePath);
  const mutable = key.endsWith(".txt") || key.endsWith(".json");
  const contentType = key.endsWith(".txt")
    ? "text/plain; charset=utf-8"
    : key.endsWith(".json")
      ? "application/json"
      : "application/octet-stream";

  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(stat.size),
    "cache-control": mutable
      ? "public, max-age=60"
      : "public, max-age=86400, immutable"
  });

  const body = method === "HEAD" ? null : readFileSync(filePath);
  return new Response(body, { headers });
};
