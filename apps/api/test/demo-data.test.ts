import { describe, expect, it } from "vitest";
import { DEMO_DATA, DEMO_LOCATIONS } from "../src/modules/demo/service/demo-data.js";

// The made-up company itself, without a database: the shape the writer and
// the flows rely on (spec 2026-10-15-exempeldata-design.md).
const byNumber = new Map(DEMO_DATA.articles.map((a) => [a.articleNumber, a]));

describe("exempeldata — datafilen", () => {
  it("has unique article numbers whose first digit follows the group", () => {
    expect(byNumber.size).toBe(DEMO_DATA.articles.length);
    const groupByDigit: Record<string, string> = { "1": "100", "2": "200", "3": "300" };
    for (const a of DEMO_DATA.articles) {
      if (a.group === "400") expect(a.articleNumber.startsWith("10")).toBe(true);
      else expect(a.group).toBe(groupByDigit[a.articleNumber[0]!]);
    }
  });

  it("points every structure row at an article in the file and every link at the parent's own operation", () => {
    for (const a of DEMO_DATA.articles) {
      const ops = new Set((a.routing ?? []).map((o) => o.sequenceNo));
      for (const row of a.bom ?? []) {
        expect(byNumber.has(row.component), `${a.articleNumber} → ${row.component}`).toBe(true);
        if (row.operation !== null) expect(ops.has(row.operation), `${a.articleNumber} op ${row.operation}`).toBe(true);
      }
    }
  });

  it("has no cycles and a phantom without routing", () => {
    const visit = (n: string, path: string[]): void => {
      expect(path).not.toContain(n);
      for (const row of byNumber.get(n)!.bom ?? []) visit(row.component, [...path, n]);
    };
    for (const a of DEMO_DATA.articles) visit(a.articleNumber, []);
    const phantoms = DEMO_DATA.articles.filter((a) => a.isPhantom);
    expect(phantoms.map((a) => a.articleNumber)).toEqual(["2100"]);
    expect(phantoms[0]!.routing ?? []).toEqual([]);
  });

  it("routes only to the file's own work centers, and purchased articles to a supplier in the file", () => {
    const centers = new Set(DEMO_DATA.workCenters.map((w) => w.code));
    const suppliers = new Set(DEMO_DATA.suppliers.map((s) => s.key));
    for (const a of DEMO_DATA.articles) {
      for (const op of a.routing ?? []) expect(centers.has(op.workCenter)).toBe(true);
      if (a.type === "purchased") expect(suppliers.has(a.supplier!.supplier)).toBe(true);
      else expect(a.supplier).toBeUndefined();
    }
  });

  it("uses only made-up names and no organisation numbers", () => {
    for (const p of [...DEMO_DATA.suppliers, ...DEMO_DATA.customers]) {
      expect(p.name).toMatch(/Exempel/);
      expect(p.email).toMatch(/@exempel\.invalid$/);
      expect(JSON.stringify(p)).not.toMatch(/\d{6}-\d{4}/);
    }
    expect(Object.values(DEMO_LOCATIONS)).toEqual(["Råvarulager", "Komponentlager"]);
  });

  it("gives opening stock only to purchased articles", () => {
    for (const a of DEMO_DATA.articles) {
      if (a.type === "manufactured") expect(a.openingStock).toBeUndefined();
      else expect(a.openingStock).toBeGreaterThan(0);
    }
  });
});
