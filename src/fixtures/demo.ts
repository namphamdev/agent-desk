import type { SessionUpdate } from "../session/types";

/**
 * A recorded ACP session that exercises the rendering pipeline:
 * a user prompt, a plan, an agent explanation with markdown/code/table/mermaid,
 * a code edit (with a diff), and a final completed tool call.
 *
 * Render this in M1 to validate the UI without a live agent.
 */
export const demoUpdates: SessionUpdate[] = [
  {
    sessionUpdate: "user_message_chunk",
    content: {
      type: "text",
      text: "How does this app show progress of each music variant when generating?",
    },
  },
  {
    sessionUpdate: "plan",
    plan: {
      entries: [
        { content: "Locate the variant rendering component", state: "completed" },
        {
          content: "Trace the progress signals (stage, percent, skeleton)",
          state: "completed",
        },
        {
          content: "Summarize how progress is shown per stage",
          state: "in_progress",
        },
      ],
    },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Read VariantSelector.tsx",
    kind: "read",
    status: "completed",
    locations: [
      {
        path: "/app/src/screens/dashboard/library/components/VariantSelector.tsx",
        line: 12,
      },
    ],
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "export function VariantCard({ variant }: { variant: Variant }) { ... }",
        },
      },
    ],
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "## How music variant generation progress is shown\n\nThere's a layered system. \"Progress\" is actually several distinct signals, each rendered differently. Here's how each variant shows its progress while generating.\n\nThe per-variant UI lives in `VariantCard` inside `src/screens/dashboard/library/components/VariantSelector.tsx`. Each card shows up to six things depending on its stage:" },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "\n\n| Visual | When it shows | Code |\n| --- | --- | --- |\n| Numeric `%` badge | Only when `variant.stage === 'generation'` | `VariantSelector` |\n| Skeleton pulse for the title | Title not yet streamed in (`variant.pending`) | `VariantSelector` |\n| Skeleton pulse for tags | Display tags pending | `VariantSelector` |\n| Animated EQ-bars icon | Active variant + playing | `EQBars` |\n| Playback progress bar | Active variant while listening | `VariantSelector` |\n\n" },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "### How the variants relate\n\nThe generation flow coordinates across stages:\n\n```mermaid\nflowchart LR\n  A[Request variants] --> B{Backend}\n  B -->|stream| C[stage: generation]\n  C --> D[% badge + skeleton]\n  D --> E[stage: ready]\n  E --> F[EQ-bars on play]\n```\n\nThe percentage badge is driven by the streamed progress value:" },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "\n\n```tsx\n{variant.stage === \"generation\" && (\n  <span className=\"text-xs text-emerald-400\">\n    {Math.round(variant.progress * 100)}%\n  </span>\n)}\n```\n\n" },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "t2",
    title: "Edit VariantSelector.tsx",
    kind: "edit",
    status: "in_progress",
    locations: [
      {
        path: "/app/src/screens/dashboard/library/components/VariantSelector.tsx",
        line: 41,
      },
    ],
    content: [
      {
        type: "diff",
        path: "/app/src/screens/dashboard/library/components/VariantSelector.tsx",
        oldText: '      <div className="flex items-center gap-2">\n        {variant.title ?? <Skeleton className="w-24" />}\n      </div>',
        newText: '      <div className="flex items-center gap-2">\n        {variant.stage === "generation" ? (\n          <Skeleton className="w-24" />\n        ) : (\n          variant.title\n        )}\n        {variant.stage === "generation" && (\n          <span className="text-xs text-emerald-400">\n            {Math.round(variant.progress * 100)}%\n          </span>\n        )}\n      </div>',
      },
    ],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    status: "completed",
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "That edit surfaces the `%` badge only during the `generation` stage and keeps the skeleton pulse for the title until it streams in. Want me to do the same for the tag skeletons?" },
  },
];
