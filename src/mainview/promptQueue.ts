/**
 * Pure helpers for the per-session prompt queue.
 * While an agent turn is in flight, new submissions enqueue here and flush
 * on turn end (ACP only allows one prompt at a time).
 */

export type QueuedPrompt = {
  id: string;
  text: string;
};

export type PromptQueues = Record<string, QueuedPrompt[]>;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getQueue(
  queues: PromptQueues,
  sessionId: string,
): QueuedPrompt[] {
  return queues[sessionId] ?? [];
}

/** Append a prompt to the end of a session's queue. */
export function enqueuePrompt(
  queues: PromptQueues,
  sessionId: string,
  text: string,
): PromptQueues {
  const trimmed = text.trim();
  if (!trimmed) return queues;
  const item: QueuedPrompt = { id: newId(), text: trimmed };
  return {
    ...queues,
    [sessionId]: [...getQueue(queues, sessionId), item],
  };
}

/** Remove one queued item by id. */
export function removeQueuedPrompt(
  queues: PromptQueues,
  sessionId: string,
  id: string,
): PromptQueues {
  const next = getQueue(queues, sessionId).filter((q) => q.id !== id);
  if (next.length === 0) {
    const { [sessionId]: _, ...rest } = queues;
    return rest;
  }
  return { ...queues, [sessionId]: next };
}

/** Drop every queued item for a session. */
export function clearSessionQueue(
  queues: PromptQueues,
  sessionId: string,
): PromptQueues {
  if (!(sessionId in queues)) return queues;
  const { [sessionId]: _, ...rest } = queues;
  return rest;
}

/**
 * Pop the head of the queue. Returns the next item (or null) and the
 * updated map.
 */
export function dequeuePrompt(
  queues: PromptQueues,
  sessionId: string,
): { next: QueuedPrompt | null; queues: PromptQueues } {
  const list = getQueue(queues, sessionId);
  if (list.length === 0) return { next: null, queues };
  const [next, ...rest] = list;
  if (rest.length === 0) {
    const { [sessionId]: _, ...without } = queues;
    return { next, queues: without };
  }
  return { next, queues: { ...queues, [sessionId]: rest } };
}
