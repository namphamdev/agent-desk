import { describe, expect, it } from "vitest";
import {
  clearSessionQueue,
  dequeuePrompt,
  enqueuePrompt,
  getQueue,
  removeQueuedPrompt,
  type PromptQueues,
} from "./promptQueue";

describe("promptQueue", () => {
  it("enqueues and dequeues in FIFO order", () => {
    let q: PromptQueues = {};
    q = enqueuePrompt(q, "s1", "first");
    q = enqueuePrompt(q, "s1", "second");
    expect(getQueue(q, "s1").map((x) => x.text)).toEqual(["first", "second"]);

    const a = dequeuePrompt(q, "s1");
    expect(a.next?.text).toBe("first");
    const b = dequeuePrompt(a.queues, "s1");
    expect(b.next?.text).toBe("second");
    expect(getQueue(b.queues, "s1")).toEqual([]);
    expect(dequeuePrompt(b.queues, "s1").next).toBeNull();
  });

  it("ignores empty / whitespace-only text", () => {
    let q: PromptQueues = {};
    q = enqueuePrompt(q, "s1", "   ");
    expect(getQueue(q, "s1")).toEqual([]);
  });

  it("keeps queues isolated per session", () => {
    let q: PromptQueues = {};
    q = enqueuePrompt(q, "a", "for a");
    q = enqueuePrompt(q, "b", "for b");
    expect(getQueue(q, "a")[0]?.text).toBe("for a");
    expect(getQueue(q, "b")[0]?.text).toBe("for b");
    q = clearSessionQueue(q, "a");
    expect(getQueue(q, "a")).toEqual([]);
    expect(getQueue(q, "b")[0]?.text).toBe("for b");
  });

  it("removes a single item by id", () => {
    let q: PromptQueues = {};
    q = enqueuePrompt(q, "s1", "one");
    q = enqueuePrompt(q, "s1", "two");
    const id = getQueue(q, "s1")[0]!.id;
    q = removeQueuedPrompt(q, "s1", id);
    expect(getQueue(q, "s1").map((x) => x.text)).toEqual(["two"]);
  });
});
