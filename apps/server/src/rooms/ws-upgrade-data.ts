/** WebSocket upgrade info stored per-connection. Passed through Bun's
 * `server.upgrade(req, { data })` and consumed in the `open` callback to
 * attach the socket to the correct room. */
export interface WsUpgradeData {
  roomId: string;
  roomKind: "session" | "device" | "session-workspace";
  userId: string;
  /** Device rooms only: host | client. */
  role?: "host" | "client";
  /** Device rooms only: connection id. */
  connId?: string;
}
