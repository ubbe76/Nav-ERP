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
  onHand(batchIds: string[]): Promise<(TraceOnHand & { batchId: string })[]>;
}

export interface BatchTraceLimits {
  maxDepth?: number;
  maxNodes?: number;
}

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

// The next level: the named batches among the edges that have not been
// visited, as far as the depth and the budget allow. A batch that is refused
// is remembered in `limited` (its stub says "limit").
function nextFrontier(edges: TraceMoEdge[], visited: Set<string>, limited: Set<string>, budget: Budget, depthAllowed: boolean): string[] {
  const next: string[] = [];
  for (const edge of edges) {
    const id = edge.batch.batchId;
    if (id === null || visited.has(id) || limited.has(id)) continue;
    if (!depthAllowed) {
      budget.truncated = true;
      limited.add(id);
    } else if (!budget.take()) {
      limited.add(id);
    } else {
      visited.add(id);
      next.push(id);
    }
  }
  return next;
}

interface BackwardFacts {
  receipts: TraceReceipt[];
  orders: { manufacturingOrderId: string; orderNumber: string; quantity: number; materials: TraceMoEdge[] }[];
  events: TraceEvent[];
}

async function traceBackward(reader: BatchTraceReader, root: TraceBatchRef & { batchId: string }, maxDepth: number, budget: Budget) {
  const facts = new Map<string, BackwardFacts>();
  const visited = new Set([root.batchId]);
  const limited = new Set<string>();
  let frontier = [root.batchId];
  for (let depth = 0; frontier.length > 0; depth++) {
    const [receipts, produced, events] = await Promise.all([reader.receipts(frontier), reader.producedBy(frontier), reader.events(frontier)]);
    const keptOrders = budget.takeList(produced);
    const keptReceipts = budget.takeList(receipts);
    const keptEvents = budget.takeList(events.filter((e) => e.quantity > 0));
    const orderIds = unique(keptOrders.map((o) => o.manufacturingOrderId));
    const materials = orderIds.length > 0 ? await reader.materials(orderIds) : [];
    const materialsByOrder = groupBy(materials, (m) => m.manufacturingOrderId);
    const receiptsByBatch = groupBy(keptReceipts, (r) => r.batchId);
    const ordersByBatch = groupBy(keptOrders, (o) => o.batchId);
    const eventsByBatch = groupBy(keptEvents, (e) => e.batchId);
    for (const id of frontier) {
      facts.set(id, {
        receipts: (receiptsByBatch.get(id) ?? []).map(({ batchId: _b, ...receipt }) => receipt),
        orders: (ordersByBatch.get(id) ?? []).map(({ batchId: _b, ...order }) => ({
          ...order,
          materials: materialsByOrder.get(order.manufacturingOrderId) ?? [],
        })),
        events: (eventsByBatch.get(id) ?? []).map(({ batchId: _b, ...event }) => event),
      });
    }
    frontier = nextFrontier(materials, visited, limited, budget, depth + 1 <= maxDepth);
  }

  const built = new Set<string>();
  const build = (batch: TraceBatchRef, quantity: number | null): BackwardTraceNode => {
    const empty = { batch, quantity, receipts: [], manufacturingOrders: [], events: [] };
    if (batch.batchId === null) return { ...empty, stop: "unknown" };
    const own = facts.get(batch.batchId);
    if (!own) return { ...empty, stop: "limit" };
    if (built.has(batch.batchId)) return { ...empty, stop: "repeated" };
    built.add(batch.batchId);
    return {
      batch,
      quantity,
      stop: null,
      receipts: own.receipts,
      manufacturingOrders: own.orders.map((order) => ({
        manufacturingOrderId: order.manufacturingOrderId,
        orderNumber: order.orderNumber,
        quantity: order.quantity,
        materials: order.materials.map((m) => build(m.batch, m.quantity)),
      })),
      events: own.events,
    };
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
  const visited = new Set([root.batchId]);
  const limited = new Set<string>();
  let frontier = [root.batchId];
  for (let depth = 0; frontier.length > 0; depth++) {
    const [consumed, deliveries, events, onHand] = await Promise.all([
      reader.consumedBy(frontier),
      reader.deliveries(frontier),
      reader.events(frontier),
      reader.onHand(frontier),
    ]);
    const keptOrders = budget.takeList(consumed);
    const keptDeliveries = budget.takeList(deliveries);
    const keptEvents = budget.takeList(events.filter((e) => e.quantity < 0));
    const orderIds = unique(keptOrders.map((o) => o.manufacturingOrderId));
    const outputs = orderIds.length > 0 ? await reader.outputs(orderIds) : [];
    const outputsByOrder = groupBy(outputs, (o) => o.manufacturingOrderId);
    const ordersByBatch = groupBy(keptOrders, (o) => o.batchId);
    const deliveriesByBatch = groupBy(keptDeliveries, (d) => d.batchId);
    const eventsByBatch = groupBy(keptEvents, (e) => e.batchId);
    const onHandByBatch = groupBy(onHand, (o) => o.batchId);
    for (const id of frontier) {
      facts.set(id, {
        orders: (ordersByBatch.get(id) ?? []).map(({ batchId: _b, ...order }) => ({
          ...order,
          outputs: outputsByOrder.get(order.manufacturingOrderId) ?? [],
        })),
        deliveries: (deliveriesByBatch.get(id) ?? []).map(({ batchId: _b, ...delivery }) => delivery),
        events: (eventsByBatch.get(id) ?? []).map(({ batchId: _b, ...event }) => event),
        onHand: (onHandByBatch.get(id) ?? []).map(({ batchId: _b, ...place }) => place),
      });
    }
    frontier = nextFrontier(outputs, visited, limited, budget, depth + 1 <= maxDepth);
  }

  const built = new Set<string>();
  const build = (batch: TraceBatchRef, quantity: number | null): ForwardTraceNode => {
    const empty = { batch, quantity, consumedBy: [], deliveries: [], events: [], onHand: [] };
    if (batch.batchId === null) return { ...empty, stop: "unknown" };
    const own = facts.get(batch.batchId);
    if (!own) return { ...empty, stop: "limit" };
    if (built.has(batch.batchId)) return { ...empty, stop: "repeated" };
    built.add(batch.batchId);
    return {
      batch,
      quantity,
      stop: null,
      consumedBy: own.orders.map(({ outputs, ...order }) => ({
        ...order,
        produced: outputs.map((o) => build(o.batch, o.quantity)),
      })),
      deliveries: own.deliveries,
      events: own.events,
      onHand: own.onHand,
    };
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
