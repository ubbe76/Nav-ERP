import {
  compressSerialNumbers,
  sortSerialNumbers,
  type TraceSerialGroup,
  type TraceSerialOrigin,
} from "@navet/shared";
import type {
  BackwardTraceNode,
  BatchTrace,
  ForwardTraceNode,
  TraceBatchRef,
  TraceDelivery,
  TraceEvent,
  TraceOnHand,
  TraceReceipt,
} from "@navet/shared";

// Spårbarhet (#8) — the trace of one batch, backward (where it came from)
// and forward (where it went). Pure: no DB imports, the facts come through
// the reader (batch-trace.repository.ts; a fake in batch-trace.test.ts).
//
// Level by level (BFS), one round of reads per level — never a recursive
// query — so the ceiling and the cycle guard are trivial:
//   - `visited` per direction: a batch is expanded ONCE; every other place it
//     turns up (a diamond — two TOs drew the same batch — or a cycle, e.g.
//     rework where a TO draws its own article) is a stub with stop
//     "repeated";
//   - depth ≤ maxDepth and ≤ maxNodes nodes per direction (batches, TOs,
//     receipts, deliveries and events all count); what falls outside is left
//     out or becomes a stub with stop "limit", and `truncated` is true.
// Okänd (batch null) is always a leaf (stop "unknown"): stock without a
// batch cannot be followed.
//
// Serienummer (etapp 2 steg 5) — the GROUP NODE. A TO that received 50
// serial numbers has 50 batch rows; one node each would spend the ceiling on
// a single order. So the serial numbers of ONE article that one TO produced
// (forward) or drew (backward) are ONE node (`serials`): expanded once, with
// all its ids in the same round of reads, its children merged (one entry per
// TO, följesedel, inköpsorder and place; one event per sort) and counted as
// one node — and one per merged child — against the budget. `visited` is
// still per batch id. A number that is alone among a TO's edges, and the
// root, are ordinary nodes; a number that turns up alone after its group was
// expanded elsewhere is a "repeated" stub.
//
// A serial number created at a delivery (origin "delivery") never stands in
// stock: forward, the reader's `deliveries` includes the row that gave it
// (undoneAt set = burnt, shown as ångrad); backward, the root carries
// `deliveryOrigin` and nothing more — the stock it was taken from is
// untracked, so no TO or inköpsorder can be derived for certain.

export const BATCH_TRACE_MAX_DEPTH = 12;
export const BATCH_TRACE_MAX_NODES = 500;

// A material a TO drew, or a batch it produced. batchId null = Okänd.
export interface TraceMoEdge {
  manufacturingOrderId: string;
  batch: TraceBatchRef;
  quantity: number;
}

export interface BatchTraceReader {
  // The named batches' heads (unknown ids are simply absent).
  batchRefs(batchIds: string[]): Promise<TraceBatchRef[]>;
  // --- backward ---
  receipts(batchIds: string[]): Promise<(TraceReceipt & { batchId: string })[]>;
  // TOs whose finished goods went into the batch (net received > 0).
  producedBy(batchIds: string[]): Promise<{ batchId: string; manufacturingOrderId: string; orderNumber: string; quantity: number }[]>;
  // What those TOs drew, net per (TO, article, batch) > 0.
  materials(manufacturingOrderIds: string[]): Promise<TraceMoEdge[]>;
  // Every adjustment/stock-count row of the batches, signed.
  events(batchIds: string[]): Promise<(TraceEvent & { batchId: string })[]>;
  // --- forward ---
  consumedBy(
    batchIds: string[]
  ): Promise<
    { batchId: string; manufacturingOrderId: string; orderNumber: string; articleId: string; articleNumber: string; articleName: string; quantity: number }[]
  >;
  // What those TOs received, net per (TO, batch) > 0 — batch null when the
  // goods went in without one.
  outputs(manufacturingOrderIds: string[]): Promise<TraceMoEdge[]>;
  deliveries(batchIds: string[]): Promise<(TraceDelivery & { batchId: string })[]>;
  // The delivery row that GAVE a serial number (Serienummer skapas: Vid
  // utleverans), undone or not — absent for every other batch. Optional: a
  // reader without it has no such numbers.
  deliveryOrigins?(batchIds: string[]): Promise<(TraceSerialOrigin & { batchId: string })[]>;
  onHand(batchIds: string[]): Promise<(TraceOnHand & { batchId: string })[]>;
}

export interface BatchTraceLimits {
  maxDepth?: number;
  maxNodes?: number;
}

// How many of a group's ids the node carries for links.
export const TRACE_GROUP_LINKS_MAX = 200;

// Shared by the two directions: the node budget and the truncated flag.
class Budget {
  truncated = false;
  constructor(private left: number) {}
  // One node, if there is room for it.
  take(): boolean {
    if (this.left <= 0) {
      this.truncated = true;
      return false;
    }
    this.left -= 1;
    return true;
  }
  // As many of the list as there is room for.
  takeList<T>(items: T[]): T[] {
    if (items.length <= this.left) {
      this.left -= items.length;
      return items;
    }
    this.truncated = true;
    const kept = items.slice(0, Math.max(0, this.left));
    this.left = 0;
    return kept;
  }
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const list = map.get(key(item));
    if (list) list.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}

const unique = (ids: string[]) => [...new Set(ids)];

// The edges of a level, grouped: the named SERIAL numbers of one article
// under one TO together (two or more = a group node), everything else alone.
// In the order of first appearance. The ONE rule both the frontier and the
// tree are built with, so they always agree on what a group is.
function groupEdges(edges: TraceMoEdge[]): TraceMoEdge[][] {
  const groups: TraceMoEdge[][] = [];
  const serialGroups = new Map<string, TraceMoEdge[]>();
  for (const edge of edges) {
    if (edge.batch.batchId === null || edge.batch.kind !== "serial") {
      groups.push([edge]);
      continue;
    }
    const key = `${edge.manufacturingOrderId}|${edge.batch.articleId}`;
    const group = serialGroups.get(key);
    if (group) group.push(edge);
    else {
      const created = [edge];
      serialGroups.set(key, created);
      groups.push(created);
    }
  }
  return groups;
}

// The facts of one expanded node are stored under a key: the batch id for an
// ordinary node, "group:<first id>" for a group — never the same string.
const groupKey = (ids: string[]) => (ids.length === 1 ? ids[0]! : `group:${ids[0]!}`);
const isGroupKey = (key: string) => key.startsWith("group:");

// The next level: the edges' named batches that have not been visited, as
// far as the depth and the budget allow — one budget unit per node, and a
// group is one node. A batch that is refused is remembered in `limited` (its
// stub says "limit"). Each element is one node's ids.
function nextFrontier(edges: TraceMoEdge[], visited: Set<string>, limited: Set<string>, budget: Budget, depthAllowed: boolean): string[][] {
  const next: string[][] = [];
  for (const group of groupEdges(edges)) {
    const fresh = unique(
      group.flatMap((edge) => {
        const id = edge.batch.batchId;
        return id === null || visited.has(id) || limited.has(id) ? [] : [id];
      })
    );
    if (fresh.length === 0) continue;
    if (!depthAllowed) {
      budget.truncated = true;
      for (const id of fresh) limited.add(id);
    } else if (!budget.take()) {
      for (const id of fresh) limited.add(id);
    } else {
      for (const id of fresh) visited.add(id);
      next.push(fresh);
    }
  }
  return next;
}

// One level's frontier: which node each batch id belongs to.
function frontierKeys(frontier: string[][]): Map<string, string> {
  const keyOf = new Map<string, string>();
  for (const ids of frontier) for (const id of ids) keyOf.set(id, groupKey(ids));
  return keyOf;
}

// Re-keys a level's rows from batch id to node key and, within a GROUP,
// merges the rows that are the same thing (`same`) — quantities summed, the
// first row's other fields kept, `fold` for what more a merge carries. An
// ordinary node's rows are left exactly as read (two receipts of one batch
// from the same order stay two).
function nodeRows<T extends { batchId: string; quantity: number }>(
  rows: T[],
  keyOf: Map<string, string>,
  same: (row: T) => string,
  fold?: (into: T, row: T) => void
): T[] {
  const out: T[] = [];
  const merged = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf.get(row.batchId);
    if (key === undefined) continue;
    const copy = { ...row, batchId: key };
    if (!isGroupKey(key)) {
      out.push(copy);
      continue;
    }
    const mergeKey = `${key}|${same(row)}`;
    const into = merged.get(mergeKey);
    if (into) {
      into.quantity += row.quantity;
      fold?.(into, row);
    } else {
      merged.set(mergeKey, copy);
      out.push(copy);
    }
  }
  return out;
}

const eventSort = (event: TraceEvent) => `${event.kind}|${event.stockCountId ?? ""}|${event.note ?? ""}`;

// The group node's head: every number compressed, the first ids for links.
function serialGroup(edges: TraceMoEdge[]): TraceSerialGroup {
  const byNumber = new Map(edges.map((edge) => [edge.batch.batchNumber ?? "", edge.batch.batchId!]));
  const sorted = sortSerialNumbers([...byNumber.keys()]);
  return {
    count: sorted.length,
    numbers: compressSerialNumbers(sorted),
    batchIds: sorted.slice(0, TRACE_GROUP_LINKS_MAX).map((number) => byNumber.get(number)!),
  };
}

// What a built group node says about itself: which facts to show (those of
// its members' nodes that are not built yet) or why it has none.
function groupFacts<F>(edges: TraceMoEdge[], keyOf: Map<string, string>, facts: Map<string, F>, built: Set<string>): { stop: "limit" | "repeated" } | { stop: null; facts: F[] } {
  const ids = unique(edges.map((edge) => edge.batch.batchId!));
  const keys = unique(ids.flatMap((id) => (keyOf.has(id) ? [keyOf.get(id)!] : [])));
  const fresh = keys.filter((key) => !built.has(key) && facts.has(key));
  // Nothing new to show: cut off by the ceiling if any member never got its
  // facts, otherwise already expanded elsewhere.
  if (fresh.length === 0) return { stop: ids.some((id) => !keyOf.has(id) || !facts.has(keyOf.get(id)!)) ? "limit" : "repeated" };
  for (const key of fresh) built.add(key);
  return { stop: null, facts: fresh.map((key) => facts.get(key)!) };
}

interface BackwardFacts {
  receipts: TraceReceipt[];
  orders: { manufacturingOrderId: string; orderNumber: string; quantity: number; materials: TraceMoEdge[] }[];
  events: TraceEvent[];
  deliveryOrigin: TraceSerialOrigin | null;
}

async function traceBackward(reader: BatchTraceReader, root: TraceBatchRef & { batchId: string }, maxDepth: number, budget: Budget) {
  const facts = new Map<string, BackwardFacts>();
  // Which node (key) every expanded batch id belongs to, over all levels.
  const keyOf = new Map<string, string>();
  const visited = new Set([root.batchId]);
  const limited = new Set<string>();
  let frontier: string[][] = [[root.batchId]];
  for (let depth = 0; frontier.length > 0; depth++) {
    const ids = frontier.flat();
    const levelKeys = frontierKeys(frontier);
    for (const [id, key] of levelKeys) keyOf.set(id, key);
    const [receipts, produced, events, origins] = await Promise.all([
      reader.receipts(ids),
      reader.producedBy(ids),
      reader.events(ids),
      // Only the root can be a number created at a delivery (such a number
      // never stands in stock, so no TO ever drew it).
      depth === 0 && reader.deliveryOrigins ? reader.deliveryOrigins(ids) : Promise.resolve([]),
    ]);
    const keptOrders = budget.takeList(nodeRows(produced, levelKeys, (o) => o.manufacturingOrderId));
    const keptReceipts = budget.takeList(nodeRows(receipts, levelKeys, (r) => r.purchaseOrderId));
    const keptEvents = budget.takeList(
      nodeRows(
        events.filter((e) => e.quantity > 0),
        levelKeys,
        eventSort
      )
    );
    const orderIds = unique(keptOrders.map((o) => o.manufacturingOrderId));
    const materials = orderIds.length > 0 ? await reader.materials(orderIds) : [];
    const materialsByOrder = groupBy(materials, (m) => m.manufacturingOrderId);
    const receiptsByNode = groupBy(keptReceipts, (r) => r.batchId);
    const ordersByNode = groupBy(keptOrders, (o) => o.batchId);
    const eventsByNode = groupBy(keptEvents, (e) => e.batchId);
    for (const key of new Set(levelKeys.values())) {
      facts.set(key, {
        receipts: (receiptsByNode.get(key) ?? []).map(({ batchId: _b, ...receipt }) => receipt),
        orders: (ordersByNode.get(key) ?? []).map(({ batchId: _b, ...order }) => ({
          ...order,
          materials: materialsByOrder.get(order.manufacturingOrderId) ?? [],
        })),
        events: (eventsByNode.get(key) ?? []).map(({ batchId: _b, ...event }) => event),
        deliveryOrigin: origins
          .filter((origin) => levelKeys.get(origin.batchId) === key)
          .map(({ batchId: _b, ...origin }) => origin)[0] ?? null,
      });
    }
    frontier = nextFrontier(materials, visited, limited, budget, depth + 1 <= maxDepth);
  }

  const built = new Set<string>();
  const children = (edges: TraceMoEdge[]): BackwardTraceNode[] =>
    groupEdges(edges).map((group) => (group.length === 1 ? build(group[0]!.batch, group[0]!.quantity) : buildGroup(group)));
  const expanded = (own: BackwardFacts[]) => ({
    receipts: own.flatMap((f) => f.receipts),
    manufacturingOrders: own.flatMap((f) =>
      f.orders.map((order) => ({
        manufacturingOrderId: order.manufacturingOrderId,
        orderNumber: order.orderNumber,
        quantity: order.quantity,
        materials: children(order.materials),
      }))
    ),
    events: own.flatMap((f) => f.events),
  });
  const build = (batch: TraceBatchRef, quantity: number | null): BackwardTraceNode => {
    const empty = { batch, quantity, receipts: [], manufacturingOrders: [], events: [] };
    if (batch.batchId === null) return { ...empty, stop: "unknown" };
    const key = keyOf.get(batch.batchId);
    const own = key === undefined ? undefined : facts.get(key);
    if (!own) return { ...empty, stop: "limit" };
    // Expanded as part of a group elsewhere, or already built.
    if (key !== batch.batchId || built.has(batch.batchId)) return { ...empty, stop: "repeated" };
    built.add(batch.batchId);
    return { batch, quantity, stop: null, ...expanded([own]), ...(own.deliveryOrigin ? { deliveryOrigin: own.deliveryOrigin } : {}) };
  };
  const buildGroup = (edges: TraceMoEdge[]): BackwardTraceNode => {
    const head = { batch: edges[0]!.batch, quantity: edges.reduce((sum, edge) => sum + edge.quantity, 0), serials: serialGroup(edges) };
    const own = groupFacts(edges, keyOf, facts, built);
    if (own.stop !== null) return { ...head, stop: own.stop, receipts: [], manufacturingOrders: [], events: [] };
    return { ...head, stop: null, ...expanded(own.facts) };
  };
  return build(root, null);
}

interface ForwardFacts {
  orders: {
    manufacturingOrderId: string;
    orderNumber: string;
    articleId: string;
    articleNumber: string;
    articleName: string;
    quantity: number;
    outputs: TraceMoEdge[];
  }[];
  deliveries: TraceDelivery[];
  events: TraceEvent[];
  onHand: TraceOnHand[];
}

async function traceForward(reader: BatchTraceReader, root: TraceBatchRef & { batchId: string }, maxDepth: number, budget: Budget) {
  const facts = new Map<string, ForwardFacts>();
  const keyOf = new Map<string, string>();
  // The number behind every batch id seen as an edge — a group's deliveries
  // say which of its numbers went on each följesedel.
  const numberOf = new Map<string, string>();
  const visited = new Set([root.batchId]);
  const limited = new Set<string>();
  let frontier: string[][] = [[root.batchId]];
  for (let depth = 0; frontier.length > 0; depth++) {
    const ids = frontier.flat();
    const levelKeys = frontierKeys(frontier);
    for (const [id, key] of levelKeys) keyOf.set(id, key);
    const [consumed, deliveries, events, onHand] = await Promise.all([
      reader.consumedBy(ids),
      reader.deliveries(ids),
      reader.events(ids),
      reader.onHand(ids),
    ]);
    const keptOrders = budget.takeList(nodeRows(consumed, levelKeys, (o) => o.manufacturingOrderId));
    const keptDeliveries = budget.takeList(
      nodeRows(
        deliveries.map((d) => ({ ...d, numbers: [numberOf.get(d.batchId) ?? ""] })),
        levelKeys,
        (d) => `${d.deliveryId}|${d.undoneAt ?? ""}`,
        (into, d) => into.numbers.push(...d.numbers)
      )
    );
    const keptEvents = budget.takeList(
      nodeRows(
        events.filter((e) => e.quantity < 0),
        levelKeys,
        eventSort
      )
    );
    const places = nodeRows(onHand, levelKeys, (o) => o.locationId);
    const orderIds = unique(keptOrders.map((o) => o.manufacturingOrderId));
    const outputs = orderIds.length > 0 ? await reader.outputs(orderIds) : [];
    for (const edge of outputs) if (edge.batch.batchId !== null && edge.batch.batchNumber !== null) numberOf.set(edge.batch.batchId, edge.batch.batchNumber);
    const outputsByOrder = groupBy(outputs, (o) => o.manufacturingOrderId);
    const ordersByNode = groupBy(keptOrders, (o) => o.batchId);
    const deliveriesByNode = groupBy(keptDeliveries, (d) => d.batchId);
    const eventsByNode = groupBy(keptEvents, (e) => e.batchId);
    const onHandByNode = groupBy(places, (o) => o.batchId);
    for (const key of new Set(levelKeys.values())) {
      facts.set(key, {
        orders: (ordersByNode.get(key) ?? []).map(({ batchId: _b, ...order }) => ({
          ...order,
          outputs: outputsByOrder.get(order.manufacturingOrderId) ?? [],
        })),
        deliveries: (deliveriesByNode.get(key) ?? []).map(({ batchId: _b, numbers, ...delivery }) =>
          isGroupKey(key) ? { ...delivery, serialNumbers: compressSerialNumbers(numbers.filter((n) => n !== "")) } : delivery
        ),
        events: (eventsByNode.get(key) ?? []).map(({ batchId: _b, ...event }) => event),
        onHand: (onHandByNode.get(key) ?? []).map(({ batchId: _b, ...place }) => place),
      });
    }
    frontier = nextFrontier(outputs, visited, limited, budget, depth + 1 <= maxDepth);
  }

  const built = new Set<string>();
  const children = (edges: TraceMoEdge[]): ForwardTraceNode[] =>
    groupEdges(edges).map((group) => (group.length === 1 ? build(group[0]!.batch, group[0]!.quantity) : buildGroup(group)));
  const expanded = (own: ForwardFacts[]) => ({
    consumedBy: own.flatMap((f) => f.orders.map(({ outputs, ...order }) => ({ ...order, produced: children(outputs) }))),
    deliveries: own.flatMap((f) => f.deliveries),
    events: own.flatMap((f) => f.events),
    onHand: own.flatMap((f) => f.onHand),
  });
  const build = (batch: TraceBatchRef, quantity: number | null): ForwardTraceNode => {
    const empty = { batch, quantity, consumedBy: [], deliveries: [], events: [], onHand: [] };
    if (batch.batchId === null) return { ...empty, stop: "unknown" };
    const key = keyOf.get(batch.batchId);
    const own = key === undefined ? undefined : facts.get(key);
    if (!own) return { ...empty, stop: "limit" };
    if (key !== batch.batchId || built.has(batch.batchId)) return { ...empty, stop: "repeated" };
    built.add(batch.batchId);
    return { batch, quantity, stop: null, ...expanded([own]) };
  };
  const buildGroup = (edges: TraceMoEdge[]): ForwardTraceNode => {
    const head = { batch: edges[0]!.batch, quantity: edges.reduce((sum, edge) => sum + edge.quantity, 0), serials: serialGroup(edges) };
    const own = groupFacts(edges, keyOf, facts, built);
    if (own.stop !== null) return { ...head, stop: own.stop, consumedBy: [], deliveries: [], events: [], onHand: [] };
    return { ...head, stop: null, ...expanded(own.facts) };
  };
  return build(root, null);
}

// Null when the batch does not exist.
export async function traceBatch(reader: BatchTraceReader, batchId: string, limits: BatchTraceLimits = {}): Promise<BatchTrace | null> {
  const [root] = await reader.batchRefs([batchId]);
  if (!root || root.batchId === null) return null;
  const maxDepth = limits.maxDepth ?? BATCH_TRACE_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? BATCH_TRACE_MAX_NODES;
  const head = { ...root, batchId: root.batchId };
  // Each direction has its own budget — a wide backward tree must not leave
  // nothing for the forward one.
  const backwardBudget = new Budget(maxNodes - 1);
  const forwardBudget = new Budget(maxNodes - 1);
  const backward = await traceBackward(reader, head, maxDepth, backwardBudget);
  const forward = await traceForward(reader, head, maxDepth, forwardBudget);
  return { batch: root, backward, forward, truncated: backwardBudget.truncated || forwardBudget.truncated };
}
