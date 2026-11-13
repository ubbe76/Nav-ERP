import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "@navet/shared";

// Talfält (TODO "gränser per fält", 2026-11-13): every number in a shared
// schema has an upper bound, so a number larger than its column is a 400
// validation-failed on the FIELD rather than Postgres 22003 (the global
// number-out-of-range net says which request, not which field). The bound
// is the column's — .max(numericMax(p, s)) / INT4_MAX / LEAD_TIME_DAYS_MAX
// (coerce.ts); the walker cannot see the column, only that a bound exists.
//
// Walked: every exported zod schema of @navet/shared, through objects,
// arrays, optional/nullable/default, preprocess/refine/transform, unions and
// records. Numbers inside the schemas below are never written to a column
// and are deliberately unbounded.
const UNBOUNDED_OK = new Set([
  // The send dialog's amount is only rendered into the mail text.
  "mailTextRequestSchema",
  // Fakturaskanning: the stored interpretation read back (decode), not a
  // body — the draft it becomes is written through the bounded LF schemas.
  "invoiceScanRowSchema",
  "invoiceScanResultSchema",
]);
// Bounded by a refine the walker cannot read: one of 0, 6, 12 or 25 (isVatRate).
const BOUNDED_BY_REFINE = new Set<z.ZodTypeAny>([shared.vatRateSchema, shared.postingVatRateSchema]);

type Found = { schema: string; path: string };

function unboundedNumbers(schema: z.ZodTypeAny, name: string, path: string, seen: Set<z.ZodTypeAny>, out: Found[]) {
  if (seen.has(schema) || BOUNDED_BY_REFINE.has(schema)) return;
  seen.add(schema);
  const def = schema._def as { typeName?: string } & Record<string, unknown>;
  switch (def.typeName) {
    case "ZodNumber": {
      const checks = (def.checks as { kind: string }[]) ?? [];
      if (!checks.some((c) => c.kind === "max")) out.push({ schema: name, path: path || "(root)" });
      return;
    }
    case "ZodObject":
      for (const [key, value] of Object.entries((schema as z.AnyZodObject).shape)) {
        unboundedNumbers(value as z.ZodTypeAny, name, path ? `${path}.${key}` : key, seen, out);
      }
      return;
    case "ZodArray":
      return unboundedNumbers(def.type as z.ZodTypeAny, name, `${path}[]`, seen, out);
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return unboundedNumbers(def.innerType as z.ZodTypeAny, name, path, seen, out);
    case "ZodBranded":
      return unboundedNumbers(def.type as z.ZodTypeAny, name, path, seen, out);
    case "ZodEffects":
      return unboundedNumbers(def.schema as z.ZodTypeAny, name, path, seen, out);
    case "ZodPipeline":
      unboundedNumbers(def.in as z.ZodTypeAny, name, path, seen, out);
      return unboundedNumbers(def.out as z.ZodTypeAny, name, path, seen, out);
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>;
      for (const option of Array.isArray(options) ? options : options.values()) unboundedNumbers(option, name, path, seen, out);
      return;
    }
    case "ZodIntersection":
      unboundedNumbers(def.left as z.ZodTypeAny, name, path, seen, out);
      return unboundedNumbers(def.right as z.ZodTypeAny, name, path, seen, out);
    case "ZodRecord":
      return unboundedNumbers(def.valueType as z.ZodTypeAny, name, `${path}{}`, seen, out);
    case "ZodTuple":
      (def.items as z.ZodTypeAny[]).forEach((item, i) => unboundedNumbers(item, name, `${path}[${i}]`, seen, out));
      return;
    default:
      return;
  }
}

describe("number fields in the shared schemas", () => {
  it("every number has an upper bound (the column's), outside the listed query schemas", () => {
    const found: Found[] = [];
    for (const [name, value] of Object.entries(shared)) {
      if (!(value instanceof z.ZodType) || UNBOUNDED_OK.has(name)) continue;
      unboundedNumbers(value, name, "", new Set(), found);
    }
    expect(found.map((f) => `${f.schema}: ${f.path}`)).toEqual([]);
  });

  it("the walker sees a bound behind blankSafe, nullable and a refine", () => {
    const found: Found[] = [];
    const schema = z.object({
      bounded: shared.blankSafe(z.coerce.number().max(shared.numericMax(14, 4))).nullable().optional(),
      refined: shared.blankSafe(z.coerce.number().max(1).refine((n) => n !== 0)),
      open: shared.blankSafe(z.coerce.number().nonnegative()).optional(),
      list: z.array(z.object({ n: z.number() })),
    });
    unboundedNumbers(schema, "probe", "", new Set(), found);
    expect(found.map((f) => f.path)).toEqual(["open", "list[].n"]);
  });

  it("numericStep is the column's smallest positive value", () => {
    expect(shared.numericStep(4)).toBe(0.0001);
    expect(shared.numericStep(2)).toBe(0.01);
    expect(shared.numericStep(6)).toBe(0.000001);
    expect(shared.numericMax(14, 4)).toBe(9_999_999_999.9999);
  });
});
