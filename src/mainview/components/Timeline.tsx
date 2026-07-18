import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import type { ContentBlock, TimelineEntry as Entry } from "../../session/types";
import { rawTextFromContent } from "../../session/content-text";
import { Content } from "./content/Content";
import { ToolCallCard } from "./entries/ToolCallCard";
import { PlanView } from "./entries/PlanView";
import { MessageActions } from "./MessageActions";

export type MessageActionHandlers = {
  onCopyMessage: (text: string) => void | Promise<void>;
  onNewThreadFromMessage: (
    text: string,
    role: "user" | "agent" | "thought",
  ) => void | Promise<void>;
  canNewThread?: boolean;
};

type ItemType = "user" | "agent" | "thought" | "tool" | "plan";

/** Distance from bottom (px) that still counts as "following" the chat. */
const STICK_BOTTOM_PX = 80;

function itemTypeOf(entry: Entry): ItemType {
  if (entry.type === "tool_call") return "tool";
  if (entry.type === "plan") return "plan";
  if (entry.role === "user") return "user";
  if (entry.role === "thought") return "thought";
  return "agent";
}

/** Fingerprint trailing entry growth for plain-list stick-to-bottom. */
function entriesScrollSignature(entries: Entry[]): string {
  if (entries.length === 0) return "0";
  const last = entries[entries.length - 1]!;
  if (last.type === "message") {
    const parts = last.content.map((b) =>
      b.type === "text" ? `t${b.text.length}` : b.type,
    );
    return `${entries.length}:${last.id}:${last.role}:${parts.join(",")}`;
  }
  if (last.type === "tool_call") {
    const tc = last.toolCall;
    return `${entries.length}:${last.id}:tool:${tc.status}:${tc.content.length}:${tc.title}`;
  }
  return `${entries.length}:${last.id}:plan:${last.plan.entries.length}`;
}

/**
 * Virtualized session timeline via Legend List.
 *
 * Legend List keeps the item layer at opacity:0 until it measures a non-zero
 * viewport and finishes initial layout. A height of 0 leaves only ListHeader
 * ("Ready") visible. We measure the shell with ResizeObserver and pass explicit
 * pixel sizes; if measure fails we fall back to a plain scroll list so messages
 * always show.
 *
 * Stick-to-bottom: trust LegendList maintainScrollAtEnd only. A second pin path
 * (scrollToEnd on every stream chunk + onItemSizeChanged) raced the built-in
 * path and made the viewport thrash during ACP streaming.
 */
export function Timeline({
  entries,
  onOpenFile,
  header,
  empty,
  sessionKey,
  messageActions,
}: {
  entries: Entry[];
  onOpenFile?: (path: string, line?: number) => void;
  header?: ReactNode;
  empty?: ReactNode;
  sessionKey?: string | null;
  messageActions?: MessageActionHandlers;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });

  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;

    const measure = () => {
      // clientHeight is more reliable than getBoundingClientRect in some webviews
      // when transforms/subpixel rounding are involved.
      const height = Math.max(0, el.clientHeight || Math.floor(el.getBoundingClientRect().height));
      const width = Math.max(0, el.clientWidth || Math.floor(el.getBoundingClientRect().width));
      setViewport((prev) =>
        prev.height === height && prev.width === width
          ? prev
          : { height, width },
      );
    };

    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    // One more pass after layout settles (flex children often report 0 first frame).
    const raf = requestAnimationFrame(measure);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<Entry>) => (
      <TimelineRow
        entry={item}
        onOpenFile={onOpenFile}
        messageActions={messageActions}
      />
    ),
    [onOpenFile, messageActions],
  );

  const keyExtractor = useCallback((item: Entry) => item.id, []);

  const getItemType = useCallback(
    (item: Entry): ItemType => itemTypeOf(item),
    [],
  );

  const ready = viewport.height >= 32 && viewport.width >= 32;

  return (
    <div
      ref={shellRef}
      className="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
      data-timeline-viewport={`${viewport.width}x${viewport.height}`}
    >
      {ready ? (
        <LegendList
          key={sessionKey ?? "none"}
          data={entries}
          dataKey={sessionKey ?? "none"}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          estimatedItemSize={96}
          estimatedListSize={viewport}
          drawDistance={Math.max(250, viewport.height)}
          initialScrollAtEnd
          maintainScrollAtEnd={{
            animated: false,
            on: {
              dataChange: true,
              itemLayout: true,
              // Parent/header layout noise (elapsed timer) must not re-pin.
              layout: false,
            },
          }}
          maintainScrollAtEndThreshold={0.15}
          style={{
            height: viewport.height,
            width: viewport.width,
            overflow: "auto",
          }}
          contentContainerStyle={{
            paddingTop: 24,
            paddingRight: 24,
            paddingBottom: 160,
            paddingLeft: 24,
            boxSizing: "border-box",
          }}
          ListHeaderComponent={
            header ? (
              <div className="mb-6 flex items-center space-x-1 text-xs text-gray-500">
                {header}
              </div>
            ) : null
          }
          ListEmptyComponent={
            empty ? <div className="w-full">{empty}</div> : null
          }
          ItemSeparatorComponent={ItemSeparator}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        />
      ) : (
        <PlainTimeline
          entries={entries}
          onOpenFile={onOpenFile}
          header={header}
          empty={empty}
          messageActions={messageActions}
        />
      )}
    </div>
  );
}

/** Non-virtualized fallback — always shows messages if Legend List can't mount. */
function PlainTimeline({
  entries,
  onOpenFile,
  header,
  empty,
  messageActions,
}: {
  entries: Entry[];
  onOpenFile?: (path: string, line?: number) => void;
  header?: ReactNode;
  empty?: ReactNode;
  messageActions?: MessageActionHandlers;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollSig = entriesScrollSignature(entries);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollSig]);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist <= STICK_BOTTOM_PX;
  }, []);

  return (
    <div
      ref={scrollerRef}
      className="h-full w-full space-y-6 overflow-y-auto p-6 pb-40"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      onScroll={onScroll}
    >
      {header && (
        <div className="flex items-center space-x-1 text-xs text-muted-foreground">
          {header}
        </div>
      )}
      {entries.length === 0
        ? empty
        : entries.map((entry) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              onOpenFile={onOpenFile}
              messageActions={messageActions}
            />
          ))}
    </div>
  );
}

function ItemSeparator(_props: { leadingItem?: Entry }) {
  return <div style={{ height: 24 }} aria-hidden />;
}

function MessageFooter({
  content,
  role,
  messageActions,
  align = "start",
}: {
  content: ContentBlock[];
  role: "user" | "agent" | "thought";
  messageActions?: MessageActionHandlers;
  align?: "start" | "end";
}) {
  if (!messageActions) return null;
  const raw = rawTextFromContent(content);
  if (!raw) return null;
  return (
    <div className={align === "end" ? "flex justify-end" : undefined}>
      <MessageActions
        rawContent={raw}
        onCopy={messageActions.onCopyMessage}
        onNewThread={(text) => messageActions.onNewThreadFromMessage(text, role)}
        canNewThread={messageActions.canNewThread}
      />
    </div>
  );
}

const TimelineRow = memo(function TimelineRow({
  entry,
  onOpenFile,
  messageActions,
}: {
  entry: Entry;
  onOpenFile?: (path: string, line?: number) => void;
  messageActions?: MessageActionHandlers;
}) {
  if (entry.type === "tool_call") {
    return <ToolCallCard toolCall={entry.toolCall} onOpenFile={onOpenFile} />;
  }
  if (entry.type === "plan") {
    return <PlanView plan={entry.plan} />;
  }
  if (entry.role === "user") {
    return (
      <div className="flex flex-col items-end gap-0">
        <div className="max-w-2xl rounded-2xl rounded-tr-sm bg-muted px-5 py-3 text-sm text-foreground shadow-sm">
          {entry.content.map((b, i) => (
            <Content key={i} block={b} />
          ))}
        </div>
      </div>
    );
  }
  if (entry.role === "thought") {
    return (
      <details className="rounded-lg border border-dashed border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer select-none text-xs uppercase tracking-wider text-muted-foreground">
          Thought
        </summary>
        <div className="mt-2">
          {entry.content.map((b, i) => (
            <Content key={i} block={b} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <div className="flex flex-col space-y-3 text-foreground">
      {entry.content.map((b, i) => (
        <Content key={i} block={b} />
      ))}
      <MessageFooter
        content={entry.content}
        role="agent"
        messageActions={messageActions}
      />
    </div>
  );
});
