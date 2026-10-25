import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bankReconciliationRoutes } from "../src/modules/banking/routes/bank-reconciliation.routes.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import {
  BANK_YEAR,
  buildBankReconciliationService,
  buildRouteApp,
  fixtureXml,
  multipartFile,
  multipartWithFields,
  resetBankSettings,
  resetBanking,
  setupBanking,
  snapshotCompany,
} from "./helpers/banking.js";
import { camt053File } from "./helpers/camt053.js";

// The contract (etapp4-kontrakt.md) as the web sees it: status codes, error
// codes and response shapes per route; the permission is Ekonomi throughout.

const service = buildBankReconciliationService();
let userId: string;
let restoreCompany: () => Promise<void>;
const SWEDBANK = "821491234567890";
const NIL = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  userId = (await setupBanking()).user.id;
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
});

const asUser = (permissions: string[]) => buildRouteApp(bankReconciliationRoutes, { service }, { id: userId, role: "user", permissions });
const ekonomi = () => asUser(["ekonomi"]);

async function createAccount(identifier = SWEDBANK) {
  const res = await ekonomi().inject({ method: "POST", url: "/bank-accounts", payload: { name: "Företagskonto", identifier, ledgerAccount: "1930" } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function accountId(number: string) {
  return (await testEconomyRepository.findAccountByNumber(number))!.id;
}

describe("behörighet", () => {
  it("every route is Ekonomi's — other menus get 403", async () => {
    const other = asUser(["inkop", "forsaljning"]);
    expect((await other.inject({ method: "GET", url: "/bank-accounts" })).statusCode).toBe(403);
    expect((await other.inject({ method: "POST", url: "/bank-accounts", payload: {} })).statusCode).toBe(403);
    expect((await other.inject({ method: "GET", url: `/bank-reconciliation?bankAccountId=${NIL}&from=2024-10-01&to=2024-10-31` })).statusCode).toBe(403);
    expect((await other.inject({ method: "POST", url: "/bank-matches", payload: {} })).statusCode).toBe(403);
    expect((await other.inject({ method: "GET", url: "/bank-rules" })).statusCode).toBe(403);
    expect((await other.inject({ method: "POST", url: "/bank-reconciliations", payload: {} })).statusCode).toBe(403);
    expect((await other.inject({ method: "POST", url: "/bank-statements/preview", ...multipartFile("x.xml", "<x/>") })).statusCode).toBe(403);
  });
});

describe("/bank-accounts", () => {
  it("lists, creates (normalised, unique) and patches", async () => {
    expect((await ekonomi().inject({ method: "GET", url: "/bank-accounts" })).json()).toEqual({ rows: [], total: 0 });
    const created = await ekonomi().inject({ method: "POST", url: "/bank-accounts", payload: { name: "Konto", identifier: "se45 5000 0000 0583 9825 7466", ledgerAccount: "1930", csvMapping: { dateColumn: "Datum", amountColumn: "Belopp", textColumn: "Text" } } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ identifier: "SE4550000000058398257466", ledgerAccount: "1930", ledgerAccountName: "Företagskonto/checkkonto", currency: "SEK", active: true, reconciledThrough: null, lastStatementDate: null, unmatchedCount: 0, csvMapping: { dateColumn: "Datum", amountColumn: "Belopp", textColumn: "Text" } });
    const dup = await ekonomi().inject({ method: "POST", url: "/bank-accounts", payload: { name: "Dubblett", identifier: "SE4550000000058398257466", ledgerAccount: "1930" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("bank-account-identifier-taken");
    const missing = await ekonomi().inject({ method: "POST", url: "/bank-accounts", payload: { name: "X", identifier: "123", ledgerAccount: "1999" } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("bank-account-ledger-missing");
    expect((await ekonomi().inject({ method: "POST", url: "/bank-accounts", payload: { name: "X", identifier: "123", ledgerAccount: "19" } })).statusCode).toBe(400);
    const patched = await ekonomi().inject({ method: "PATCH", url: `/bank-accounts/${created.json().id}`, payload: { active: false, csvMapping: null } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ active: false, csvMapping: null });
    expect((await ekonomi().inject({ method: "GET", url: "/bank-accounts" })).json().total).toBe(0);
    expect((await ekonomi().inject({ method: "GET", url: "/bank-accounts?includeInactive=true" })).json().total).toBe(1);
    expect((await ekonomi().inject({ method: "PATCH", url: `/bank-accounts/${NIL}`, payload: { name: "X" } })).statusCode).toBe(404);
    expect((await ekonomi().inject({ method: "PATCH", url: "/bank-accounts/not-a-uuid", payload: { name: "X" } })).statusCode).toBe(400);
  });
});

describe("/bank-statements", () => {
  it("previews and imports a camt.053, answers 201 with the counts and 400 for bad files", async () => {
    const account = await createAccount();
    const preview = await ekonomi().inject({ method: "POST", url: "/bank-statements/preview", ...multipartFile("s.xml", fixtureXml("camt053-swedbank.xml")) });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ format: "camt.053", needsMapping: false, csvHeaders: null, unknownAccounts: [], blockers: [], statements: [{ bankAccountId: account.id, entryCount: 3, newEntryCount: 3, duplicateCount: 0 }] });
    expect(preview.json().statements[0].entries[0]).toEqual({ bookingDate: `${BANK_YEAR}-10-09`, valueDate: `${BANK_YEAR}-10-09`, amount: 26180, text: "BG INBETALNINGAR 551-2348", reference: null, counterparty: null, duplicate: false, ruleId: null });

    const imported = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartWithFields("s.xml", fixtureXml("camt053-swedbank.xml"), { autoMatch: "false" }) });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ bankFileId: expect.any(String), imported: 3, duplicates: 0, autoMatched: 0, autoBooked: 0, warnings: [], statements: [{ id: expect.any(String), bankAccountId: account.id, from: `${BANK_YEAR}-10-09`, to: `${BANK_YEAR}-10-09` }] });
    const again = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartWithFields("s.xml", fixtureXml("camt053-swedbank.xml"), {}) });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ bankFileId: imported.json().bankFileId, imported: 0, duplicates: 3 });

    const camt054 = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartFile("n.xml", fixtureXml("camt054-swedbank-credit.xml")) });
    expect(camt054.statusCode).toBe(400);
    expect(camt054.json().code).toBe("bank-statement-format");
    const bad = await ekonomi().inject({ method: "POST", url: "/bank-statements/preview", ...multipartFile("x.xml", "<!DOCTYPE x><x/>") });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("bank-file-parse");
    const noFile = await ekonomi().inject({ method: "POST", url: "/bank-statements/preview", payload: Buffer.from("------x--\r\n"), headers: { "content-type": "multipart/form-data; boundary=----x" } });
    expect(noFile.statusCode).toBe(400);
    const unknown = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartFile("u.xml", camt053File({ messageId: "U", statements: [{ bban: "999", closing: { amount: 0, date: `${BANK_YEAR}-10-09` }, entries: [] }] })) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("bank-account-required");
    const badJson = await ekonomi().inject({ method: "POST", url: "/bank-statements/preview", ...multipartWithFields("k.csv", "a;b", { bankAccountId: account.id, csvMapping: "{not json" }, "text/csv") });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().code).toBe("validation-failed");
  });

  it("CSV: the mapping travels as JSON and the account id as a field", async () => {
    const account = await createAccount();
    const csv = ["Datum;Text;Belopp", `${BANK_YEAR}-10-09;AVGIFT;-150,00`].join("\n");
    const needs = await ekonomi().inject({ method: "POST", url: "/bank-statements/preview", ...multipartWithFields("k.csv", csv, { bankAccountId: account.id }, "text/csv") });
    expect(needs.json()).toMatchObject({ format: "csv", needsMapping: true, csvHeaders: ["Datum", "Text", "Belopp"] });
    // Läs om rubriker: a draft mapping with the delimiter alone (the columns
    // empty) re-reads the header row with that delimiter — never 400.
    const reread = await ekonomi().inject({ method: "POST", url: "/bank-statements/preview", ...multipartWithFields("k.csv", csv, { bankAccountId: account.id, csvMapping: JSON.stringify({ delimiter: ",", skipRows: 0, dateColumn: "", amountColumn: "", textColumn: "" }) }, "text/csv") });
    expect(reread.statusCode).toBe(200);
    expect(reread.json()).toMatchObject({ format: "csv", needsMapping: true, csvHeaders: ["Datum;Text;Belopp"], statements: [] });
    const mapping = JSON.stringify({ dateColumn: "Datum", amountColumn: "Belopp", textColumn: "Text" });
    const imported = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartWithFields("k.csv", csv, { bankAccountId: account.id, csvMapping: mapping }, "text/csv") });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ imported: 1, duplicates: 0 });
    const wrong = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartWithFields("k.csv", csv, { bankAccountId: account.id, csvMapping: JSON.stringify({ dateColumn: "Dag", amountColumn: "Belopp", textColumn: "Text" }) }, "text/csv") });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("bank-statement-csv-mapping");
    const noAccount = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartWithFields("k.csv", csv, { csvMapping: mapping }, "text/csv") });
    expect(noAccount.statusCode).toBe(400);
    expect(noAccount.json().code).toBe("bank-account-required");
  });
});

describe("avstämning, matchning, bokföring, regler, avstämd t.o.m.", () => {
  it("runs the contract end to end", async () => {
    const account = await createAccount();
    const bank = await accountId("1930");
    const cost = await accountId("6570");
    const series = await testEconomyService.createSeries({ code: "A", name: "Manuella" });
    await testEconomyService.createVerification({ seriesId: series.id, date: `${BANK_YEAR}-10-09`, description: "Avgift", rows: [{ accountId: bank, debit: 0, credit: 150 }, { accountId: cost, debit: 150, credit: 0 }], book: true }, userId);
    await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartWithFields("s.xml", fixtureXml("camt053-swedbank.xml"), { autoMatch: "false" }) });

    const url = `/bank-reconciliation?bankAccountId=${account.id}&from=${BANK_YEAR}-10-01&to=${BANK_YEAR}-10-31`;
    let view = (await ekonomi().inject({ method: "GET", url })).json();
    expect(view).toMatchObject({
      bankAccount: { id: account.id, unmatchedCount: 3 },
      from: `${BANK_YEAR}-10-01`,
      to: `${BANK_YEAR}-10-31`,
      matches: [],
      reconciliations: [],
      changedAfterReconciliation: null,
      summary: { statementBalance: 107580, statementBalanceDate: `${BANK_YEAR}-10-09`, ledgerBalance: -150, unmatchedEntriesSum: 7580, unmatchedRowsSum: -150, difference: 107730, explained: false },
    });
    expect(view.statementEntries).toHaveLength(3);
    expect(view.statementEntries[2]).toMatchObject({ amount: -150, text: "AVGIFT KONTOUTDRAG", reference: null, counterparty: null, reversal: false, bankFileId: expect.any(String), ruleSuggestion: null, details: expect.any(Object) });
    expect(view.ledgerRows).toEqual([{ id: expect.any(String), verificationId: expect.any(String), verificationDisplayNumber: `A-${BANK_YEAR}-1`, date: `${BANK_YEAR}-10-09`, description: "Avgift", amount: -150 }]);
    expect(view.proposals).toEqual([{ entryIds: [view.statementEntries[2].id], rowIds: [view.ledgerRows[0].id], basis: "amount_date", ambiguous: false }]);
    expect((await ekonomi().inject({ method: "GET", url: `/bank-reconciliation?bankAccountId=${account.id}&from=2024-10-31&to=2024-10-01` })).statusCode).toBe(400);
    expect((await ekonomi().inject({ method: "GET", url: `/bank-reconciliation?bankAccountId=${NIL}&from=2024-10-01&to=2024-10-31` })).statusCode).toBe(404);

    // Matcha: sum mismatch, wrong account, success, already matched.
    const feeEntry = view.statementEntries[2].id;
    const feeRow = view.ledgerRows[0].id;
    const mismatch = await ekonomi().inject({ method: "POST", url: "/bank-matches", payload: { bankAccountId: account.id, entryIds: [view.statementEntries[0].id], verificationRowIds: [feeRow] } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: "bank-match-sum-mismatch", entriesSum: 26180, rowsSum: -150 });
    const other = await createAccount("OTHER1");
    const wrong = await ekonomi().inject({ method: "POST", url: "/bank-matches", payload: { bankAccountId: other.id, entryIds: [feeEntry], verificationRowIds: [feeRow] } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("bank-match-wrong-account");
    expect((await ekonomi().inject({ method: "POST", url: "/bank-matches", payload: { bankAccountId: account.id, entryIds: [], verificationRowIds: [] } })).statusCode).toBe(400);
    const matched = await ekonomi().inject({ method: "POST", url: "/bank-matches", payload: { bankAccountId: account.id, entryIds: [feeEntry], verificationRowIds: [feeRow] } });
    expect(matched.statusCode).toBe(201);
    expect(matched.json()).toMatchObject({ id: expect.any(String), kind: "manual", createdBy: userId, entries: [{ id: feeEntry, amount: -150 }], rows: [{ id: feeRow, amount: -150 }] });
    const again = await ekonomi().inject({ method: "POST", url: "/bank-matches", payload: { bankAccountId: account.id, entryIds: [feeEntry], verificationRowIds: [feeRow] } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("bank-match-already-matched");
    const auto = await ekonomi().inject({ method: "POST", url: "/bank-matches/auto", payload: { bankAccountId: account.id } });
    expect(auto.statusCode).toBe(200);
    expect(auto.json()).toEqual({ matched: 0, ambiguous: 0 });

    // Ångra.
    const undone = await ekonomi().inject({ method: "POST", url: `/bank-matches/${matched.json().id}/undo` });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().undoneAt).toEqual(expect.any(String));
    expect((await ekonomi().inject({ method: "POST", url: `/bank-matches/${matched.json().id}/undo` })).json().code).toBe("bank-match-already-undone");
    expect((await ekonomi().inject({ method: "POST", url: `/bank-matches/${NIL}/undo` })).statusCode).toBe(404);
    expect((await ekonomi().inject({ method: "POST", url: "/bank-matches/auto", payload: { bankAccountId: account.id } })).json()).toEqual({ matched: 1, ambiguous: 0 });

    // Bokför: mismatch 400, success 201 with verification + match.
    const payment = view.statementEntries[1].id;
    const bad = await ekonomi().inject({ method: "POST", url: `/bank-statement-entries/${payment}/book`, payload: { description: "Lev", rows: [{ accountId: bank, debit: 0, credit: 18000 }, { accountId: await accountId("2440"), debit: 18000, credit: 0 }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("bank-entry-book-mismatch");
    const booked = await ekonomi().inject({ method: "POST", url: `/bank-statement-entries/${payment}/book`, payload: { description: "Leverantörsbetalning", rows: [{ accountId: bank, debit: 0, credit: 18450 }, { accountId: await accountId("2440"), debit: 18450, credit: 0 }] } });
    expect(booked.statusCode).toBe(201);
    expect(booked.json()).toMatchObject({ verification: { id: expect.any(String), displayNumber: `B-${BANK_YEAR}-1` }, match: { kind: "created", entries: [{ id: payment }], rows: [{ amount: -18450, verificationDisplayNumber: `B-${BANK_YEAR}-1` }] } });
    expect((await ekonomi().inject({ method: "POST", url: `/bank-statement-entries/${NIL}/book`, payload: { description: "x", rows: [{ accountId: bank, debit: 1, credit: 0 }, { accountId: cost, debit: 0, credit: 1 }] } })).statusCode).toBe(404);
    expect((await ekonomi().inject({ method: "POST", url: `/bank-statement-entries/${payment}/book`, payload: { description: "x", rows: [] } })).statusCode).toBe(400);

    // Bankregler: seeded on the first GET, CRUD, book-by-rule per entry.
    const rules = await ekonomi().inject({ method: "GET", url: "/bank-rules" });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().total).toBe(5);
    expect(rules.json().rows[0]).toEqual({ id: expect.any(String), textContains: "avgift", direction: "both", accountNumber: "6570", accountName: "Bankkostnader", vatCode: null, description: "Bankavgift", autoBook: false, active: true, sortOrder: 10 });
    const rule = await ekonomi().inject({ method: "POST", url: "/bank-rules", payload: { textContains: "inbetalningar", direction: "in", accountNumber: "1510", vatCode: null, description: "Kundinbetalning" } });
    expect(rule.statusCode).toBe(201);
    expect(rule.json()).toMatchObject({ direction: "in", accountNumber: "1510", accountName: "Kundfordringar", autoBook: false, active: true, sortOrder: 60 });
    expect((await ekonomi().inject({ method: "POST", url: "/bank-rules", payload: { textContains: "x", accountNumber: "1999" } })).json().code).toBe("bank-rule-account-missing");
    expect((await ekonomi().inject({ method: "POST", url: "/bank-rules", payload: { textContains: "x", accountNumber: "5410", vatCode: "EUV" } })).statusCode).toBe(400);
    const patched = await ekonomi().inject({ method: "PATCH", url: `/bank-rules/${rule.json().id}`, payload: { autoBook: true, vatCode: "MP25" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ autoBook: true, vatCode: "MP25" });
    const byRule = await ekonomi().inject({ method: "POST", url: "/bank-statement-entries/book-by-rule", payload: { entryIds: [view.statementEntries[0].id, NIL] } });
    expect(byRule.statusCode).toBe(200);
    expect(byRule.json()).toEqual({
      booked: [{ entryId: view.statementEntries[0].id, verificationId: expect.any(String), displayNumber: `B-${BANK_YEAR}-2` }],
      failed: [{ entryId: NIL, error: { error: expect.any(String), code: "bank-statement-entry-not-found" } }],
    });
    expect((await ekonomi().inject({ method: "DELETE", url: `/bank-rules/${rule.json().id}` })).statusCode).toBe(204);
    expect((await ekonomi().inject({ method: "DELETE", url: `/bank-rules/${rule.json().id}` })).statusCode).toBe(404);
    expect((await ekonomi().inject({ method: "GET", url: "/bank-rules" })).json().total).toBe(5);

    // Avstämd t.o.m.: everything matched now, balances agree.
    view = (await ekonomi().inject({ method: "GET", url })).json();
    expect(view.statementEntries).toEqual([]);
    expect(view.ledgerRows).toEqual([]);
    expect(view.matches).toHaveLength(3);
    expect(view.summary).toMatchObject({ statementBalance: 107580, ledgerBalance: 7580, difference: 100000, explained: false });
    const early = await ekonomi().inject({ method: "POST", url: "/bank-reconciliations", payload: { bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-09` } });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "bank-reconciliation-incomplete", reason: "balance-mismatch", statementBalance: 107580, ledgerBalance: 7580 });
    expect((await ekonomi().inject({ method: "POST", url: "/bank-reconciliations", payload: { bankAccountId: NIL, throughDate: `${BANK_YEAR}-10-09` } })).statusCode).toBe(404);
    expect((await ekonomi().inject({ method: "POST", url: "/bank-reconciliations", payload: { bankAccountId: account.id, throughDate: "9999-13-01" } })).statusCode).toBe(400);
  });

  it("marks Avstämd t.o.m. when everything up to the day is matched and the balances agree", async () => {
    const account = await createAccount();
    const bank = await accountId("1930");
    const series = await testEconomyService.createSeries({ code: "A", name: "Manuella" });
    await testEconomyService.createVerification({ seriesId: series.id, date: `${BANK_YEAR}-10-09`, description: "In", rows: [{ accountId: bank, debit: 500, credit: 0 }, { accountId: await accountId("1510"), debit: 0, credit: 500 }], book: true }, userId);
    const xml = camt053File({ messageId: "R-1", statements: [{ bban: SWEDBANK, closing: { amount: 500, date: `${BANK_YEAR}-10-09` }, entries: [{ direction: "credit", amount: 500, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "A1", addtlNtryInf: "Inbetalning" }] }] });
    const imported = await ekonomi().inject({ method: "POST", url: "/bank-statements/import", ...multipartFile("r.xml", xml) });
    expect(imported.json()).toMatchObject({ imported: 1, autoMatched: 1 });
    const marked = await ekonomi().inject({ method: "POST", url: "/bank-reconciliations", payload: { bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-09` } });
    expect(marked.statusCode).toBe(201);
    expect(marked.json()).toEqual({ id: expect.any(String), throughDate: `${BANK_YEAR}-10-09`, statementBalance: 500, ledgerBalance: 500, createdAt: expect.any(String), createdBy: userId });
    const view = (await ekonomi().inject({ method: "GET", url: `/bank-reconciliation?bankAccountId=${account.id}&from=${BANK_YEAR}-10-01&to=${BANK_YEAR}-10-31` })).json();
    expect(view.reconciliations).toEqual([marked.json()]);
    expect(view.bankAccount.reconciledThrough).toBe(`${BANK_YEAR}-10-09`);
    expect(view.summary).toMatchObject({ difference: 0, explained: true });
  });
});
