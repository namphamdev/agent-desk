import { describe, expect, it } from "vitest";
import {
  DEV_WEB_PORT,
  freePort,
  listPidsListeningOnPort,
  parseListeningPids,
} from "./process-kill";

describe("parseListeningPids", () => {
  it("dedupes and drops invalid / self pids", () => {
    const self = process.pid;
    expect(parseListeningPids(`12\n12\n${self}\nabc\n0\n-1\n34`)).toEqual([
      12, 34,
    ]);
  });

  it("accepts comma / space separated PowerShell output", () => {
    expect(parseListeningPids("23432  23432\r\n")).toEqual([23432]);
  });
});

describe("listPidsListeningOnPort / freePort", () => {
  it("returns empty for a closed high port", () => {
    // Ephemeral-ish port unlikely to be bound in CI.
    expect(listPidsListeningOnPort(58999)).toEqual([]);
  });

  it("freePort is a no-op when nothing listens", () => {
    expect(freePort(58999)).toEqual({ killed: [] });
  });

  it("exports the shared Vite port constant", () => {
    expect(DEV_WEB_PORT).toBe(5173);
  });
});
