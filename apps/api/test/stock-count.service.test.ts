import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { updateStockCountRowSchema } from "@navet/shared";
import { auditLog, db, stockCountSessions, stockTransactions } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { assertLocationNotUnderCount } from "../src/modules/stock/service/count-guard.js";
import {
  DuplicateStockCountRowError,
  InactiveStockLocationError,
  LocationUnderStockCountError,
  StockCountAlreadyOpenError,
  StockCountNotFoundError,
  StockCountNotOpenError,
  StockLocationNotFoundError,
} from "../src/modules/stock/service/stock.errors.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockCountService } from "../src/modules/stock/service/stock-count.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testDocumentPdfService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const countRepo = createStockCountRepository(db);
const auditRepository = createAuditRepository(db);
const countService = createStockCountService({ repo: countRepo, audit: auditRepository });

// number_series is deliberately never truncated — the INV- counter must
// survive across tests and suites, same as the FS-/KO- counters.
const TRUNCATE = sql`TRUNCATE stock_count_rows, stock_count_sessions, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name, active: true });
}

// Bypasses authService.register (bootstrap-only) since transferStock only
// needs a valid user id for createdBy — same helper as stock.service.test.ts.
async function makeUser() {
  return authRepo.create({
    email: `frysvakt-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Lagerarbetare",
    role: "admin",
  });
}

async function makeArticle(number = "ART-1", standardCost?: string) {
  return articleService.createArticle({
    articleNumber: number,
    name: "Test Article",
    type: "purchased",
    unit: "st",
    active: true,
    ...(standardCost ? { standardCost: Number(standardCost) } : {}),
  });
}

// Raw session insert — used only by the guard tests below, which predate the
// repository (task 4 replaces this arrange step with repo.createSession).
async function rawSession(locationId: string, blocks: boolean, status: "open" | "posted" | "cancelled" = "open") {
  const [row] = await db
    .insert(stockCountSessions)
    .values({ countNumber: `INV-TEST-${crypto.randomUUID().slice(0, 8)}`, locationId, blocksTransactions: blocks, status })
    .returning();
  return row!;
}

describe("assertLocationNotUnderCount", () => {
  it("throws for an open blocking session on the location", async () => {
    const location = await makeLocation();
    await rawSession(location.id, true);
    await expect(assertLocationNotUnderCount(db, location.id)).rejects.toBeInstanceOf(
      LocationUnderStockCountError
    );
  });

  it("passes for a non-blocking open session", async () => {
    const location = await makeLocation();
    await rawSession(location.id, false);
    await expect(assertLocationNotUnderCount(db, location.id)).resolves.toBeUndefined();
  });

  it("passes for posted and cancelled blocking sessions", async () => {
    const location = await makeLocation();
    await rawSession(location.id, true, "posted");
    await rawSession(location.id, true, "cancelled");
    await expect(assertLocationNotUnderCount(db, location.id)).resolves.toBeUndefined();
  });

  it("passes for another location", async () => {
    const counted = await makeLocation("A1");
    const other = await makeLocation("B1");
    await rawSession(counted.id, true);
    await expect(assertLocationNotUnderCount(db, other.id)).resolves.toBeUndefined();
  });
});

describe("stock count sessions — create/list/get", () => {
  it("seeds rows for every non-zero balance on the location, with snapshots", async () => {
    const location = await makeLocation();
    const other = await makeLocation("B1");
    const a1 = await makeArticle("ART-1");
    const a2 = await makeArticle("ART-2");
    const a3 = await makeArticle("ART-3");
    // a1: 10 on the counted location, a2: netted to zero, a3: only elsewhere
    await stockService.recordTransaction({ articleId: a1.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    await stockService.recordTransaction({ articleId: a2.id, locationId: location.id, quantityDelta: 5, transactionType: "inventory_adjustment" });
    await stockService.recordTransaction({ articleId: a2.id, locationId: location.id, quantityDelta: -5, transactionType: "sales_delivery" });
    await stockService.recordTransaction({ articleId: a3.id, locationId: other.id, quantityDelta: 3, transactionType: "inventory_adjustment" });

    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    expect(session.countNumber.startsWith("INV-")).toBe(true);
    expect(session.status).toBe("open");

    const detail = await countRepo.getSession(session.id);
    expect(detail!.rows).toHaveLength(1);
    expect(detail!.rows[0]!.articleNumber).toBe("ART-1");
    expect(detail!.rows[0]!.snapshotQuantity).toBe("10.0000");
    expect(detail!.rows[0]!.countedQuantity).toBeNull();
    expect(detail!.rows[0]!.disturbed).toBe(false);
  });

  it("refuses a second open session on the same location, allows one after cancel", async () => {
    const location = await makeLocation();
    await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    await expect(
      countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null)
    ).rejects.toBeInstanceOf(StockCountAlreadyOpenError);
  });

  // The pre-check only sees committed sessions; the partial unique index is
  // the guarantee under races. Hold an uncommitted open session so the
  // pre-check passes, let createSession block on the index, then commit —
  // the 23505 must surface as StockCountAlreadyOpenError, not a raw 500.
  it("maps a create race lost on the unique index to StockCountAlreadyOpenError", async () => {
    const location = await makeLocation();

    let inserted!: () => void;
    const insertedP = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const releaseP = new Promise<void>((resolve) => (release = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.insert(stockCountSessions).values({
        countNumber: `INV-TEST-${crypto.randomUUID().slice(0, 8)}`,
        locationId: location.id,
        blocksTransactions: false,
        status: "open",
      });
      inserted();
      await releaseP;
    });

    await insertedP;
    const attempt = countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    // Give createSession time to pass the pre-check and block on the index,
    // then commit the held session to trigger the unique violation.
    setTimeout(release, 200);
    await expect(attempt).rejects.toBeInstanceOf(StockCountAlreadyOpenError);
    await holder;
  });

  it("rejects unknown and inactive locations", async () => {
    await expect(
      countRepo.createSession({ locationId: crypto.randomUUID(), blocksTransactions: false }, null)
    ).rejects.toBeInstanceOf(StockLocationNotFoundError);

    const warehouse = await stockService.createWarehouse({ name: "H", active: true });
    const inactive = await stockService.createLocation({ warehouseId: warehouse.id, name: "X1", active: true });
    await stockService.updateLocation(inactive.id, { active: false });
    await expect(
      countRepo.createSession({ locationId: inactive.id, blocksTransactions: false }, null)
    ).rejects.toBeInstanceOf(InactiveStockLocationError);
  });

  it("flags a row as disturbed when a transaction lands after the freeze", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: -2, transactionType: "sales_delivery" });

    const detail = await countRepo.getSession(session.id);
    expect(detail!.rows[0]!.disturbed).toBe(true);
    // The snapshot does NOT move — it is the freeze-time balance.
    expect(detail!.rows[0]!.snapshotQuantity).toBe("10.0000");
  });

  it("getSession returns rowCount/countedCount alongside the header", async () => {
    const location = await makeLocation();
    const a1 = await makeArticle("ART-A");
    const a2 = await makeArticle("ART-B");
    await stockService.recordTransaction({ articleId: a1.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    await stockService.recordTransaction({ articleId: a2.id, locationId: location.id, quantityDelta: 5, transactionType: "inventory_adjustment" });

    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    const seeded = await countRepo.getSession(session.id);
    expect(seeded!.rowCount).toBe(2);
    expect(seeded!.countedCount).toBe(0);

    await countRepo.updateRow(session.id, seeded!.rows[0]!.id, { countedQuantity: 10 });

    const detail = await countRepo.getSession(session.id);
    expect(detail!.rowCount).toBe(2);
    expect(detail!.countedCount).toBe(1);
  });

  it("lists sessions with row/counted counts and a status filter", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    const list = await countRepo.listSessions({ limit: 50, offset: 0, status: undefined, search: undefined });
    expect(list.total).toBe(1);
    expect(list.rows[0]!.id).toBe(session.id);
    expect(list.rows[0]!.rowCount).toBe(1);
    expect(list.rows[0]!.countedCount).toBe(0);
    expect(list.rows[0]!.blocksTransactions).toBe(true);

    const none = await countRepo.listSessions({ limit: 50, offset: 0, status: ["posted"], search: undefined });
    expect(none.total).toBe(0);
  });
});

describe("stock count rows + posting", () => {
  // Unique article number per call — the state-machine test below opens two
  // sessions in one test, and a hardcoded number would collide (409).
  async function openSessionWithBalance(qty = 10, standardCost?: string) {
    const location = await makeLocation();
    const article = await makeArticle(`ART-${crypto.randomUUID().slice(0, 8)}`, standardCost);
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: qty, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    return { location, article, session };
  }

  it("addRow snapshots the current (zero) balance and refuses duplicates", async () => {
    const { session } = await openSessionWithBalance();
    const found = await makeArticle("ART-FOUND");
    const row = await countRepo.addRow(session.id, { articleId: found.id });
    // numeric(14,4) — Postgres formats to the column's scale on read, so a
    // zero balance comes back "0.0000", not the bare "0" written server-side.
    expect(row.snapshotQuantity).toBe("0.0000");
    await expect(countRepo.addRow(session.id, { articleId: found.id })).rejects.toBeInstanceOf(
      DuplicateStockCountRowError
    );
  });

  it("updateRow sets, clears and re-sets countedQuantity", async () => {
    const { session } = await openSessionWithBalance();
    const detail = await countRepo.getSession(session.id);
    const rowId = detail!.rows[0]!.id;
    const set = await countRepo.updateRow(session.id, rowId, { countedQuantity: 8 });
    // Same numeric(14,4) read-scale formatting as above.
    expect(set.countedQuantity).toBe("8.0000");
    const cleared = await countRepo.updateRow(session.id, rowId, { countedQuantity: null });
    expect(cleared.countedQuantity).toBeNull();
  });

  it("posting books diffs with sign, reference, note and unit_cost; skips uncounted and zero-diff", async () => {
    const location = await makeLocation();
    const aDown = await makeArticle("ART-NER");            // 10 counted 7 → -3, no unit_cost
    const aUp = await makeArticle("ART-UPP", "25.5000");   // 5 counted 9 → +4, unit_cost = standard
    const aSame = await makeArticle("ART-LIKA");           // 6 counted 6 → no row
    const aSkip = await makeArticle("ART-SKIP");           // uncounted → no row
    for (const [article, qty] of [[aDown, 10], [aUp, 5], [aSame, 6], [aSkip, 4]] as const) {
      await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: qty, transactionType: "inventory_adjustment" });
    }
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    const detail = await countRepo.getSession(session.id);
    const rowFor = (articleId: string) => detail!.rows.find((r) => r.articleId === articleId)!;
    await countRepo.updateRow(session.id, rowFor(aDown.id).id, { countedQuantity: 7, note: "trasig låda" });
    await countRepo.updateRow(session.id, rowFor(aUp.id).id, { countedQuantity: 9 });
    await countRepo.updateRow(session.id, rowFor(aSame.id).id, { countedQuantity: 6 });

    const result = await countRepo.postSession(session.id, null);
    expect(result.session.status).toBe("posted");
    expect(result.session.postedAt).not.toBeNull();
    expect(result.counted).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.adjustments).toBe(2);

    const booked = await db
      .select()
      .from(stockTransactions)
      .where(eq(stockTransactions.referenceId, session.id));
    expect(booked).toHaveLength(2);
    const down = booked.find((t) => t.articleId === aDown.id)!;
    // stock_transactions.quantity_delta is also numeric(14,4) — same
    // read-scale padding as snapshotQuantity/countedQuantity above.
    expect(down.quantityDelta).toBe("-3.0000");
    expect(down.transactionType).toBe("inventory_adjustment");
    expect(down.unitCost).toBeNull();
    expect(down.note).toContain(session.countNumber);
    expect(down.note).toContain("trasig låda");
    const up = booked.find((t) => t.articleId === aUp.id)!;
    expect(up.quantityDelta).toBe("4.0000");
    expect(up.unitCost).toBe("25.5000");

    // Balance after posting = counted quantity.
    const balances = await stockService.getBalances({ articleId: aDown.id, limit: 50, offset: 0 });
    expect(balances.rows[0]!.quantityOnHand).toBe("7.0000");
  });

  it("posting everything to zero empties and deactivates the location", async () => {
    const { location, session } = await openSessionWithBalance(10);
    const detail = await countRepo.getSession(session.id);
    await countRepo.updateRow(session.id, detail!.rows[0]!.id, { countedQuantity: 0 });
    await countRepo.postSession(session.id, null);
    const locations = await stockService.listLocations({ includeInactive: true });
    expect(locations.find((l) => l.id === location.id)!.active).toBe(false);
  });

  it("post/cancel state machine: only from open, mutations refused after", async () => {
    const { session } = await openSessionWithBalance();
    await countRepo.cancelSession(session.id);
    await expect(countRepo.postSession(session.id, null)).rejects.toBeInstanceOf(StockCountNotOpenError);
    await expect(countRepo.addRow(session.id, { articleId: crypto.randomUUID() })).rejects.toBeInstanceOf(
      StockCountNotOpenError
    );

    const second = await openSessionWithBalance();
    const detail = await countRepo.getSession(second.session.id);
    await countRepo.updateRow(second.session.id, detail!.rows[0]!.id, { countedQuantity: 5 });
    await countRepo.postSession(second.session.id, null);
    await expect(countRepo.cancelSession(second.session.id)).rejects.toBeInstanceOf(StockCountNotOpenError);
    await expect(
      countRepo.updateRow(second.session.id, detail!.rows[0]!.id, { countedQuantity: 6 })
    ).rejects.toBeInstanceOf(StockCountNotOpenError);
  });

  it("cancelled sessions book nothing", async () => {
    const { session } = await openSessionWithBalance();
    await countRepo.cancelSession(session.id);
    const booked = await db.select().from(stockTransactions).where(eq(stockTransactions.referenceId, session.id));
    expect(booked).toHaveLength(0);
  });

  it("reactivates a location that was auto-deactivated mid-session before booking the count", async () => {
    const { location, article, session } = await openSessionWithBalance(10);

    // A delivery empties the location mid-session (non-blocking session, so
    // this is allowed) — deactivateEmptyLocation flips it inactive.
    await stockService.recordTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: -10,
      transactionType: "sales_delivery",
    });
    const emptied = await stockService.listLocations({ includeInactive: true });
    expect(emptied.find((l) => l.id === location.id)!.active).toBe(false);

    // postSession books diff = counted - snapshot (the FROZEN snapshot, not
    // the current balance) — counted = 12 against the frozen snapshot of 10
    // gives diff = +2, a real booking to exercise the reactivation fix.
    const detail = await countRepo.getSession(session.id);
    await countRepo.updateRow(session.id, detail!.rows[0]!.id, { countedQuantity: 12 });
    await countRepo.postSession(session.id, null);

    const booked = await db.select().from(stockTransactions).where(eq(stockTransactions.referenceId, session.id));
    expect(booked).toHaveLength(1);
    expect(booked[0]!.quantityDelta).toBe("2.0000");

    const locations = await stockService.listLocations({ includeInactive: true });
    expect(locations.find((l) => l.id === location.id)!.active).toBe(true);

    const balances = await stockService.getBalances({ articleId: article.id, limit: 50, offset: 0 });
    expect(balances.rows[0]!.quantityOnHand).toBe("2.0000");
  });

  it("posted sessions are not disturbed by their own adjustments, and the postedAt cap excludes later ones", async () => {
    const { location, article, session } = await openSessionWithBalance(10);
    const detail = await countRepo.getSession(session.id);
    await countRepo.updateRow(session.id, detail!.rows[0]!.id, { countedQuantity: 7 });
    await countRepo.postSession(session.id, null);

    // Own posted adjustment (referenceId === session.id) must not flag the row.
    const afterPost = await countRepo.getSession(session.id);
    expect(afterPost!.rows[0]!.disturbed).toBe(false);

    // A later, unrelated transaction on the same (article, location) lands
    // after postedAt — the disturbed flag is capped at posted_at, so it must
    // still read false.
    await stockService.recordTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 2,
      transactionType: "inventory_adjustment",
    });
    const afterLater = await countRepo.getSession(session.id);
    expect(afterLater!.rows[0]!.disturbed).toBe(false);
  });
});

describe("stock count service", () => {
  it("getSession throws StockCountNotFoundError for unknown id", async () => {
    await expect(countService.getSession(crypto.randomUUID())).rejects.toBeInstanceOf(StockCountNotFoundError);
  });
});

// G1: postSession/cancelSession are the only stock-count writes that go
// through the audit trail — plain stock_transactions (posted diffs included)
// are NOT audited a second time (see stock-count.service.ts's comment: the
// ledger already has its own created_by). entityId is the session's INV-
// number, the readable "document number" for a stock count.
describe("stock count service — audit log", () => {
  it("logs postSession with the diff count and the acting user, entityId = INV number", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    const user = await makeUser();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    const session = await countService.createSession({ locationId: location.id, blocksTransactions: false }, user.id);
    const detail = await countService.getSession(session.id);
    await countService.updateRow(session.id, detail!.rows[0]!.id, { countedQuantity: 7 });

    await countService.postSession(session.id, user.id);

    const rows = await auditRows("stock_count_session", "posted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(session.countNumber);
    expect(rows[0]!.userId).toBe(user.id);
    expect(rows[0]!.detail).toEqual({ adjustments: 1, counted: 1, skipped: 0 });
  });

  it("logs cancelSession with the acting user, entityId = INV number", async () => {
    const location = await makeLocation();
    const user = await makeUser();
    const session = await countService.createSession({ locationId: location.id, blocksTransactions: false }, user.id);

    await countService.cancelSession(session.id, user.id);

    const rows = await auditRows("stock_count_session", "cancelled");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(session.countNumber);
    expect(rows[0]!.userId).toBe(user.id);
  });
});

describe("frysvakten i skrivarna", () => {
  it("blocks adjustments on a blocked location, allows them without spärr and after cancel", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    await expect(
      stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment" })
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);

    await countRepo.cancelSession(session.id);
    await expect(
      stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment" })
    ).resolves.toBeDefined();
  });

  it("blocks transfers touching the counted location from either side", async () => {
    const counted = await makeLocation("A1");
    const free = await makeLocation("B1");
    const article = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: counted.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    await stockService.recordTransaction({ articleId: article.id, locationId: free.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    await countRepo.createSession({ locationId: counted.id, blocksTransactions: true }, null);

    const user = await makeUser();
    await expect(
      stockService.transferStock({ fromLocationId: counted.id, toLocationId: free.id, rows: [{ articleId: article.id, quantity: 1 }] }, user.id)
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
    await expect(
      stockService.transferStock({ fromLocationId: free.id, toLocationId: counted.id, rows: [{ articleId: article.id, quantity: 1 }] }, user.id)
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
  });

  it("a non-blocking session blocks nothing", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    await expect(
      stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: -1, transactionType: "sales_delivery" })
    ).resolves.toBeDefined();
  });
});

describe("räknelistan (PDF)", () => {
  it("renders blind by default and shows balances on request", async () => {
    const location = await makeLocation();
    const article = await makeArticle("ART-PDF");
    // An odd non-integer balance instead of the brief's plain 7 — a bare "7"
    // can coincidentally turn up in the printed date or count number, which
    // would make `not.toContain` brittle. 123.5 only ever appears in this
    // PDF as the rendered "123,50" balance figure.
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 123.5, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    const withPdf = createStockCountService({ repo: countRepo, pdf: testDocumentPdfService, audit: auditRepository });

    const blind = await withPdf.getCountSheetPdf(session.id, false);
    expect(blind.filename).toBe(`raknelista-${session.countNumber}.pdf`);
    const blindText = pdfText(blind.content);
    expect(blindText).toContain(session.countNumber);
    expect(blindText).toContain("ART-PDF");
    expect(blindText).toContain("Lagertransaktioner är spärrade under inventeringen.");
    expect(blindText).not.toContain("123,50"); // bokfört saldo göms vid blind räkning

    const open = await withPdf.getCountSheetPdf(session.id, true);
    expect(pdfText(open.content)).toContain("123,50");
  });

  it("omits the spärr line when the session does not block transactions", async () => {
    const location = await makeLocation();
    const article = await makeArticle("ART-PDF-2");
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);

    const withPdf = createStockCountService({ repo: countRepo, pdf: testDocumentPdfService, audit: auditRepository });
    const pdf = await withPdf.getCountSheetPdf(session.id, false);
    expect(pdfText(pdf.content)).not.toContain("spärrade");
  });
});

// Schema-level guard: the web always sends a number or null, but an external
// API consumer sending "" must get a 400 — coerced to 0 it would book the
// whole balance away at registration (same trap as postingVatRateSchema).
describe("updateStockCountRowSchema", () => {
  it("rejects blank countedQuantity instead of coercing it to 0", () => {
    expect(updateStockCountRowSchema.safeParse({ countedQuantity: "" }).success).toBe(false);
    expect(updateStockCountRowSchema.safeParse({ countedQuantity: "   " }).success).toBe(false);
  });

  it("still accepts null (clear), numbers and numeric strings", () => {
    expect(updateStockCountRowSchema.safeParse({ countedQuantity: null }).success).toBe(true);
    expect(updateStockCountRowSchema.safeParse({ countedQuantity: 5 }).success).toBe(true);
    expect(updateStockCountRowSchema.safeParse({ countedQuantity: "5" }).success).toBe(true);
    expect(updateStockCountRowSchema.safeParse({ countedQuantity: 0 }).success).toBe(true);
  });
});
