import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// System → Nummerserier shows each series by its Swedish name from the web's
// NUMBER_SERIES_LABELS. A series added by a migration without a name there
// shows up as a nameless row — this test finds every seeded key and requires
// a label for it.
const drizzleDir = new URL("../../../packages/db/drizzle/", import.meta.url);

function seededSeriesKeys(): string[] {
  const keys = new Set<string>();
  for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(new URL(file, drizzleDir), "utf8");
    for (const statement of sql.match(/INSERT INTO "number_series"[^;]*/g) ?? []) {
      for (const [, key] of statement.matchAll(/(?:\(|SELECT)\s*'([a-z_]+)'/g)) keys.add(key!);
    }
  }
  return [...keys].sort();
}

describe("nummerseriernas namn", () => {
  it("finds the seeded series", () => {
    expect(seededSeriesKeys()).toEqual(expect.arrayContaining(["purchase_order", "delivery", "shipment", "stock_count"]));
  });

  it("has a Swedish name in the web for every seeded series", () => {
    const types = readFileSync(new URL("../../web/lib/types.ts", import.meta.url), "utf8");
    const block = types.slice(types.indexOf("export const NUMBER_SERIES_LABELS"));
    const labels = block.slice(0, block.indexOf("};"));
    const missing = seededSeriesKeys().filter((key) => !new RegExp(`\\b${key}: "`).test(labels));
    expect(missing).toEqual([]);
  });
});
