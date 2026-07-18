import { describe, expect, it } from "vitest";
import {
  projectKeysBySessionRecency,
  reconcileProjectOrder,
} from "./projectOrder";

describe("projectKeysBySessionRecency", () => {
  it("orders projects by most recent session first", () => {
    const keys = projectKeysBySessionRecency([
      { project: "old", updatedAt: 10 },
      { project: "new", updatedAt: 30 },
      { project: "mid", updatedAt: 20 },
      { project: "old", updatedAt: 5 },
    ]);
    expect(keys).toEqual(["new", "mid", "old"]);
  });

  it("uses 'other' when project is missing", () => {
    expect(
      projectKeysBySessionRecency([
        { project: "", updatedAt: 2 },
        { project: null, updatedAt: 1 },
      ]),
    ).toEqual(["other"]);
  });
});

describe("reconcileProjectOrder", () => {
  it("seeds from session recency when empty", () => {
    expect(
      reconcileProjectOrder(
        [],
        [
          { project: "b", updatedAt: 1 },
          { project: "a", updatedAt: 3 },
        ],
      ),
    ).toEqual(["a", "b"]);
  });

  it("does not reshuffle when the newest chat in a project is deleted", () => {
    // Initial recency: A (t=100) above B (t=50).
    const seeded = reconcileProjectOrder(
      [],
      [
        { project: "A", updatedAt: 100 },
        { project: "A", updatedAt: 40 },
        { project: "B", updatedAt: 50 },
      ],
    );
    expect(seeded).toEqual(["A", "B"]);

    // Delete A's newest session → remaining max(A)=40 < max(B)=50.
    // Sticky order must keep A above B (this was the reported bug).
    expect(
      reconcileProjectOrder(seeded, [
        { project: "A", updatedAt: 40 },
        { project: "B", updatedAt: 50 },
      ]),
    ).toEqual(["A", "B"]);
  });

  it("drops projects that no longer have sessions and appends newcomers", () => {
    expect(
      reconcileProjectOrder(
        ["A", "gone", "B"],
        [
          { project: "B", updatedAt: 2 },
          { project: "A", updatedAt: 1 },
          { project: "C", updatedAt: 9 },
        ],
      ),
    ).toEqual(["A", "B", "C"]);
  });

  it("preserves a manual reorder across session list updates", () => {
    const manual = ["B", "A"];
    expect(
      reconcileProjectOrder(manual, [
        { project: "A", updatedAt: 100 },
        { project: "B", updatedAt: 10 },
      ]),
    ).toEqual(["B", "A"]);
  });
});
