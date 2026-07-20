/**
 * Session manager: multi-session orchestration on the Bun side.
 * Owns the active ACP client, permission queue, and persistence.
 */

export {
  SessionManager,
  DEFAULT_IDLE_OFFLOAD_AFTER_MS,
  DEFAULT_IDLE_OFFLOAD_CHECK_INTERVAL_MS,
} from "./manager";
export type { SessionManagerOptions } from "./manager";
export { resolveSelectOptionValue } from "./config-options";
export type { SessionManagerEvents, LiveSession } from "./types";
