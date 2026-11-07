import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vakttest, Spärrade lagerplatser (0185): every reader of a stock balance
// must choose a side. Usable stock (what the planning means — without a
// Spärrad lagerplats) goes through onHandByArticle in
// stock/repository/on-hand.ts; nobody spreads their own filter on
// stock_locations.blocked. A reader of the PHYSICAL balance (Saldon, the
// valuation, one place's own balance, the log) reads stock_balances or
// sums stock_transactions itself — and is listed here with why.
//
// The count per file is a fingerprint: a new balance read in a listed file
// changes it, and the test asks for the new reader to be classified too.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const READS = [
  // The view as an argument — read or joined: .from(stockBalances),
  // .leftJoin(stockBalances, eq(…)), across lines too.
  /\(\s*stockBalances\s*[,)]/g,
  // The view interpolated into raw SQL.
  /\$\{\s*stockBalances\s*\}/g,
  // A balance summed straight from the log.
  /sum\(\s*\$\{stockTransactions\.quantityDelta\}/g,
  // The same in raw SQL.
  /\b(?:from|join)\s+"?stock_balances"?/gi,
  /sum\(\s*(?:\w+\.)?"?quantity_delta"?\s*\)/gi,
];

const ALLOWED: Record<string, { reads: number; why: string }> = {
  "modules/stock/repository/on-hand.ts": { reads: 1, why: "THE usable reader (onHandByArticle)" },
  "modules/stock/repository/stock.repository.ts": {
    reads: 7,
    why: "physical: getBalances (rows + count, with locationBlocked), balancesForArticles (with blocked), the transfer's overdraw check on one place, the log's running balance, the block response's articles with stock on the place, the lagerplatsregister's sums per place and unit",
  },
  "modules/stock/repository/article-locations.ts": {
    reads: 1,
    why: "physical per place: the Lager tab's Lagerplatser card shows the article's balance on each of its places",
  },
  "modules/stock/repository/stock-count.repository.ts": {
    reads: 3,
    why: "physical per place: the count freezes and lists what stands on the shelf",
  },
  "modules/stock/service/location-lifecycle.ts": { reads: 1, why: "physical per place: locationHoldsStock" },
  "modules/stock/service/outflow-locations.ts": {
    reads: 2,
    why: "per-place balances for Automatiskt; a blocked place is a skipped candidate there",
  },
  "modules/stock/service/valuation.service.ts": { reads: 1, why: "physical: a blocked place is valued as usual (decided)" },
  "modules/alerts/repository/alerts.repository.ts": {
    reads: 1,
    why: "physical: Negativt saldo is a bookkeeping error whatever the place",
  },
  "modules/planning/repository/planning.repository.ts": {
    reads: 1,
    why: "log reader: förbrukning per månad for the prognos (#10) — the net sales_delivery/mo_consumption outflows, not a stock balance",
  },
  "modules/costing/repository/work-in-progress.repository.ts": {
    reads: 2,
    why: "log reader: net material drawn per TO, not a stock balance",
  },
  "modules/import/repository/stock-balances.ts": { reads: 2, why: "physical per place: the saldoimport's 'saldot efter'" },
  "modules/manufacturing/repository/manufacturing.repository.ts": {
    reads: 1,
    why: "physical per place: Ångra rapportering takes the goods back from where they were put",
  },
  "modules/purchase/repository/purchase.repository.ts": {
    reads: 1,
    why: "physical per place: Ångra inleverans takes the goods back from where they were put",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Comments do not read anything ("derived from stock_balances").
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function readsIn(text: string): number {
  const body = code(text);
  return READS.reduce((n, pattern) => n + (body.match(pattern)?.length ?? 0), 0);
}

describe("stock balance readers", () => {
  const found = new Map(
    sourceFiles(SRC)
      .map((path) => [relative(SRC, path).split("\\").join("/"), readsIn(readFileSync(path, "utf8"))] as const)
      .filter(([, reads]) => reads > 0)
  );

  it("every reader is onHandByArticle or listed as physical with a reason", () => {
    const unlisted = [...found.keys()].filter((file) => !(file in ALLOWED));
    expect(unlisted, "a new balance reader: use onHandByArticle for usable stock, or list it here as physical with why").toEqual([]);
  });

  it("each listed file still reads as many balances as it was classified with", () => {
    const changed = Object.entries(ALLOWED)
      .filter(([file, entry]) => (found.get(file) ?? 0) !== entry.reads)
      .map(([file, entry]) => `${file}: listed ${entry.reads}, found ${found.get(file) ?? 0}`);
    expect(changed, "classify the new or removed reads, then update the count").toEqual([]);
  });

  it("the patterns see a reader (the guard is not blind)", () => {
    expect(readsIn("db.select().from(stockBalances)")).toBe(1);
    expect(readsIn("sql`sum(${stockTransactions.quantityDelta})`")).toBe(1);
    expect(readsIn("sql`select sum(t.quantity_delta) from stock_transactions t`")).toBe(1);
    expect(readsIn("sql`select * from stock_balances`")).toBe(1);
    // A join with its condition, on one line and spread over several.
    expect(readsIn("db.select().from(articles).leftJoin(stockBalances, eq(stockBalances.articleId, articles.id))")).toBe(1);
    expect(readsIn("db.select().from(articles)\n  .innerJoin(\n    stockBalances,\n    eq(stockBalances.articleId, articles.id)\n  )")).toBe(1);
    expect(readsIn("sql`select sum(b.quantity_on_hand) from ${stockBalances} b`")).toBe(1);
    // A column of the view is no read of its own (the from/join is).
    expect(readsIn("eq(stockBalances.articleId, articles.id)")).toBe(0);
    expect(readsIn("// derived from stock_balances")).toBe(0);
  });
});
