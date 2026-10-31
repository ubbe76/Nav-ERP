import { describe, expect, it } from "vitest";
// Pure web helper, no imports of its own, so vitest loads it directly.
import { groupReportRows } from "../../web/lib/moReportRows.js";

// The TO card's Rapportera panel: operations by sequence number, each with
// its linked material; the rest is drawn at final reporting.

const op = (id: string, sequenceNo: number) => ({ id, sequenceNo });
const mat = (id: string, moOperationId: string | null) => ({ id, moOperationId });

describe("groupReportRows", () => {
  it("sorts the operations by sequence number without touching the input", () => {
    const ops = [op("c", 30), op("a", 10), op("b", 20)];
    const { groups } = groupReportRows(ops, []);
    expect(groups.map((g) => g.operation.id)).toEqual(["a", "b", "c"]);
    expect(ops.map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  it("puts linked material under its operation in input order and the rest in unlinked", () => {
    const { groups, unlinked } = groupReportRows(
      [op("a", 10), op("b", 20)],
      [mat("m1", "b"), mat("m2", null), mat("m3", "a"), mat("m4", "b")]
    );
    expect(groups[0]!.materials.map((m) => m.id)).toEqual(["m3"]);
    expect(groups[1]!.materials.map((m) => m.id)).toEqual(["m1", "m4"]);
    expect(unlinked.map((m) => m.id)).toEqual(["m2"]);
  });

  it("treats material pointing at an unknown operation as unlinked", () => {
    const { groups, unlinked } = groupReportRows([op("a", 10)], [mat("m1", "gone")]);
    expect(groups[0]!.materials).toEqual([]);
    expect(unlinked.map((m) => m.id)).toEqual(["m1"]);
  });

  it("handles empty inputs", () => {
    expect(groupReportRows([], [])).toEqual({ groups: [], unlinked: [] });
    const { groups, unlinked } = groupReportRows([], [mat("m1", null), mat("m2", "x")]);
    expect(groups).toEqual([]);
    expect(unlinked).toHaveLength(2);
  });
});
