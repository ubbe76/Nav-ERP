import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, bankFiles, bankStatementEntries, companyInfo, costCenters, db, verificationRows } from "@navet/db";
import { bookBankEntrySchema, ignoreBankStatementEntriesSchema, unignoreBankStatementEntriesSchema } from "@navet/shared";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createAlertsService } from "../src/modules/alerts/service/alerts.service.js";
import { unreconciledBankAccountsAsOf } from "../src/modules/banking/repository/bank-reconciliation.repository.js";
import { bankFileRoutes } from "../src/modules/banking/routes/bank-file.routes.js";
import { bankReconciliationRoutes } from "../src/modules/banking/routes/bank-reconciliation.routes.js";
import { bankFileInstant } from "../src/modules/banking/service/banking-dates.js";
import {
  BankReconciliationFutureDateError,
  BankReconciliationIncompleteError,
  BankStatementEntriesMixedAccountsError,
  BankStatementEntryIgnoredError,
  BankStatementEntryMatchedError,
  BankStatementEntryNotFoundError,
} from "../src/modules/banking/service/banking.errors.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import {
  BANK_YEAR,
  buildBankFileService,
  buildBankReconciliationService,
  buildRouteApp,
  configureSwedbank,
  fixtureXml,
  multipartFile,
  resetBankSettings,
  resetBanking,
  setupBanking,
  snapshotCompany,
} from "./helpers/banking.js";
import { camtFile } from "./helpers/camt.js";
import { camt053File, type Camt053Entry } from "./helpers/camt053.js";
import { parsed } from "./helpers/parsed.js";

// Bankgranskningen 2026-11-10: statements are not bank files (the camt.054
// module's rule is wider than Ekonomi's), Ignorera poster, Avstämd t.o.m.
// never in the future, and a zoneless CreDtTm is Swedish time. The suite's
// clock is CLOCK = 2024-10-09T10:00Z; the API suite itself runs in UTC.

const service = buildBankReconciliationService();
const fileService = buildBankFileService();
let userId: string;
let restoreCompany: () => Promise<void>;
const SWEDBANK = "821491234567890";
const NIL = "00000000-0000-4000-8000-000000000000";
const D = (day: string) => `${BANK_YEAR}-${day}`;

beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  await db.delete(costCenters);
  await db.update(companyInfo).set({ iban: null });
  userId = (await setupBanking()).user.id;
  seriesId = null;
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
  await db.delete(costCenters);
});

const filesAs = (permissions: string[]) => buildRouteApp(bankFileRoutes, { service: fileService }, { id: userId, role: "user", permissions });
const reconciliationAs = (permissions: string[]) => buildRouteApp(bankReconciliationRoutes, { service }, { id: userId, role: "user", permissions });

const uploadOf = (xml: string, filename = "stmt.xml") => ({ filename, contentType: "application/xml", data: Buffer.from(xml) });
const makeAccount = (identifier = SWEDBANK) => service.createAccount({ name: identifier === SWEDBANK ? "Företagskonto" : "Annat konto", identifier, ledgerAccount: "1930", currency: "SEK", csvMapping: null }, userId);
const statementWith = (entries: Camt053Entry[], opts: { closing?: { amount: number; date: string }; bban?: string } = {}) =>
  camt053File({
    messageId: `T-${crypto.randomUUID().slice(0, 8)}`,
    statements: [{ bban: opts.bban ?? SWEDBANK, from: entries[0]?.bookingDate, to: entries[entries.length - 1]?.bookingDate, closing: opts.closing ?? { amount: 0, date: entries[entries.length - 1]!.bookingDate }, entries }],
  });

let seriesId: string | null = null;
async function accountId(number: string) {
  return (await testEconomyRepository.findAccountByNumber(number))!.id;
}
// A booked manual verification on 1930 (bankAmount > 0 = money in).
async function bookOnBank(date: string, bankAmount: number, counter = "6570") {
  seriesId ??= (await testEconomyService.createSeries({ code: "A", name: "Manuella" })).id;
  const bank = await accountId("1930");
  const other = await accountId(counter);
  const rows =
    bankAmount > 0
      ? [{ accountId: bank, debit: bankAmount, credit: 0 }, { accountId: other, debit: 0, credit: bankAmount }]
      : [{ accountId: bank, debit: 0, credit: -bankAmount }, { accountId: other, debit: -bankAmount, credit: 0 }];
  const booked = await testEconomyService.createVerification({ seriesId, date, description: "Manuell", rows, book: true }, userId);
  const [row] = await db.select({ id: verificationRows.id }).from(verificationRows).where(and(eq(verificationRows.verificationId, booked.id), eq(verificationRows.accountId, bank)));
  return row!.id;
}

const alertsAt = (today: string) =>
  createAlertsService({
    repo: createAlertsRepository(db),
    planning: { requirementProposals: async () => [], orderPlanSummaries: async () => new Map() },
    settings: { supplierInvoiceDays: async () => 7, quoteFollowupDays: async () => 7, batchExpiryDays: async () => 30 },
    today: () => today,
  });
const unreconciledCount = async (today: string) => (await alertsAt(today).computeAlerts(["bank_unreconciled"])).groups[0]!.count;

// The account reconciled from a Startpunkt (10-08, 100 000) with the Swedbank
// statement of 10-09 fully matched — and then a wrongly imported file: one
// entry before the Startpunkt and one on the statement day (net 0).
async function reconciledAccountWithStrays() {
  const account = await makeAccount();
  await bookOnBank(D("01-01"), 100000, "1510");
  await service.createOpening(account.id, { date: D("10-08"), statementBalance: 100000 }, userId);
  await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
  await bookOnBank(D("10-09"), 26180, "1510");
  await bookOnBank(D("10-09"), -18450, "2440");
  await bookOnBank(D("10-09"), -150);
  expect(await service.autoMatch({ bankAccountId: account.id }, userId)).toEqual({ matched: 3, ambiguous: 0 });
  const strayXml = statementWith(
    [
      { direction: "debit", amount: 999, bookingDate: D("10-05"), acctSvcrRef: "STRAY-EARLY", addtlNtryInf: "Fel fil tidig" },
      { direction: "credit", amount: 999, bookingDate: D("10-09"), acctSvcrRef: "STRAY-DAY", addtlNtryInf: "Fel fil" },
    ],
    { closing: { amount: 107580, date: D("10-09") } }
  );
  return { account, strayXml };
}

async function importStrays(strayXml: string) {
  const imported = await service.import(uploadOf(strayXml, "fel.xml"), { autoMatch: false }, userId);
  expect(imported.imported).toBe(2);
  const rows = await db.select({ id: bankStatementEntries.id, bookingDate: bankStatementEntries.bookingDate }).from(bankStatementEntries).where(eq(bankStatementEntries.bankFileId, imported.bankFileId)).orderBy(bankStatementEntries.bookingDate);
  return { early: rows[0]!.id, day: rows[1]!.id, bankFileId: imported.bankFileId };
}

describe("kontoutdrag är inte bankfiler", () => {
  it("a statement is neither listed nor downloadable under /bank-files, and its bytes uploaded there are refused as the wrong message type", async () => {
    await configureSwedbank();
    await makeAccount();
    const statement = fixtureXml("camt053-swedbank.xml");

    // Before any statement exists: a camt.053 under Bankfiler is the wrong message type.
    const fresh = await filesAs(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("kontoutdrag.xml", statement) });
    expect(fresh.statusCode).toBe(400);
    expect(fresh.json().code).toBe("unsupported-bank-message");

    const imported = await service.import(uploadOf(statement, "kontoutdrag.xml"), { autoMatch: false }, userId);
    const [stored] = await db.select({ id: bankFiles.id, direction: bankFiles.direction, messageType: bankFiles.messageType }).from(bankFiles).where(eq(bankFiles.id, imported.bankFileId));
    expect(stored).toMatchObject({ direction: "incoming", messageType: "camt.053.001.02" });

    // A user with only Inköp (the bank files' own rule) sees nothing of it.
    for (const permissions of [["inkop"], ["forsaljning"], ["ekonomi"]]) {
      const app = filesAs(permissions);
      expect((await app.inject({ method: "GET", url: "/bank-files" })).json()).toEqual({ rows: [], total: 0 });
      expect((await app.inject({ method: "GET", url: `/bank-files/${imported.bankFileId}` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/bank-files/${imported.bankFileId}/download` })).statusCode).toBe(404);
    }
    expect((await filesAs(["inkop"]).inject({ method: "GET", url: `/bank-files/${imported.bankFileId}/outgoing` })).statusCode).toBe(404);
    expect((await filesAs(["forsaljning"]).inject({ method: "GET", url: `/bank-files/${imported.bankFileId}/incoming` })).statusCode).toBe(404);

    // The same bytes again, now stored as a statement: still 400 — never
    // 200 "Filen är redan inläst" with the statement's metadata, never 500
    // on the sha256 index (the parser refuses before anything is written).
    const again = await filesAs(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("kontoutdrag.xml", statement) });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe("unsupported-bank-message");
    expect((await db.select({ id: bankFiles.id }).from(bankFiles)).length).toBe(1);

    // A CSV statement is hidden the same way.
    const csv = ["Datum;Text;Belopp", `${D("10-10")};AVGIFT;-150,00`].join("\n");
    const csvImport = await service.import({ filename: "k.csv", contentType: "text/csv", data: Buffer.from(csv) }, { bankAccountId: (await service.listAccounts(false)).rows[0]!.id, csvMapping: { dateColumn: "Datum", amountColumn: "Belopp", textColumn: "Text" }, autoMatch: false }, userId);
    expect((await filesAs(["inkop"]).inject({ method: "GET", url: `/bank-files/${csvImport.bankFileId}/download` })).statusCode).toBe(404);

    // camt.054 as before: stored once, listed, downloadable as XML.
    const notification = fixtureXml("camt054-swedbank-credit.xml");
    const first = await filesAs(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("avi.xml", notification) });
    expect(first.statusCode).toBe(201);
    const second = await filesAs(["forsaljning"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("avi.xml", notification) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false, file: { id: first.json().file.id } });
    const listed = (await filesAs(["inkop"]).inject({ method: "GET", url: "/bank-files" })).json();
    expect(listed).toMatchObject({ total: 1, rows: [{ id: first.json().file.id, messageType: "camt.054.001.02" }] });
    const download = await filesAs(["inkop"]).inject({ method: "GET", url: `/bank-files/${first.json().file.id}/download` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/xml");
  });
});

describe("ignorera poster", () => {
  it("the preview warns for new entries on or before the Startpunkt — the import is still allowed", async () => {
    const { account, strayXml } = await reconciledAccountWithStrays();
    const preview = await service.preview({ data: Buffer.from(strayXml) }, {});
    expect(preview.blockers).toEqual([]);
    expect(preview.statements[0]).toMatchObject({ bankAccountId: account.id, newEntryCount: 2, beforeOpening: { count: 1, from: D("10-05"), to: D("10-05"), openingDate: D("10-08") } });
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toContain(`1 post är daterad på eller före startpunkten ${D("10-08")} för Företagskonto (${D("10-05")})`);
    // Entries after the Startpunkt, or already imported ones, give no warning.
    const later = await service.preview({ data: Buffer.from(statementWith([{ direction: "credit", amount: 5, bookingDate: D("10-09"), acctSvcrRef: "LATER" }], { closing: { amount: 107585, date: D("10-09") } })) }, {});
    expect(later.statements[0]!.beforeOpening).toBeNull();
    expect(later.warnings).toEqual([]);
    await importStrays(strayXml);
    const again = await service.preview({ data: Buffer.from(strayXml) }, {});
    expect(again.statements[0]).toMatchObject({ newEntryCount: 0, duplicateCount: 2, beforeOpening: null });
    // Without a Startpunkt there is nothing to warn about.
    await makeAccount("OTHER123");
    const other = await service.preview({ data: Buffer.from(statementWith([{ direction: "credit", amount: 5, bookingDate: D("01-02"), acctSvcrRef: "O1" }], { bban: "OTHER123" })) }, {});
    expect(other.statements[0]!.beforeOpening).toBeNull();
  });

  it("an ignored entry leaves the guard, the summary, the alert and the year-end warning; it cannot be matched or booked; undo brings it back", async () => {
    const { account, strayXml } = await reconciledAccountWithStrays();
    const { early, day, bankFileId } = await importStrays(strayXml);
    const range = { bankAccountId: account.id, from: D("10-01"), to: D("10-31") };

    // The strays block the mark, count as unmatched and are alerted about.
    await expect(service.createReconciliation({ bankAccountId: account.id, throughDate: D("10-09") }, userId)).rejects.toMatchObject({ reason: "unmatched-entries", detail: { count: 2 } });
    let view = await service.reconciliationView(range);
    expect(view.statementEntries.map((e) => e.id).sort()).toEqual([early, day].sort());
    expect(view.imports).toEqual([{ bankFileId, filename: "fel.xml", importedAt: expect.any(Date), count: 2 }]);
    expect(view.ignoredEntries).toEqual([]);
    expect(view.bankAccount.unmatchedCount).toBe(2);
    expect(await unreconciledCount(D("10-25"))).toBe(2);
    expect((await unreconciledBankAccountsAsOf(db, D("10-09"))).map((a) => a.id)).toEqual([account.id]);

    // A matched entry cannot be ignored; nor entries of two accounts at once.
    const matchedEntry = view.matches.find((m) => m.kind === "auto")!.entries[0]!.id;
    await expect(service.ignoreEntries(parsed(ignoreBankStatementEntriesSchema, { entryIds: [day, matchedEntry], reason: "Fel fil" }), userId)).rejects.toBeInstanceOf(BankStatementEntryMatchedError);
    await makeAccount("OTHER123");
    // (Dated late, so the other account's entry stays out of the alert below.)
    const otherImport = await service.import(uploadOf(statementWith([{ direction: "credit", amount: 5, bookingDate: D("10-24"), acctSvcrRef: "O1" }], { bban: "OTHER123" })), { autoMatch: false }, userId);
    const [otherEntry] = await db.select({ id: bankStatementEntries.id }).from(bankStatementEntries).where(eq(bankStatementEntries.bankFileId, otherImport.bankFileId));
    await expect(service.ignoreEntries(parsed(ignoreBankStatementEntriesSchema, { entryIds: [day, otherEntry!.id], reason: "Fel fil" }), userId)).rejects.toBeInstanceOf(BankStatementEntriesMixedAccountsError);
    await expect(service.ignoreEntries(parsed(ignoreBankStatementEntriesSchema, { entryIds: [day, NIL], reason: "Fel fil" }), userId)).rejects.toBeInstanceOf(BankStatementEntryNotFoundError);
    // Nothing was stamped by the refused calls.
    expect((await db.select({ id: bankStatementEntries.id }).from(bankStatementEntries).where(and(inArray(bankStatementEntries.id, [early, day]), eq(bankStatementEntries.ignoreReason, "Fel fil")))).length).toBe(0);

    // Ignorera: stamped with reason and user, audited per entry.
    expect(await service.ignoreEntries(parsed(ignoreBankStatementEntriesSchema, { entryIds: [early, day], reason: "  Fel fil importerad  " }), userId)).toEqual({ ignored: 2 });
    const stamped = await db.select().from(bankStatementEntries).where(inArray(bankStatementEntries.id, [early, day]));
    for (const row of stamped) expect(row).toMatchObject({ ignoredBy: userId, ignoreReason: "Fel fil importerad", ignoredAt: new Date("2024-10-09T10:00:00Z") });
    const audited = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "bank_statement_entry"), eq(auditLog.action, "ignored")));
    expect(audited.map((a) => a.entityId).sort()).toEqual([early, day].sort());
    expect(audited[0]).toMatchObject({ userId, detail: { bankAccountId: account.id, reason: "Fel fil importerad" } });
    await expect(service.ignoreEntries(parsed(ignoreBankStatementEntriesSchema, { entryIds: [day], reason: "Igen" }), userId)).rejects.toBeInstanceOf(BankStatementEntryIgnoredError);

    // Out of the lists, the sums, the alert — and shown under Ignorerade poster.
    view = await service.reconciliationView(range);
    expect(view.statementEntries).toEqual([]);
    expect(view.imports).toEqual([]);
    expect(view.bankAccount.unmatchedCount).toBe(0);
    expect(view.summary).toMatchObject({ statementBalance: 107580, ledgerBalance: 107580, unmatchedEntriesSum: 0, difference: 0, explained: true });
    expect(view.ignoredEntries.map((e) => e.id).sort()).toEqual([early, day].sort());
    expect(view.ignoredEntries[0]).toMatchObject({ ignoreReason: "Fel fil importerad", ignoredBy: userId, ignoredByName: "Ekonomi", ignoredAt: new Date("2024-10-09T10:00:00Z") });
    expect(await unreconciledCount(D("10-25"))).toBe(0);

    // Neither matched (the two net to 0), nor booked, nor booked by a rule, nor proposed.
    await expect(service.createMatch({ bankAccountId: account.id, entryIds: [early, day], verificationRowIds: [] }, userId)).rejects.toBeInstanceOf(BankStatementEntryIgnoredError);
    const bookInput = parsed(bookBankEntrySchema, {
      description: "Fel fil",
      rows: [
        { accountId: await accountId("1930"), debit: 999, credit: 0 },
        { accountId: await accountId("6570"), debit: 0, credit: 999 },
      ],
    });
    await expect(service.bookEntry(day, bookInput, userId)).rejects.toBeInstanceOf(BankStatementEntryIgnoredError);
    const byRule = await service.bookByRule({ entryIds: [day] }, userId);
    expect(byRule).toMatchObject({ booked: [], failed: [{ entryId: day, error: { code: "bank-statement-entry-ignored" } }] });
    expect(await service.autoMatch({ bankAccountId: account.id }, userId)).toEqual({ matched: 0, ambiguous: 0 });
    expect(view.proposals).toEqual([]);

    // Avstämd t.o.m. goes through, the year-end warning is gone, and nothing
    // "changed after the reconciliation".
    const marked = await service.createReconciliation({ bankAccountId: account.id, throughDate: D("10-09") }, userId);
    expect(marked).toMatchObject({ throughDate: D("10-09"), statementBalance: 107580, ledgerBalance: 107580 });
    expect((await unreconciledBankAccountsAsOf(db, D("10-09"))).map((a) => a.id)).not.toContain(account.id);
    expect((await service.reconciliationView(range)).changedAfterReconciliation).toBeNull();

    // Ångra ignorering: open again — and idempotent.
    expect(await service.unignoreEntries(parsed(unignoreBankStatementEntriesSchema, { entryIds: [day] }), userId)).toEqual({ restored: 1 });
    expect(await service.unignoreEntries(parsed(unignoreBankStatementEntriesSchema, { entryIds: [day] }), userId)).toEqual({ restored: 0 });
    const [restored] = await db.select().from(bankStatementEntries).where(eq(bankStatementEntries.id, day));
    expect(restored).toMatchObject({ ignoredAt: null, ignoredBy: null, ignoreReason: null });
    const unaudited = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "bank_statement_entry"), eq(auditLog.action, "unignored")));
    expect(unaudited).toHaveLength(1);
    expect(unaudited[0]).toMatchObject({ entityId: day, userId, detail: { reason: "Fel fil importerad" } });
    view = await service.reconciliationView(range);
    expect(view.statementEntries.map((e) => e.id)).toEqual([day]);
    expect(view.ignoredEntries.map((e) => e.id)).toEqual([early]);
    expect(view.changedAfterReconciliation).toEqual({ through: D("10-09"), rows: 0, entries: 1 });
    expect(view.bankAccount.unmatchedCount).toBe(1);
    expect(await unreconciledCount(D("10-25"))).toBe(1);
  });

  it("the routes: Ekonomi only, 400 for another account's entry or a bad body, 404, 409", async () => {
    const { account, strayXml } = await reconciledAccountWithStrays();
    const { early, day } = await importStrays(strayXml);
    const ekonomi = reconciliationAs(["ekonomi"]);
    const post = (url: string, payload: unknown, app = ekonomi) => app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });

    for (const url of ["/bank-statement-entries/ignore", "/bank-statement-entries/unignore"]) {
      expect((await post(url, { entryIds: [day], reason: "x" }, reconciliationAs(["inkop", "forsaljning"]))).statusCode).toBe(403);
      expect((await post(url, { entryIds: [], reason: "x" })).statusCode).toBe(400);
      expect((await post(url, { entryIds: [day, day], reason: "x" })).statusCode).toBe(400);
      expect((await post(url, { entryIds: ["not-a-uuid"], reason: "x" })).statusCode).toBe(400);
      const missing = await post(url, { entryIds: [NIL], reason: "x" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("bank-statement-entry-not-found");
    }
    expect((await post("/bank-statement-entries/ignore", { entryIds: [day], reason: "   " })).statusCode).toBe(400);
    expect((await post("/bank-statement-entries/ignore", { entryIds: [day] })).statusCode).toBe(400);

    await makeAccount("OTHER123");
    const otherImport = await service.import(uploadOf(statementWith([{ direction: "credit", amount: 5, bookingDate: D("10-09"), acctSvcrRef: "O1" }], { bban: "OTHER123" })), { autoMatch: false }, userId);
    const [otherEntry] = await db.select({ id: bankStatementEntries.id }).from(bankStatementEntries).where(eq(bankStatementEntries.bankFileId, otherImport.bankFileId));
    for (const url of ["/bank-statement-entries/ignore", "/bank-statement-entries/unignore"]) {
      const mixed = await post(url, { entryIds: [day, otherEntry!.id], reason: "Fel fil" });
      expect(mixed.statusCode).toBe(400);
      expect(mixed.json()).toMatchObject({ code: "bank-statement-entries-mixed-accounts", error: expect.stringContaining("olika bankkonton") });
    }

    const view = (await ekonomi.inject({ method: "GET", url: `/bank-reconciliation?bankAccountId=${account.id}&from=${D("10-01")}&to=${D("10-31")}` })).json();
    const matchedEntry = view.matches.find((m: { kind: string }) => m.kind === "auto").entries[0].id;
    const matched = await post("/bank-statement-entries/ignore", { entryIds: [matchedEntry], reason: "Fel fil" });
    expect(matched.statusCode).toBe(409);
    expect(matched.json()).toMatchObject({ code: "bank-statement-entry-matched", error: expect.stringContaining("matchad") });

    const ignored = await post("/bank-statement-entries/ignore", { entryIds: [early, day], reason: "Fel fil" });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toEqual({ ignored: 2 });
    const twice = await post("/bank-statement-entries/ignore", { entryIds: [day], reason: "Fel fil" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("bank-statement-entry-ignored");
    const match = await post("/bank-matches", { bankAccountId: account.id, entryIds: [early, day], verificationRowIds: [] });
    expect(match.statusCode).toBe(409);
    expect(match.json()).toMatchObject({ code: "bank-statement-entry-ignored", error: expect.stringContaining("ignorerad") });
    const book = await post(`/bank-statement-entries/${day}/book`, {
      description: "Fel fil",
      rows: [
        { accountId: await accountId("1930"), debit: 999, credit: 0 },
        { accountId: await accountId("6570"), debit: 0, credit: 999 },
      ],
    });
    expect(book.statusCode).toBe(409);
    expect(book.json().code).toBe("bank-statement-entry-ignored");

    const after = (await ekonomi.inject({ method: "GET", url: `/bank-reconciliation?bankAccountId=${account.id}&from=${D("10-01")}&to=${D("10-31")}` })).json();
    expect(after.statementEntries).toEqual([]);
    expect(after.ignoredEntries).toHaveLength(2);
    expect(after.ignoredEntries[0]).toMatchObject({ ignoreReason: "Fel fil", ignoredByName: "Ekonomi", ignoredAt: expect.any(String) });
    const restored = await post("/bank-statement-entries/unignore", { entryIds: [early, day] });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ restored: 2 });
  });

  it("the table refuses a half-written stamp", async () => {
    const { strayXml } = await reconciledAccountWithStrays();
    const { day } = await importStrays(strayXml);
    await expect(db.update(bankStatementEntries).set({ ignoredAt: new Date() }).where(eq(bankStatementEntries.id, day))).rejects.toThrow();
    await expect(db.update(bankStatementEntries).set({ ignoreReason: "utan tid" }).where(eq(bankStatementEntries.id, day))).rejects.toThrow();
    await expect(db.update(bankStatementEntries).set({ ignoredAt: new Date(), ignoreReason: "  " }).where(eq(bankStatementEntries.id, day))).rejects.toThrow();
  });
});

describe("avstämd t.o.m. i framtiden", () => {
  it("a day after today (Stockholm) is refused with 400 before anything else is checked", async () => {
    const account = await makeAccount();
    const future = await service.createReconciliation({ bankAccountId: account.id, throughDate: D("10-10") }, userId).catch((err: unknown) => err);
    expect(future).toBeInstanceOf(BankReconciliationFutureDateError);
    expect(future).toMatchObject({ today: D("10-09"), message: expect.stringContaining("framtiden") });
    const res = await reconciliationAs(["ekonomi"]).inject({ method: "POST", url: "/bank-reconciliations", payload: { bankAccountId: account.id, throughDate: D("12-31") } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "bank-reconciliation-future-date", today: D("10-09") });
    expect(await unreconciledBankAccountsAsOf(db, D("10-09"))).toHaveLength(1);

    // Today itself passes the date guard (and is refused for its own reason).
    await expect(service.createReconciliation({ bankAccountId: account.id, throughDate: D("10-09") }, userId)).rejects.toBeInstanceOf(BankReconciliationIncompleteError);
    // 22:30 UTC is already the 10th in Stockholm: the 10th is today there,
    // although the process (UTC) still says the 9th.
    const lateEvening = buildBankReconciliationService(() => new Date(`${D("10-09")}T22:30:00Z`));
    await expect(lateEvening.createReconciliation({ bankAccountId: account.id, throughDate: D("10-10") }, userId)).rejects.toBeInstanceOf(BankReconciliationIncompleteError);
    await expect(lateEvening.createReconciliation({ bankAccountId: account.id, throughDate: D("10-11") }, userId)).rejects.toBeInstanceOf(BankReconciliationFutureDateError);
  });
});

describe("CreDtTm utan zon är svensk tid", () => {
  it("bankFileInstant reads a zoneless date-time as Stockholm's wall clock and a zoned one as it is", () => {
    expect(process.env.TZ).toBe("UTC");
    expect(bankFileInstant("2024-10-09T18:00:00")?.toISOString()).toBe("2024-10-09T16:00:00.000Z"); // sommartid
    expect(bankFileInstant("2024-01-15T08:15:00")?.toISOString()).toBe("2024-01-15T07:15:00.000Z"); // vintertid
    expect(bankFileInstant("2024-01-15T08:15")?.toISOString()).toBe("2024-01-15T07:15:00.000Z");
    expect(bankFileInstant("2024-01-15T08:15:00.250")?.toISOString()).toBe("2024-01-15T07:15:00.250Z");
    expect(bankFileInstant("2024-10-09T18:00:00Z")?.toISOString()).toBe("2024-10-09T18:00:00.000Z");
    expect(bankFileInstant("2024-10-10T02:15:00+02:00")?.toISOString()).toBe("2024-10-10T00:15:00.000Z");
    expect(bankFileInstant("2024-10-09T18:00:00.5-05:00")?.toISOString()).toBe("2024-10-09T23:00:00.500Z");
    expect(bankFileInstant(null)).toBeNull();
    expect(bankFileInstant("")).toBeNull();
    expect(bankFileInstant("i går")).toBeNull();
    expect(bankFileInstant("2024-10-09")).toBeNull();
    expect(bankFileInstant("2024-13-45T99:00:00Z")).toBeNull();
  });

  it("an uploaded camt.054 stores the bank's creation time in Swedish time", async () => {
    await configureSwedbank();
    // camtFile writes <CreDtTm>2024-10-09T18:00:00</CreDtTm> — no zone.
    const xml = camtFile({ messageId: "ZONLOS-1", entries: [{ direction: "credit", amount: 100, bookingDate: D("10-09"), txs: [{ amount: 100, acctSvcrRef: "Z1" }] }] });
    const res = await filesAs(["forsaljning"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("avi.xml", xml) });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.bankCreatedAt).toBe("2024-10-09T16:00:00.000Z");
    const [stored] = await db.select({ bankCreatedAt: bankFiles.bankCreatedAt }).from(bankFiles).where(eq(bankFiles.id, res.json().file.id));
    expect(stored!.bankCreatedAt?.toISOString()).toBe("2024-10-09T16:00:00.000Z");
  });
});
