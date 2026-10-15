import { describe, expect, it } from "vitest";
import { findCyclicRows } from "../src/modules/import/service/bom-cycle.js";

const edge = (parentId: string, componentId: string, rowIndex: number) => ({ parentId, componentId, rowIndex });

describe("findCyclicRows", () => {
  it("blames nothing when there is nothing to add", () => {
    expect(findCyclicRows([], [])).toEqual(new Set());
    expect(findCyclicRows([{ parentId: "A", componentId: "B" }], [])).toEqual(new Set());
  });

  it("accepts an ordinary addition", () => {
    const blamed = findCyclicRows([{ parentId: "A", componentId: "B" }], [edge("B", "C", 0)]);
    expect(blamed).toEqual(new Set());
  });

  it("blames a row that closes a cycle against the existing structure", () => {
    const blamed = findCyclicRows([{ parentId: "A", componentId: "B" }], [edge("B", "A", 0)]);
    expect(blamed).toEqual(new Set([0]));
  });

  it("blames the second of two rows that only together form a cycle", () => {
    // The whole point of the in-memory check: A->B and B->A each pass against
    // a pre-batch snapshot, so a per-row database check would let both in.
    const blamed = findCyclicRows([], [edge("A", "B", 0), edge("B", "A", 1)]);
    expect(blamed).toEqual(new Set([1]));
  });

  it("blames only the closing row of a three-step cycle", () => {
    const blamed = findCyclicRows([], [edge("A", "B", 0), edge("B", "C", 1), edge("C", "A", 2)]);
    expect(blamed).toEqual(new Set([2]));
  });

  it("blames a row that closes a cycle through a deep existing chain", () => {
    const existing = [
      { parentId: "A", componentId: "B" },
      { parentId: "B", componentId: "C" },
      { parentId: "C", componentId: "D" },
    ];
    expect(findCyclicRows(existing, [edge("D", "A", 0)])).toEqual(new Set([0]));
    expect(findCyclicRows(existing, [edge("D", "E", 0)])).toEqual(new Set());
  });

  it("leaves a diamond alone — a shared leaf is not a cycle", () => {
    const blamed = findCyclicRows([], [
      edge("A", "B", 0),
      edge("A", "C", 1),
      edge("B", "D", 2),
      edge("C", "D", 3),
    ]);
    expect(blamed).toEqual(new Set());
  });

  it("does not cascade — a blamed edge is left out so later rows stay clean", () => {
    const blamed = findCyclicRows([], [edge("A", "B", 0), edge("B", "A", 1), edge("B", "C", 2)]);
    expect(blamed).toEqual(new Set([1]));
  });

  it("catches a self-referencing edge", () => {
    expect(findCyclicRows([], [edge("A", "A", 0)])).toEqual(new Set([0]));
  });
});
