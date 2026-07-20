/**
 * Free the Vite dev port before `dev:web` / `dev:hmr` so `strictPort: true`
 * does not fail with "Port 5173 is already in use" after a prior run.
 */
import { DEV_WEB_PORT, freePort } from "../src/bun/process-kill.ts";

const port = Number(process.env.VITE_PORT ?? DEV_WEB_PORT);
const { killed } = freePort(port);
if (killed.length > 0) {
  console.log(
    `[free-dev-port] freed :${port} (killed pid${killed.length > 1 ? "s" : ""} ${killed.join(", ")})`,
  );
}
