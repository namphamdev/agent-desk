/**
 * Session manager: multi-session orchestration on the Bun side.
 * Owns the active ACP client, permission queue, and persistence.
 */

export { SessionManager } from "./manager";
export { resolveSelectOptionValue } from "./config-options";
export type { SessionManagerEvents, LiveSession } from "./types";
