import { eq, inArray } from "drizzle-orm";
import { costCenters, projects, type Db, type Tx } from "@navet/db";
import type { DimensionIds, DimensionRef } from "@navet/shared";

// Kostnadsställen och projekt (etapp 5 del A) — the one rule for putting a
// dimension on a row, shared by every writer (manual verification rows,
// templates, invoice and supplier invoice rows and headers, order headers,
// bank rules, the register defaults): the object must exist, and a NEW
// choice must be an active cost center / an open project. A row that already
// carries an inactive or closed object keeps it (sending the same id again
// is not a new choice) — the register decision never breaks the documents
// that predate it. Leaf-style (schema imports only, Db|Tx) like
// location-resolver.ts and accounting-period-lock.ts, so sales/purchase/
// article/banking can use it without dragging the economy service in.

export class CostCenterNotFoundError extends Error {
  constructor(id: string) {
    super(`Cost center ${id} not found`);
    this.name = "CostCenterNotFoundError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} not found`);
    this.name = "ProjectNotFoundError";
  }
}

// 400: an inactive cost center on a new row.
export class CostCenterInactiveError extends Error {
  constructor(public readonly code: string) {
    super(`Kostnadsstället ${code} är inaktivt och kan inte väljas på nya rader`);
    this.name = "CostCenterInactiveError";
  }
}

// 400: a closed (or inactive) project on a new row.
export class ProjectClosedError extends Error {
  constructor(public readonly code: string) {
    super(`Projektet ${code} är stängt och kan inte väljas på nya rader`);
    this.name = "ProjectClosedError";
  }
}

// 409 at Bokför of a manual verification: rows on accounts with Kräver
// kostnadsställe that carry none. `accounts` = the account numbers.
export class CostCenterRequiredError extends Error {
  constructor(public readonly accounts: string[]) {
    super(`Konto ${accounts.join(", ")} kräver kostnadsställe — ange ett på raden`);
    this.name = "CostCenterRequiredError";
  }
}

// 409 at DELETE of a cost center / project carried by BOOKED verification
// rows or by documents that are no longer drafts (issued invoices, attested
// supplier invoices, closed orders): the bookkeeping is immutable (0095), so
// the object can only be deactivated. Swedish on purpose — the web has no
// dictionary entry for it.
export class DimensionBookedError extends Error {
  constructor(kind: "costCenter" | "project", code: string) {
    super(
      kind === "costCenter"
        ? `Kostnadsstället ${code} används på bokförda verifikat eller låsta dokument och kan inte tas bort — inaktivera det i stället`
        : `Projektet ${code} används på bokförda verifikat eller låsta dokument och kan inte tas bort — stäng eller inaktivera det i stället`
    );
    this.name = "DimensionBookedError";
  }
}

export type DimensionInput = { costCenterId?: string | null | undefined; projectId?: string | null | undefined };

export interface ResolveDimensionsOptions {
  // The row's current pair on a PATCH. An id equal to the current one is
  // never re-checked (keeping an inactive/closed object is allowed), and an
  // omitted field keeps the current value unless `omittedKeepsExisting` is
  // false (a full-row PUT/PATCH, where omitted means none).
  existing?: DimensionIds | null;
  omittedKeepsExisting?: boolean;
  // What an omitted field on a NEW row takes (an order header's dimensions,
  // an article group's default). Also held to the rule, since a stale default
  // must not sneak a closed project onto a new row — but dropped silently
  // rather than refused, because the default is not the user's choice.
  fallback?: Partial<DimensionIds> | null;
}

type Source = "input" | "existing" | "fallback";

// Resolves an input's dimension pair against the registers. Where a value
// comes from decides how strictly it is checked: the user's own choice
// (input) is refused when it breaks the rule, a kept value (existing) is
// never re-checked, a default (fallback) is dropped silently when it no
// longer passes.
export async function resolveDimensions(
  executor: Db | Tx,
  input: DimensionInput,
  opts: ResolveDimensionsOptions = {}
): Promise<DimensionIds> {
  const existing = opts.existing ?? null;
  const fallback = opts.fallback ?? null;
  const keepOmitted = opts.omittedKeepsExisting ?? true;

  function pick(key: keyof DimensionIds): { id: string | null; source: Source } {
    const given = input[key];
    if (given !== undefined) {
      if (existing && given !== null && given === existing[key]) return { id: given, source: "existing" };
      return { id: given, source: "input" };
    }
    if (existing && keepOmitted) return { id: existing[key], source: "existing" };
    return { id: fallback?.[key] ?? null, source: "fallback" };
  }

  const cc = pick("costCenterId");
  let costCenterId = cc.id;
  if (cc.id !== null && cc.source !== "existing") {
    const [row] = await executor
      .select({ code: costCenters.code, active: costCenters.active })
      .from(costCenters)
      .where(eq(costCenters.id, cc.id));
    const problem = !row ? new CostCenterNotFoundError(cc.id) : !row.active ? new CostCenterInactiveError(row.code) : null;
    if (problem) {
      if (cc.source === "input") throw problem;
      costCenterId = null;
    }
  }

  const pr = pick("projectId");
  let projectId = pr.id;
  if (pr.id !== null && pr.source !== "existing") {
    const [row] = await executor
      .select({ code: projects.code, status: projects.status, active: projects.active })
      .from(projects)
      .where(eq(projects.id, pr.id));
    const problem = !row ? new ProjectNotFoundError(pr.id) : row.status === "closed" || !row.active ? new ProjectClosedError(row.code) : null;
    if (problem) {
      if (pr.source === "input") throw problem;
      projectId = null;
    }
  }

  return { costCenterId, projectId };
}

// id → { id, code, name } for the ids a response needs to label (verification
// rows, report rows, columns). One select per register, never per row.
export async function loadDimensionRefs(
  executor: Db | Tx,
  ids: { costCenterIds: Iterable<string | null | undefined>; projectIds: Iterable<string | null | undefined> }
): Promise<{ costCenters: Map<string, DimensionRef>; projects: Map<string, DimensionRef> }> {
  const ccIds = [...new Set([...ids.costCenterIds].filter((id): id is string => typeof id === "string"))];
  const prIds = [...new Set([...ids.projectIds].filter((id): id is string => typeof id === "string"))];
  const [cc, pr] = await Promise.all([
    ccIds.length === 0
      ? []
      : executor.select({ id: costCenters.id, code: costCenters.code, name: costCenters.name }).from(costCenters).where(inArray(costCenters.id, ccIds)),
    prIds.length === 0
      ? []
      : executor.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, prIds)),
  ]);
  return {
    costCenters: new Map(cc.map((row) => [row.id, row] as const)),
    projects: new Map(pr.map((row) => [row.id, row] as const)),
  };
}

export function dimensionRef(map: Map<string, DimensionRef>, id: string | null | undefined): DimensionRef | null {
  return id ? (map.get(id) ?? null) : null;
}

// "100 Verkstad" — how a PDF/CSV cell names an object (null = empty).
export function dimensionText(ref: { code: string; name: string } | null | undefined): string {
  return ref ? `${ref.code} ${ref.name}` : "";
}
