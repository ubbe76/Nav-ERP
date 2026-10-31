import { z } from "zod";

// Shared shape for paginated register listings: every unbounded list endpoint
// takes search/limit/offset and answers with { rows, total }. The max limit is
// deliberately generous (1000) because form dropdowns fetch "everything" with
// ?limit=1000 until searchable pickers exist.
export const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paged<T> {
  rows: T[];
  total: number;
}

// Escapes ILIKE wildcards in a user-supplied term and wraps it in %...% for
// contains-matching (Postgres' default escape char is backslash).
export function ilikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// `?ids=<uuid>,<uuid>` for endpoints that act on a handful of records at
// once — the batch PDF routes (GET /purchase-orders/pdf?ids=…). Capped so a
// URL never carries an unbounded list; the behovsberäkning creates at most a
// few dozen orders per run.
export const idListQuerySchema = z.object({
  ids: z
    .string()
    .transform((raw) => raw.split(",").map((p) => p.trim()).filter((p) => p !== ""))
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});
export type IdListQuery = z.infer<typeof idListQuerySchema>;

// Comma-separated status query param ("draft,released") -> validated array.
// Empty/absent means no status filter. Pass a zod enum's `.options`.
export function statusListParam<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return undefined;
      const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
      const invalid = parts.filter((p) => !(values as readonly string[]).includes(p));
      if (invalid.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid status: ${invalid.join(", ")}` });
        return z.NEVER;
      }
      return parts as T[number][];
    });
}

// The order lists' (kund-, inköps- and tillverkningsorder) status filter also
// takes "late" — Sen, derived when the list is read by the same rule as
// Aviseringarna, never a stored status. splitLateFilter separates it from the
// real statuses; given together, both apply.
export const LATE_FILTER = "late";
export function orderStatusListParam<T extends readonly [string, ...string[]]>(values: T) {
  return statusListParam([...values, LATE_FILTER] as unknown as readonly [T[number] | typeof LATE_FILTER, ...(T[number] | typeof LATE_FILTER)[]]);
}
export function splitLateFilter<S extends string>(
  status: readonly (S | typeof LATE_FILTER)[] | undefined
): { statuses: S[] | undefined; late: boolean } {
  if (!status) return { statuses: undefined, late: false };
  const statuses = status.filter((s): s is S => s !== LATE_FILTER);
  return { statuses: statuses.length > 0 ? statuses : undefined, late: statuses.length !== status.length };
}
