import type { BackwardTraceNode, ForwardTraceNode, TraceBatchRef } from "@navet/shared";
import { describe, expect, it } from "vitest";
import { traceBatch, type BatchTraceReader, type TraceMoEdge } from "../src/modules/stock/service/batch-trace.js";

// Spårbarhet (#8) — the pure trace: the tree, the cycle guard and the
// ceiling, against an in-memory graph. The SQL is batch-trace.repository.ts
// (stock-batch-trace.test.ts).

// A graph of TOs: each draws batches (`inputs`, null = Okänd of article
// "RAW") and receives into batches (`outputs`).
interface Mo {
  id: string;
  inputs: (string | null)[];
  outputs: (string | null)[];
}

const ref = (batchId: string | null, article = batchId ?? "RAW"): TraceBatchRef => ({
  batchId,
  batchNumber: batchId,
  articleId: `art-${article}`,
  articleNumber: article,
  articleName: article,
  unitCode: "st",
  batchTracked: true,
  tracking: "batch",
  expiresOn: null,
  origin: batchId === null ? null : "manual",
  createdAt: batchId === null ? null : "2026-01-01T00:00:00.000Z",
});

function fakeReader(mos: Mo[], extra: { receipts?: string[]; deliveries?: string[]; events?: [string, number][]; onHand?: string[] } = {}) {
  const calls = { rounds: 0 };
  const edge = (mo: Mo, batchId: string | null): TraceMoEdge => ({ manufacturingOrderId: mo.id, batch: ref(batchId), quantity: 1 });
  const reader: BatchTraceReader = {
    async batchRefs(ids) {
      return ids.filter((id) => id !== "MISSING").map((id) => ref(id));
    },
    async receipts(ids) {
      calls.rounds += 1;
      return (extra.receipts ?? [])
        .filter((id) => ids.includes(id))
        .map((batchId) => ({ batchId, purchaseOrderId: "po", orderNumber: "IO-1", supplierId: "s", supplierName: "ACME", receivedAt: "2026-01-01T00:00:00.000Z", quantity: 10 }));
    },
    async producedBy(ids) {
      return mos.flatMap((mo) =>
        mo.outputs.filter((b): b is string => b !== null && ids.includes(b)).map((batchId) => ({ batchId, manufacturingOrderId: mo.id, orderNumber: mo.id, quantity: 5 }))
      );
    },
    async materials(moIds) {
      return mos.filter((mo) => moIds.includes(mo.id)).flatMap((mo) => mo.inputs.map((b) => edge(mo, b)));
    },
    async events(ids) {
      return (extra.events ?? [])
        .filter(([id]) => ids.includes(id))
        .map(([batchId, quantity]) => ({ batchId, kind: "adjustment" as const, stockCountId: null, stockCountNumber: null, at: "2026-01-01T00:00:00.000Z", quantity, note: null }));
    },
    async consumedBy(ids) {
      return mos.flatMap((mo) =>
        mo.inputs
          .filter((b): b is string => b !== null && ids.includes(b))
          .map((batchId) => ({ batchId, manufacturingOrderId: mo.id, orderNumber: mo.id, articleId: "a", articleNumber: "A", articleName: "A", quantity: 2 }))
      );
    },
    async outputs(moIds) {
      return mos.filter((mo) => moIds.includes(mo.id)).flatMap((mo) => mo.outputs.map((b) => edge(mo, b)));
    },
    async deliveries(ids) {
      return (extra.deliveries ?? [])
        .filter((id) => ids.includes(id))
        .map((batchId) => ({
          batchId,
          deliveryId: "d",
          deliveryNumber: "FS-1",
          salesOrderId: "so",
          orderNumber: "KO-1",
          customerId: "c",
          customerName: "Kund AB",
          deliveredAt: "2026-02-01T00:00:00.000Z",
          quantity: 3,
        }));
    },
    async onHand(ids) {
      return (extra.onHand ?? []).filter((id) => ids.includes(id)).map((batchId) => ({ batchId, locationId: "l", warehouseName: "Huvudlager", locationName: "A1", blocked: false, quantity: 1 }));
    },
  };
  return { reader, calls };
}

// "X[TO-1(A,B[…])]" — the backward tree as text; a stub carries its stop.
const backText = (node: BackwardTraceNode): string => {
  const name = `${node.batch.batchNumber ?? "Okänd"}${node.stop ? `!${node.stop}` : ""}`;
  const orders = node.manufacturingOrders.map((mo) => `${mo.orderNumber}(${mo.materials.map(backText).join(",")})`);
  return orders.length > 0 ? `${name}[${orders.join(";")}]` : name;
};
const forwardText = (node: ForwardTraceNode): string => {
  const name = `${node.batch.batchNumber ?? "Okänd"}${node.stop ? `!${node.stop}` : ""}`;
  const orders = node.consumedBy.map((mo) => `${mo.orderNumber}(${mo.produced.map(forwardText).join(",")})`);
  return orders.length > 0 ? `${name}[${orders.join(";")}]` : name;
};

describe("traceBatch (pure)", () => {
  // RAW1 + RAW2 → TO-1 → HALF; HALF + Okänd → TO-2 → FINAL.
  const chain: Mo[] = [
    { id: "TO-1", inputs: ["RAW1", "RAW2"], outputs: ["HALF"] },
    { id: "TO-2", inputs: ["HALF", null], outputs: ["FINAL"] },
  ];

  it("null for a batch that does not exist", async () => {
    expect(await traceBatch(fakeReader([]).reader, "MISSING")).toBeNull();
  });

  it("backward through a halvfabrikat: the TO, its material batches and theirs — Okänd as a leaf; receipts and positive events on the node", async () => {
    const { reader } = fakeReader(chain, { receipts: ["RAW1"], events: [["RAW2", 4], ["RAW2", -1]] });
    const trace = (await traceBatch(reader, "FINAL"))!;
    expect(trace.truncated).toBe(false);
    expect(backText(trace.backward)).toBe("FINAL[TO-2(HALF[TO-1(RAW1,RAW2)],Okänd!unknown)]");
    const half = trace.backward.manufacturingOrders[0]!.materials[0]!;
    expect(half).toMatchObject({ quantity: 1, stop: null });
    const [raw1, raw2] = half.manufacturingOrders[0]!.materials;
    expect(raw1!.receipts).toMatchObject([{ orderNumber: "IO-1", supplierName: "ACME", quantity: 10 }]);
    // Only what came IN counts as a source.
    expect(raw2!.events.map((e) => e.quantity)).toEqual([4]);
    expect(trace.backward.quantity).toBeNull();
  });

  it("forward through a halvfabrikat: the TOs that drew it and what they produced; deliveries, negative events and stock on the node", async () => {
    const { reader } = fakeReader(chain, { deliveries: ["FINAL"], events: [["HALF", -2], ["HALF", 3]], onHand: ["RAW1", "FINAL"] });
    const trace = (await traceBatch(reader, "RAW1"))!;
    expect(forwardText(trace.forward)).toBe("RAW1[TO-1(HALF[TO-2(FINAL)])]");
    const half = trace.forward.consumedBy[0]!.produced[0]!;
    expect(half.events.map((e) => e.quantity)).toEqual([-2]);
    const final = half.consumedBy[0]!.produced[0]!;
    expect(final.deliveries).toMatchObject([{ deliveryNumber: "FS-1", orderNumber: "KO-1", customerName: "Kund AB", quantity: 3 }]);
    expect(final.onHand).toHaveLength(1);
    expect(trace.forward.onHand).toHaveLength(1);
    // The root has nothing behind it.
    expect(backText(trace.backward)).toBe("RAW1");
  });

  it("a TO whose goods went in without a batch is a leaf (stop unknown) under the TO", async () => {
    const { reader } = fakeReader([{ id: "TO-1", inputs: ["RAW1"], outputs: [null] }]);
    expect(forwardText((await traceBatch(reader, "RAW1"))!.forward)).toBe("RAW1[TO-1(Okänd!unknown)]");
  });

  it("a cycle (rework: a TO draws its own batch) is expanded once and then a stub — the trace ends", async () => {
    const { reader, calls } = fakeReader([
      { id: "TO-1", inputs: ["X", "RAW1"], outputs: ["X"] },
      { id: "TO-2", inputs: ["X"], outputs: ["Y"] },
      { id: "TO-3", inputs: ["Y"], outputs: ["X"] },
    ]);
    const trace = (await traceBatch(reader, "X"))!;
    expect(trace.truncated).toBe(false);
    expect(backText(trace.backward)).toBe("X[TO-1(X!repeated,RAW1);TO-3(Y[TO-2(X!repeated)])]");
    expect(forwardText(trace.forward)).toBe("X[TO-1(X!repeated);TO-2(Y[TO-3(X!repeated)])]");
    // Backward visited X, then RAW1 + Y — two rounds, not an endless loop.
    expect(calls.rounds).toBe(2);
  });

  it("a diamond: a batch two TOs drew is expanded under the first and a stub under the second", async () => {
    const { reader } = fakeReader([
      { id: "TO-1", inputs: ["RAW1"], outputs: ["A"] },
      { id: "TO-2", inputs: ["RAW1"], outputs: ["B"] },
      { id: "TO-3", inputs: ["A", "B"], outputs: ["TOP"] },
    ]);
    const trace = (await traceBatch(reader, "TOP"))!;
    expect(backText(trace.backward)).toBe("TOP[TO-3(A[TO-1(RAW1)],B[TO-2(RAW1!repeated)])]");
    expect(forwardText((await traceBatch(reader, "RAW1"))!.forward)).toBe("RAW1[TO-1(A[TO-3(TOP)]);TO-2(B[TO-3(TOP!repeated)])]");
  });

  // B0 ← TO-1 ← B1 ← TO-2 ← B2 … a straight chain of n batches.
  const line = (n: number): Mo[] => Array.from({ length: n }, (_, i) => ({ id: `TO-${i + 1}`, inputs: [`B${i + 1}`], outputs: [`B${i}`] }));

  it("the depth ceiling: what lies deeper is a stub with stop limit, and truncated is true", async () => {
    const { reader } = fakeReader(line(5));
    const whole = (await traceBatch(reader, "B0"))!;
    expect(whole.truncated).toBe(false);
    expect(backText(whole.backward)).toBe("B0[TO-1(B1[TO-2(B2[TO-3(B3[TO-4(B4[TO-5(B5)])])])])]");

    const cut = (await traceBatch(reader, "B0", { maxDepth: 2 }))!;
    expect(cut.truncated).toBe(true);
    expect(backText(cut.backward)).toBe("B0[TO-1(B1[TO-2(B2[TO-3(B3!limit)])])]");
    // Forward from the far end, the same ceiling.
    const forward = (await traceBatch(reader, "B5", { maxDepth: 1 }))!;
    expect(forward.truncated).toBe(true);
    expect(forwardText(forward.forward)).toBe("B5[TO-5(B4[TO-4(B3!limit)])]");

    // The default depth is 12: a chain of 14 is cut, one of 12 is whole.
    expect((await traceBatch(fakeReader(line(12)).reader, "B0"))!.truncated).toBe(false);
    expect((await traceBatch(fakeReader(line(14)).reader, "B0"))!.truncated).toBe(true);
  });

  it("the node ceiling: batches, TOs, receipts, deliveries and events all count — per direction", async () => {
    // One TO drawing 30 batches.
    const wide: Mo[] = [{ id: "TO-1", inputs: Array.from({ length: 30 }, (_, i) => `R${i}`), outputs: ["TOP"] }];
    const { reader } = fakeReader(wide);
    const cut = (await traceBatch(reader, "TOP", { maxNodes: 12 }))!;
    expect(cut.truncated).toBe(true);
    // The root and the TO took two; ten batches were followed, the rest are stubs.
    const stops = cut.backward.manufacturingOrders[0]!.materials.map((m) => m.stop);
    expect(stops.filter((stop) => stop === null)).toHaveLength(10);
    expect(stops.filter((stop) => stop === "limit")).toHaveLength(20);
    // The forward direction has its own budget and nothing to cut.
    expect(cut.forward.stop).toBeNull();

    // The default is 500: a TO drawing 600 batches is cut.
    const huge: Mo[] = [{ id: "TO-1", inputs: Array.from({ length: 600 }, (_, i) => `R${i}`), outputs: ["TOP"] }];
    const big = (await traceBatch(fakeReader(huge).reader, "TOP"))!;
    expect(big.truncated).toBe(true);
    expect(big.backward.manufacturingOrders[0]!.materials.filter((m) => m.stop === null)).toHaveLength(498);

    // Lists are cut too: 5 deliveries with room for 3.
    const many = fakeReader([], { deliveries: ["TOP", "TOP", "TOP", "TOP", "TOP"] });
    const listed = (await traceBatch(many.reader, "TOP", { maxNodes: 4 }))!;
    expect(listed.truncated).toBe(true);
    expect(listed.forward.deliveries).toHaveLength(3);
  });
});
