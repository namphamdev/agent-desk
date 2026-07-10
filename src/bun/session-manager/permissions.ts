import type { PermissionRequest } from "../../shared/rpc";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/** Map an ACP permission request into the shape the UI expects. */
export function toPermissionRequest(
  params: RequestPermissionRequest & { requestId: string },
): PermissionRequest {
  const toolCall = params.toolCall;
  return {
    requestId: params.requestId,
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: toolCall.toolCallId ?? "unknown",
      title: toolCall.title ?? "Tool permission",
      kind: (toolCall.kind ?? undefined) as PermissionRequest["toolCall"]["kind"],
      status: toolCall.status ?? undefined,
      content: undefined,
      locations: toolCall.locations?.map((l) => ({
        path: l.path,
        line: l.line ?? undefined,
      })),
    },
    options: params.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    })),
  };
}
