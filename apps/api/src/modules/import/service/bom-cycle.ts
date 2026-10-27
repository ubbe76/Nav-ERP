// Cycle detection for the BOM import. Pure — no database, no I/O.
//
// article.service.ts's isDescendant cannot be used here for two reasons: it
// issues one getBomComponents query per level (N+1), and — the fatal one —
// checking each row against a pre-batch snapshot is UNSOUND. A→B and B→A each
// pass on their own; together they close a cycle. A cycle that slips through
// breaks explodeBom and getBomTree, which both throw
// "Cyclic BOM detected ... this should be impossible".

export interface BomEdge {
  parentId: string;
  componentId: string;
  /** The bom_components row — set on the stored edges (the import's update path). */
  id?: string;
}

function addEdge(graph: Map<string, Set<string>>, edge: BomEdge): void {
  const children = graph.get(edge.parentId);
  if (children) children.add(edge.componentId);
  else graph.set(edge.parentId, new Set([edge.componentId]));
}

// Kahn's algorithm, used only as a yes/no oracle: does the whole graph sort?
function isAcyclic(edges: BomEdge[]): boolean {
  const children = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    addEdge(children, edge);
    if (!inDegree.has(edge.parentId)) inDegree.set(edge.parentId, 0);
    inDegree.set(edge.componentId, (inDegree.get(edge.componentId) ?? 0) + 1);
  }

  const queue = [...inDegree].filter(([, degree]) => degree === 0).map(([node]) => node);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.pop()!;
    visited++;
    for (const child of children.get(node) ?? []) {
      const degree = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, degree);
      if (degree === 0) queue.push(child);
    }
  }
  return visited === inDegree.size;
}

// Depth-first reachability, same direction as isDescendant: can `target` be
// reached by walking down from `from`?
function reaches(children: Map<string, Set<string>>, from: string, target: string): boolean {
  if (from === target) return true;
  const stack = [from];
  const visited = new Set<string>([from]);
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (child === target) return true;
      if (visited.has(child)) continue;
      visited.add(child);
      stack.push(child);
    }
  }
  return false;
}

/**
 * Returns the `rowIndex` of every added edge that would close a cycle.
 *
 * The existing edges are assumed acyclic (the database invariant), so only a
 * new edge can be to blame. A blamed edge is NOT added to the graph, so one
 * bad row does not cascade into false errors on the rows after it.
 */
export function findCyclicRows(existing: BomEdge[], added: (BomEdge & { rowIndex: number })[]): Set<number> {
  // Fast path: if everything together sorts topologically there is no cycle
  // and no row to blame. O(V+E), and this is the normal case — the expensive
  // per-row walk below only runs for files that really do contain one.
  if (added.length === 0 || isAcyclic([...existing, ...added])) return new Set();

  const children = new Map<string, Set<string>>();
  for (const edge of existing) addEdge(children, edge);

  const blamed = new Set<number>();
  for (const edge of added) {
    if (reaches(children, edge.componentId, edge.parentId)) blamed.add(edge.rowIndex);
    else addEdge(children, edge);
  }
  return blamed;
}
