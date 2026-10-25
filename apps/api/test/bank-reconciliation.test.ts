import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bankFiles, bankRules, bankStatementEntries, companyInfo, costCenters, customerPayments, customers, db, systemSettings, verificationRows, verifications } from "@navet/db";
import { createAlertsService } from "../src/modules/alerts/service/alerts.service.js";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { unreconciledBankAccountsAsOf } from "../src/modules/banking/repository/bank-reconciliation.repository.js";
import {
  BankAccountIdentifierLockedError,
  BankAccountIdentifierTakenError,
  BankAccountInUseError,
  BankAccountLedgerMissingError,
  BankAccountRequiredError,
  BankEntryBookMismatchError,
  BankOpeningBalanceMismatchError,
  BankOpeningNotAllowedError,
  BankMatchAlreadyMatchedError,
  BankMatchAlreadyUndoneError,
  BankMatchSumMismatchError,
  BankMatchWrongAccountError,
  BankReconciliationIncompleteError,
  BankRuleAmbiguousError,
  BankRuleMissingError,
  BankStatementCsvMappingError,
  BankStatementCurrencyError,
} from "../src/modules/banking/service/banking.errors.js";
import { createBankReconciliationService, UNEXPECTED_ERROR_TEXT } from "../src/modules/banking/service/bank-reconciliation.service.js";
import { createBankSettingsRepository } from "../src/modules/banking/repository/bank-settings.repository.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { evaluateWarnings } from "../src/modules/economy/service/year-end-checks.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import {
  BANK_YEAR,
  buildBankReconciliationService,
  fixtureXml,
  makeBankEntry,
  makeCustomer,
  periodStarting,
  resetBankSettings,
  resetBanking,
  setupBanking,
  snapshotCompany,
  testBankReconciliationRepository as repo,
} from "./helpers/banking.js";
import { camt053File, type Camt053Entry } from "./helpers/camt053.js";

// Bankavstämning against Postgres: import with duplicates, the matching
// under the account lock (concurrent matches of one entry), undo, Bokför
// (verification + match in one transaction), rules with Bokför direkt,
// Avstämd t.o.m. and the warning after a later change, the year-end warning
// and the alert. Dates live in BANK_YEAR (2024), far from the real calendar.

const service = buildBankReconciliationService();
let userId: string;
let restoreCompany: () => Promise<void>;
const SWEDBANK = "821491234567890";

beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  // Kostnadsställen are not in the banking truncate (other registers hang off them).
  await db.delete(costCenters);
  userId = (await setupBanking()).user.id;
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
  await db.delete(costCenters);
});

async function makeAccount(identifier = SWEDBANK, ledger = "1930") {
  return service.createAccount({ name: "Företagskonto", identifier, ledgerAccount: ledger, currency: "SEK", csvMapping: null }, userId);
}

const uploadOf = (xml: string, filename = "stmt.xml") => ({ filename, contentType: "application/xml", data: Buffer.from(xml) });

let seriesId: string | null = null;
async function manualSeries() {
  if (seriesId) return seriesId;
  seriesId = (await testEconomyService.createSeries({ code: "A", name: "Manuella" })).id;
  return seriesId;
}
afterAll(() => {
  seriesId = null;
});
beforeEach(() => {
  seriesId = null;
});

async function accountId(number: string) {
  const row = await testEconomyRepository.findAccountByNumber(number);
  if (!row) throw new Error(`account ${number} missing`);
  return row.id;
}

// A booked manual verification touching 1930: bankAmount > 0 = debit on
// 1930 (money in), < 0 = credit. Returns the 1930 row's id.
async function bookOnBank(date: string, bankAmount: number, counter = "6570", description = "Manuell") {
  const bank = await accountId("1930");
  const other = await accountId(counter);
  const rows =
    bankAmount > 0
      ? [{ accountId: bank, debit: bankAmount, credit: 0 }, { accountId: other, debit: 0, credit: bankAmount }]
      : [{ accountId: bank, debit: 0, credit: -bankAmount }, { accountId: other, debit: -bankAmount, credit: 0 }];
  const booked = await testEconomyService.createVerification({ seriesId: await manualSeries(), date, description, rows, book: true }, userId);
  const [row] = await db.select({ id: verificationRows.id }).from(verificationRows).where(and(eq(verificationRows.verificationId, booked.id), eq(verificationRows.accountId, bank)));
  return { verificationId: booked.id, rowId: row!.id, displayNumber: booked.displayNumber };
}

const statementWith = (entries: Camt053Entry[], opts: { messageId?: string; closing?: { amount: number; date: string }; bban?: string } = {}) =>
  camt053File({ messageId: opts.messageId ?? `T-${crypto.randomUUID().slice(0, 8)}`, statements: [{ bban: opts.bban ?? SWEDBANK, from: entries[0]?.bookingDate, to: entries[entries.length - 1]?.bookingDate, closing: opts.closing ?? { amount: 0, date: entries[entries.length - 1]?.bookingDate ?? `${BANK_YEAR}-10-09` }, entries }] });

describe("bankkonton", () => {
  it("the first GET creates an account from the company's IBAN and the Bank/betalkonto setting", async () => {
    await db.update(companyInfo).set({ iban: "SE45 5000 0000 0583 9825 7466" });
    const { rows, total } = await service.listAccounts(false);
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ name: "Företagskonto", identifier: "SE4550000000058398257466", ledgerAccount: "1930", ledgerAccountName: "Företagskonto/checkkonto", currency: "SEK", active: true, reconciledThrough: null, lastStatementDate: null, unmatchedCount: 0 });
    // Idempotent: a second GET does not create another.
    expect((await service.listAccounts(false)).total).toBe(1);
  });

  it("creates nothing without an IBAN, normalises identifiers and refuses duplicates and unknown ledger accounts", async () => {
    await db.update(companyInfo).set({ iban: null });
    expect((await service.listAccounts(false)).total).toBe(0);
    const created = await service.createAccount({ name: "Konto", identifier: "se45 5000-0000 0583 9825 7466", ledgerAccount: "1930", currency: "SEK" }, userId);
    expect(created.identifier).toBe("SE4550000000058398257466");
    await expect(service.createAccount({ name: "Dubblett", identifier: "SE4550000000058398257466", ledgerAccount: "1930", currency: "SEK" }, userId)).rejects.toBeInstanceOf(BankAccountIdentifierTakenError);
    await expect(service.createAccount({ name: "X", identifier: "123", ledgerAccount: "1999", currency: "SEK" }, userId)).rejects.toBeInstanceOf(BankAccountLedgerMissingError);
    const updated = await service.updateAccount(created.id, { active: false, name: "Gammalt" }, userId);
    expect(updated).toMatchObject({ active: false, name: "Gammalt" });
    expect((await service.listAccounts(false)).total).toBe(0);
    expect((await service.listAccounts(true)).total).toBe(1);
  });
});

describe("import av kontoutdrag", () => {
  it("imports the Swedbank fixture, skips the same file as duplicates and reads an overlapping file's new entry only", async () => {
    const account = await makeAccount();
    const first = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    expect(first).toMatchObject({ imported: 3, duplicates: 0, autoMatched: 0, autoBooked: 0 });
    expect(first.statements).toEqual([{ id: expect.any(String), bankAccountId: account.id, from: `${BANK_YEAR}-10-09`, to: `${BANK_YEAR}-10-09` }]);

    const again = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml"), "igen.xml"), { autoMatch: false }, userId);
    expect(again).toMatchObject({ bankFileId: first.bankFileId, imported: 0, duplicates: 3 });

    // An overlapping statement: the fee again (same hash key) plus one new entry.
    const overlap = statementWith([
      { direction: "debit", amount: 150, bookingDate: `${BANK_YEAR}-10-09`, addtlNtryInf: "AVGIFT KONTOUTDRAG" },
      { direction: "credit", amount: 999, bookingDate: `${BANK_YEAR}-10-10`, acctSvcrRef: "NEW-1", addtlNtryInf: "Swish" },
    ]);
    const third = await service.import(uploadOf(overlap, "overlap.xml"), { autoMatch: false }, userId);
    expect(third).toMatchObject({ imported: 1, duplicates: 1 });
    expect(third.bankFileId).not.toBe(first.bankFileId);

    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.statementEntries.map((e) => [e.amount, e.text])).toEqual([
      [26180, "BG INBETALNINGAR 551-2348"],
      [-18450, "LEVERANTORSBETALNING"],
      [-150, "AVGIFT KONTOUTDRAG"],
      [999, "Swish"],
    ]);
    expect(view.summary).toMatchObject({ statementBalance: 0, statementBalanceDate: `${BANK_YEAR}-10-10` });
    expect((await service.listAccounts(false)).rows[0]).toMatchObject({ lastStatementDate: `${BANK_YEAR}-10-10`, unmatchedCount: 4 });
  });

  it("previews before import: duplicates, rule suggestions and the unknown-account blocker; import learns the identifier", async () => {
    const account = await makeAccount("OTHER123");
    await service.listRules(); // seeds the suggestions
    const preview = await service.preview({ data: Buffer.from(fixtureXml("camt053-swedbank.xml")) }, {});
    expect(preview).toMatchObject({ format: "camt.053", needsMapping: false, unknownAccounts: [SWEDBANK], csvHeaders: null });
    expect(preview.blockers).toEqual(["Kontoutdragets konto är okänt — välj vilket bankkonto det är"]);
    expect(preview.statements[0]).toMatchObject({ accountIdentifier: SWEDBANK, bankAccountId: null, entryCount: 3, newEntryCount: 3, duplicateCount: 0, openingBalance: 100000, closingBalance: 107580 });
    expect(preview.statements[0]!.entries[2]).toMatchObject({ amount: -150, text: "AVGIFT KONTOUTDRAG", duplicate: false, ruleId: expect.any(String) });
    expect(preview.statements[0]!.entries[0]!.ruleId).toBeNull();

    await expect(service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId)).rejects.toBeInstanceOf(BankAccountRequiredError);
    const withAccount = await service.preview({ data: Buffer.from(fixtureXml("camt053-swedbank.xml")) }, { bankAccountId: account.id });
    expect(withAccount.blockers).toEqual([]);
    expect(withAccount.statements[0]!.bankAccountId).toBe(account.id);

    const result = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { bankAccountId: account.id, autoMatch: false }, userId);
    expect(result.imported).toBe(3);
    expect(result.warnings).toContain(`Bankkontot Företagskonto fick identifieraren ${SWEDBANK} från filen`);
    expect((await service.getAccount(account.id)).identifier).toBe(SWEDBANK);

    const after = await service.preview({ data: Buffer.from(fixtureXml("camt053-swedbank.xml")) }, {});
    expect(after.statements[0]).toMatchObject({ bankAccountId: account.id, duplicateCount: 3, newEntryCount: 0 });
    expect(after.warnings).toContain("Alla poster i filen är redan inlästa");
  });

  it("refuses a statement in another currency", async () => {
    await makeAccount();
    const eur = camt053File({ messageId: "EUR-1", statements: [{ bban: SWEDBANK, currency: "EUR", closing: { amount: 0, date: `${BANK_YEAR}-10-09` }, entries: [{ direction: "credit", amount: 10, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "E" }] }] });
    await expect(service.import(uploadOf(eur), { autoMatch: false }, userId)).rejects.toBeInstanceOf(BankStatementCurrencyError);
    const preview = await service.preview({ data: Buffer.from(eur) }, {});
    expect(preview.blockers).toEqual(["Kontoutdraget är i EUR men bankkontot Företagskonto är i SEK"]);
  });

  it("imports a CSV with a mapping, saves the mapping on the account and needs it on the next preview no more", async () => {
    const account = await makeAccount();
    const csv = ["Bokföringsdag;Text;Belopp;Saldo", `${BANK_YEAR}-10-09;KORTKÖP;-899,00;107 580,00`, `${BANK_YEAR}-10-08;AVGIFT;-150,00;108 479,00`].join("\n");
    const noMapping = await service.preview({ data: Buffer.from(csv) }, { bankAccountId: account.id });
    expect(noMapping).toMatchObject({ format: "csv", needsMapping: true, csvHeaders: ["Bokföringsdag", "Text", "Belopp", "Saldo"], statements: [] });
    expect(noMapping.blockers).toHaveLength(1);
    expect((await service.preview({ data: Buffer.from(csv) }, {})).blockers).toContain("Välj vilket bankkonto filen gäller");
    await expect(service.import({ filename: "k.csv", contentType: "text/csv", data: Buffer.from(csv) }, { bankAccountId: account.id, autoMatch: false }, userId)).rejects.toBeInstanceOf(BankStatementCsvMappingError);

    const mapping = { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text", balanceColumn: "Saldo" };
    const result = await service.import({ filename: "k.csv", contentType: "text/csv", data: Buffer.from(csv) }, { bankAccountId: account.id, csvMapping: mapping, autoMatch: false }, userId);
    expect(result).toMatchObject({ imported: 2, duplicates: 0 });
    expect((await service.getAccount(account.id)).csvMapping).toEqual(mapping);
    const preview = await service.preview({ data: Buffer.from(csv) }, { bankAccountId: account.id });
    expect(preview).toMatchObject({ needsMapping: false });
    expect(preview.statements[0]).toMatchObject({ duplicateCount: 2, closingBalance: 107580 });
    // A draft mapping (columns unchosen) reads the headers with its own
    // delimiter and asks for the columns — the saved mapping is not used.
    const draft = await service.preview({ data: Buffer.from(csv) }, { bankAccountId: account.id, csvMapping: { delimiter: "\t" } });
    expect(draft).toMatchObject({ needsMapping: true, csvHeaders: ["Bokföringsdag;Text;Belopp;Saldo"], statements: [] });
    expect(draft.blockers).toHaveLength(1);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.summary).toMatchObject({ statementBalance: 107580, statementBalanceDate: `${BANK_YEAR}-10-09`, ledgerBalance: 0, unmatchedEntriesSum: -1049, difference: 107580, explained: false });
  });
});

describe("matchning", () => {
  it("matches automatically on amount + date at import, leaves the ambiguous for the user and lists proposals", async () => {
    const account = await makeAccount();
    const fee = await bookOnBank(`${BANK_YEAR}-10-10`, -150);
    await bookOnBank(`${BANK_YEAR}-10-08`, 26180, "1510");
    await bookOnBank(`${BANK_YEAR}-10-09`, 26180, "1510");
    const result = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), {}, userId);
    expect(result.autoMatched).toBe(1);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.matches).toHaveLength(1);
    expect(view.matches[0]).toMatchObject({ kind: "auto", entries: [expect.objectContaining({ amount: -150 })], rows: [expect.objectContaining({ id: fee.rowId, amount: -150, verificationDisplayNumber: fee.displayNumber })] });
    expect(view.statementEntries.map((e) => e.amount)).toEqual([26180, -18450]);
    expect(view.ledgerRows.map((r) => r.amount)).toEqual([26180, 26180]);
    expect(view.proposals).toEqual([{ entryIds: [view.statementEntries[0]!.id], rowIds: view.ledgerRows.map((r) => r.id), basis: "amount_date", ambiguous: true }]);
    // Matcha automatiskt again: nothing more to match, one ambiguous.
    expect(await service.autoMatch({ bankAccountId: account.id }, userId)).toEqual({ matched: 0, ambiguous: 1 });
  });

  it("matches on the camt.054 reference of a booked customer payment even when another row has the same amount", async () => {
    const account = await makeAccount();
    const paidFromBank = await bookOnBank(`${BANK_YEAR}-10-09`, 26180, "1510", "Inbetalning via bankfil");
    await bookOnBank(`${BANK_YEAR}-10-09`, 26180, "1510", "Annan");
    const { entry } = await makeBankEntry({ direction: "credit", amount: 26180, dedupeKey: `${SWEDBANK}|tx:2024100984020001` });
    const customer = await makeCustomer();
    await db.insert(customerPayments).values({
      paymentNumber: "BET-T1",
      customerId: customer.id,
      paymentDate: `${BANK_YEAR}-10-09`,
      bankAccountNumber: "1930",
      amount: "26180",
      amountSek: "26180",
      verificationId: paidFromBank.verificationId,
      bankFileEntryId: entry.id,
    });
    const result = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), {}, userId);
    expect(result.autoMatched).toBe(1);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.matches[0]!.rows.map((r) => r.id)).toEqual([paidFromBank.rowId]);
    expect(view.matches[0]!.entries[0]!.amount).toBe(26180);
  });

  it("manual matching checks the account and the sum; two concurrent matches of one entry give one match", async () => {
    const account = await makeAccount();
    const other = await makeAccount("OTHER", "1930");
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    const payment = view.statementEntries.find((e) => e.amount === -18450)!;
    const a = await bookOnBank(`${BANK_YEAR}-10-09`, -18450, "2440");
    const b = await bookOnBank(`${BANK_YEAR}-10-09`, -18450, "2440");

    await expect(service.createMatch({ bankAccountId: account.id, entryIds: [payment.id], verificationRowIds: [] }, userId)).rejects.toBeInstanceOf(BankMatchSumMismatchError);
    await expect(service.createMatch({ bankAccountId: other.id, entryIds: [payment.id], verificationRowIds: [a.rowId] }, userId)).rejects.toBeInstanceOf(BankMatchWrongAccountError);
    const wrongAccountRow = await (async () => {
      const booked = await testEconomyService.createVerification(
        { seriesId: await manualSeries(), date: `${BANK_YEAR}-10-09`, description: "Ej bank", rows: [{ accountId: await accountId("1510"), debit: 5, credit: 0 }, { accountId: await accountId("3001"), debit: 0, credit: 5 }], book: true },
        userId
      );
      const [row] = await db.select({ id: verificationRows.id }).from(verificationRows).where(eq(verificationRows.verificationId, booked.id));
      return row!.id;
    })();
    await expect(service.createMatch({ bankAccountId: account.id, entryIds: [payment.id], verificationRowIds: [wrongAccountRow] }, userId)).rejects.toBeInstanceOf(BankMatchWrongAccountError);

    const results = await Promise.allSettled([
      service.createMatch({ bankAccountId: account.id, entryIds: [payment.id], verificationRowIds: [a.rowId] }, userId),
      service.createMatch({ bankAccountId: account.id, entryIds: [payment.id], verificationRowIds: [b.rowId] }, userId),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(BankMatchAlreadyMatchedError);
    const after = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(after.matches).toHaveLength(1);
    expect(after.matches[0]!.kind).toBe("manual");
    expect(after.ledgerRows).toHaveLength(1);
  });

  it("undo frees the entry and the row; a second undo is refused", async () => {
    const account = await makeAccount();
    const fee = await bookOnBank(`${BANK_YEAR}-10-09`, -150);
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), {}, userId);
    let view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    const match = view.matches[0]!;
    const undone = await service.undoMatch(match.id, userId);
    expect(undone.undoneAt).not.toBeNull();
    await expect(service.undoMatch(match.id, userId)).rejects.toBeInstanceOf(BankMatchAlreadyUndoneError);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.matches).toEqual([]);
    expect(view.statementEntries.some((e) => e.amount === -150)).toBe(true);
    expect(view.ledgerRows.map((r) => r.id)).toEqual([fee.rowId]);
    // Nets a reversal pair without rows: entries only, sum 0.
    const pair = statementWith([
      { direction: "debit", amount: 500, bookingDate: `${BANK_YEAR}-10-11`, acctSvcrRef: "P1" },
      { direction: "credit", amount: 500, bookingDate: `${BANK_YEAR}-10-12`, acctSvcrRef: "P2", reversal: true },
    ]);
    await service.import(uploadOf(pair), { autoMatch: false }, userId);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-11`, to: `${BANK_YEAR}-10-12` });
    const created = await service.createMatch({ bankAccountId: account.id, entryIds: view.statementEntries.map((e) => e.id), verificationRowIds: [] }, userId);
    expect(created.entries).toHaveLength(2);
    expect(created.rows).toEqual([]);
  });
});

describe("bokföra en post", () => {
  it("books the entry in series B and matches it in the same transaction; a locked period leaves nothing behind", async () => {
    const account = await makeAccount();
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    const fee = view.statementEntries.find((e) => e.amount === -150)!;
    const bank = await accountId("1930");
    const cost = await accountId("6570");

    await expect(
      service.bookEntry(fee.id, { description: "Bankavgift", rows: [{ accountId: bank, debit: 0, credit: 100 }, { accountId: cost, debit: 100, credit: 0 }] }, userId)
    ).rejects.toBeInstanceOf(BankEntryBookMismatchError);

    const result = await service.bookEntry(fee.id, { description: "Bankavgift", rows: [{ accountId: bank, debit: 0, credit: 150 }, { accountId: cost, debit: 150, credit: 0 }] }, userId);
    expect(result.verification.displayNumber).toBe(`B-${BANK_YEAR}-1`);
    expect(result.match).toMatchObject({ kind: "created", entries: [expect.objectContaining({ id: fee.id })], rows: [expect.objectContaining({ verificationDisplayNumber: `B-${BANK_YEAR}-1`, amount: -150 })] });
    const [verification] = await db.select().from(verifications).where(eq(verifications.id, result.verification.id));
    expect(verification).toMatchObject({ status: "booked", date: `${BANK_YEAR}-10-09`, description: "Bankavgift" });
    await expect(service.bookEntry(fee.id, { description: "Igen", rows: [{ accountId: bank, debit: 0, credit: 150 }, { accountId: cost, debit: 150, credit: 0 }] }, userId)).rejects.toBeInstanceOf(BankMatchAlreadyMatchedError);

    // A locked period: the booking is refused and no match is written.
    const payment = view.statementEntries.find((e) => e.amount === -18450)!;
    await testEconomyService.lockPeriod((await periodStarting(`${BANK_YEAR}-10-01`)).id, userId);
    const before = await db.select().from(verifications);
    await expect(
      service.bookEntry(payment.id, { description: "Lev", rows: [{ accountId: bank, debit: 0, credit: 18450 }, { accountId: await accountId("2440"), debit: 18450, credit: 0 }] }, userId)
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);
    expect((await db.select().from(verifications)).length).toBe(before.length);
    expect(await repo.isEntryMatched(db, payment.id)).toBe(false);
  });

  it("books by rule: the one rule wins, a momskod splits the gross, none/several are reported per entry", async () => {
    const account = await makeAccount();
    const rules = await service.listRules();
    expect(rules.rows.map((r) => [r.textContains, r.direction, r.accountNumber])).toEqual([
      ["avgift", "both", "6570"],
      ["ränta", "in", "8310"],
      ["ränta", "out", "8410"],
      ["skatteverket", "both", "1630"],
      ["skattekonto", "both", "1630"],
    ]);
    expect(rules.rows[0]!.accountName).toBe("Bankkostnader");
    await service.createRule({ textContains: "kortkop", direction: "out", accountNumber: "5410", vatCode: "MP25", autoBook: false, active: true }, userId);
    await service.createRule({ textContains: "inbetalningar", direction: "in", accountNumber: "1510", autoBook: false, active: true }, userId);
    await service.createRule({ textContains: "bg", direction: "in", accountNumber: "1510", autoBook: false, active: true }, userId);
    const card = statementWith([{ direction: "debit", amount: 1250, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "K1", addtlNtryInf: "KORTKOP BYGGVARUHUSET" }]);
    await service.import(uploadOf(card), { autoMatch: false }, userId);
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    const byAmount = (amount: number) => view.statementEntries.find((e) => e.amount === amount)!;
    expect(byAmount(-150).ruleSuggestion).toMatchObject({ accountNumber: "6570", description: "Bankavgift" });
    expect(byAmount(26180).ruleSuggestion).toBeNull(); // two rules match

    const result = await service.bookByRule({ entryIds: [byAmount(-150).id, byAmount(-1250).id, byAmount(26180).id, byAmount(-18450).id] }, userId);
    expect(result.booked.map((b) => b.displayNumber)).toEqual([`B-${BANK_YEAR}-1`, `B-${BANK_YEAR}-2`]);
    expect(result.failed).toEqual([
      { entryId: byAmount(26180).id, error: expect.objectContaining({ code: "bank-rule-ambiguous" }) },
      { entryId: byAmount(-18450).id, error: expect.objectContaining({ code: "bank-rule-missing" }) },
    ]);
    const cardRows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, result.booked[1]!.verificationId));
    const byAccount = new Map<string, { debit: number; credit: number }>();
    for (const row of cardRows) byAccount.set((await testEconomyRepository.findAccountById(row.accountId))!.number, { debit: Number(row.debit), credit: Number(row.credit) });
    expect(byAccount.get("1930")).toEqual({ debit: 0, credit: 1250 });
    expect(byAccount.get("5410")).toEqual({ debit: 1000, credit: 0 });
    expect(byAccount.get("2640")).toEqual({ debit: 250, credit: 0 });
    // Interest in: the "in" rule, not the "out" one.
    const interest = statementWith([{ direction: "credit", amount: 12.5, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "R1", addtlNtryInf: "Ränta" }]);
    const imported = await service.import(uploadOf(interest), { autoMatch: false }, userId);
    expect(imported.autoBooked).toBe(0);
  });

  it("Bokför direkt books unambiguous entries at import, off by default, a failing rule only warns", async () => {
    await makeAccount();
    const seeded = await service.listRules();
    const fee = seeded.rows.find((r) => r.textContains === "avgift")!;
    const interestIn = seeded.rows.find((r) => r.textContains === "ränta" && r.direction === "in")!;
    const result = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    expect(result.autoBooked).toBe(0);
    await service.updateRule(fee.id, { autoBook: true }, userId);
    await expect(service.createRule({ textContains: "x", direction: "in", accountNumber: "8311", autoBook: true, active: true }, userId)).rejects.toMatchObject({ name: "BankRuleAccountMissingError" });
    const second = statementWith([
      { direction: "debit", amount: 75, bookingDate: `${BANK_YEAR}-10-10`, acctSvcrRef: "F2", addtlNtryInf: "Avgift Swish" },
      { direction: "credit", amount: 10, bookingDate: `${BANK_YEAR}-10-10`, acctSvcrRef: "I2", addtlNtryInf: "Ränta" },
    ]);
    const imported = await service.import(uploadOf(second), { autoMatch: false }, userId);
    // The fee is booked (its rule has Bokför direkt); the interest's rule has not.
    expect(imported).toMatchObject({ imported: 2, autoBooked: 1, warnings: [] });
    // A rule that cannot book (locked period) only warns — the import stands.
    await service.updateRule(interestIn.id, { autoBook: true }, userId);
    await testEconomyService.lockPeriod((await periodStarting(`${BANK_YEAR}-10-01`)).id, userId);
    const third = statementWith([{ direction: "credit", amount: 11, bookingDate: `${BANK_YEAR}-10-11`, acctSvcrRef: "I3", addtlNtryInf: "Ränta" }]);
    const failing = await service.import(uploadOf(third), { autoMatch: false }, userId);
    expect(failing).toMatchObject({ imported: 1, autoBooked: 0 });
    expect(failing.warnings[0]).toContain("kunde inte bokföras direkt");
    await expect(service.bookByRule({ entryIds: [crypto.randomUUID()] }, userId)).resolves.toMatchObject({ booked: [], failed: [expect.objectContaining({ error: expect.objectContaining({ code: "bank-statement-entry-not-found" }) })] });
    const rules = await service.listRules();
    expect(rules.rows.find((r) => r.textContains === "avgift")!.autoBook).toBe(true);
    // The seed never comes back once the user has emptied the table.
    for (const rule of rules.rows) await service.deleteRule(rule.id, userId);
    expect((await service.listRules()).total).toBe(0);
  });

  it("Kräver kostnadsställe on the rule's account: Bokför enligt regel reports the refusal per entry with the real code and message", async () => {
    const account = await makeAccount();
    await service.listRules(); // seeds the standard rules ("avgift" → 6570)
    await testEconomyService.updateAccount(await accountId("6570"), { costCenterRequired: true });
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    const fee = view.statementEntries.find((e) => e.amount === -150)!;
    const result = await service.bookByRule({ entryIds: [fee.id] }, userId);
    expect(result.booked).toEqual([]);
    expect(result.failed).toEqual([{ entryId: fee.id, error: { code: "cost-center-required", error: "Konto 6570 kräver kostnadsställe — ange ett på raden" } }]);

    // With the cost center on the rule the entry books.
    const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
    const rule = (await service.listRules()).rows.find((r) => r.textContains === "avgift")!;
    await service.updateRule(rule.id, { costCenterId: workshop!.id }, userId);
    const again = await service.bookByRule({ entryIds: [fee.id] }, userId);
    expect(again.booked).toHaveLength(1);
    const rows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, again.booked[0]!.verificationId));
    expect(rows.find((r) => Number(r.debit) === 150)!.costCenterId).toBe(workshop!.id);
  });

  it("refuses booking by a rule whose account is missing, and surfaces missing/ambiguous rules as errors", async () => {
    await makeAccount();
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    const entries = await repo.unmatchedEntries(db, (await service.listAccounts(false)).rows[0]!.id, {});
    const fee = entries.find((e) => e.amount === -150)!;
    const result = await service.bookByRule({ entryIds: [fee.id] }, userId);
    expect(result.failed[0]!.error.code).toBe("bank-rule-missing");
    expect(new BankRuleMissingError().name).toBe("BankRuleMissingError");
    expect(new BankRuleAmbiguousError(["a"]).ruleIds).toEqual(["a"]);
  });
});

describe("avstämd t.o.m.", () => {
  it("is refused while something is unmatched or the balances disagree, then accepted; a later booking warns", async () => {
    const account = await makeAccount();
    const stmt = statementWith(
      [
        { direction: "credit", amount: 1000, bookingDate: `${BANK_YEAR}-10-08`, acctSvcrRef: "S1", addtlNtryInf: "Inbetalning" },
        { direction: "debit", amount: 150, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "S2", addtlNtryInf: "Avgift" },
      ],
      { closing: { amount: 850, date: `${BANK_YEAR}-10-09` } }
    );
    await service.import(uploadOf(stmt), { autoMatch: false }, userId);
    const through = `${BANK_YEAR}-10-09`;
    await expect(service.createReconciliation({ bankAccountId: account.id, throughDate: through }, userId)).rejects.toMatchObject({ reason: "unmatched-entries", detail: { count: 2 } });

    const inbound = await bookOnBank(`${BANK_YEAR}-10-08`, 1000, "1510");
    const fee = await bookOnBank(`${BANK_YEAR}-10-09`, -150);
    const stray = await bookOnBank(`${BANK_YEAR}-10-09`, -20);
    await service.autoMatch({ bankAccountId: account.id }, userId);
    await expect(service.createReconciliation({ bankAccountId: account.id, throughDate: through }, userId)).rejects.toMatchObject({ reason: "unmatched-rows", detail: { count: 1 } });
    // Match the stray against nothing is impossible (sum) — match it with a counter entry instead.
    await service.import(uploadOf(statementWith([{ direction: "debit", amount: 20, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "S3", addtlNtryInf: "Avgift 2" }], { closing: { amount: 830, date: `${BANK_YEAR}-10-09` } })), {}, userId);
    void inbound;
    void fee;
    void stray;
    // No statement balance for a day after the last one: refused.
    await expect(service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-07` }, userId)).rejects.toMatchObject({ reason: "no-statement-balance" });
    const ok = await service.createReconciliation({ bankAccountId: account.id, throughDate: through }, userId);
    expect(ok).toMatchObject({ throughDate: through, statementBalance: 830, ledgerBalance: 830 });
    expect((await service.listAccounts(false)).rows[0]!.reconciledThrough).toBe(through);
    // A statement day later with a balance the ledger does not have.
    await service.import(uploadOf(statementWith([{ direction: "credit", amount: 5, bookingDate: `${BANK_YEAR}-10-10`, acctSvcrRef: "S4", addtlNtryInf: "X" }], { closing: { amount: 900, date: `${BANK_YEAR}-10-10` } })), { autoMatch: false }, userId);
    await bookOnBank(`${BANK_YEAR}-10-10`, 5, "1510");
    await service.autoMatch({ bankAccountId: account.id }, userId);
    const mismatch = await service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-10` }, userId).catch((err: unknown) => err);
    expect(mismatch).toBeInstanceOf(BankReconciliationIncompleteError);
    expect((mismatch as BankReconciliationIncompleteError).reason).toBe("balance-mismatch");
    expect((mismatch as BankReconciliationIncompleteError).detail).toEqual({ statementBalance: 900, ledgerBalance: 835, inTransit: 0 });

    let view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.changedAfterReconciliation).toBeNull();
    expect(view.reconciliations).toHaveLength(1);
    // A verification dated on or before the mark, booked after it.
    await bookOnBank(`${BANK_YEAR}-10-09`, -1);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.changedAfterReconciliation).toEqual({ through, rows: 1, entries: 0 });
    // Pure summary check on the view: statement 900 on 10-10, ledger 834, unmatched row −1.
    expect(view.summary).toMatchObject({ statementBalance: 900, statementBalanceDate: `${BANK_YEAR}-10-10`, ledgerBalance: 834, unmatchedEntriesSum: 0, unmatchedRowsSum: -1, difference: 66, explained: false });
  });
});

describe("årsbokslut och avisering", () => {
  it("lists the bank accounts not reconciled through the closing date and words the warning", async () => {
    const account = await makeAccount();
    const inactive = await makeAccount("INACTIVE1");
    await service.updateAccount(inactive.id, { active: false }, userId);
    expect(await unreconciledBankAccountsAsOf(db, `${BANK_YEAR}-12-31`)).toEqual([{ id: account.id, name: "Företagskonto", ledgerAccount: "1930", reconciledThrough: null }]);
    await service.import(uploadOf(statementWith([], { closing: { amount: 0, date: `${BANK_YEAR}-11-30` } })), { autoMatch: false }, userId);
    await service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-11-30` }, userId);
    const partial = await unreconciledBankAccountsAsOf(db, `${BANK_YEAR}-12-31`);
    expect(partial).toEqual([{ id: account.id, name: "Företagskonto", ledgerAccount: "1930", reconciledThrough: `${BANK_YEAR}-11-30` }]);
    expect(await unreconciledBankAccountsAsOf(db, `${BANK_YEAR}-11-30`)).toEqual([]);
    const warnings = evaluateWarnings({
      unsettledVatMonths: [],
      receivables: { accountNumber: "1510", ledger: 0, register: 0 },
      payables: { accountNumber: "2440", ledger: 0, register: 0 },
      fixedAssetMismatches: [],
      revenueWithoutVatBox: [],
      inventoryStale: null,
      unreconciledBankAccounts: partial,
    });
    expect(warnings).toEqual([{ code: "bank-not-reconciled", message: `Bankkontot 1930 Företagskonto är inte avstämt t.o.m. bokslutsdagen (senast avstämt ${BANK_YEAR}-11-30) — se Bankavstämning` }]);
  });

  it("the alert lists unmatched entries older than ten days, oldest first", async () => {
    const account = await makeAccount();
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    await service.import(uploadOf(statementWith([{ direction: "credit", amount: 7, bookingDate: `${BANK_YEAR}-10-15`, acctSvcrRef: "N1", addtlNtryInf: "Ny" }])), { autoMatch: false }, userId);
    const alerts = createAlertsService({
      repo: createAlertsRepository(db),
      planning: { requirementProposals: async () => [], orderPlanSummaries: async () => new Map() },
      settings: { supplierInvoiceDays: async () => 7, quoteFollowupDays: async () => 7 },
      today: () => `${BANK_YEAR}-10-20`,
    });
    const { groups } = await alerts.computeAlerts(["bank_unreconciled"]);
    expect(groups[0]).toMatchObject({ kind: "bank_unreconciled", label: "Omatchade bankposter", severity: "yellow", count: 3, error: false });
    expect(groups[0]!.items[0]).toMatchObject({ href: `/ekonomi/bankavstamning?account=${account.id}`, primary: `${BANK_YEAR}-10-09 BG INBETALNINGAR 551-2348`, date: `${BANK_YEAR}-10-09` });
    expect(groups[0]!.items[0]!.secondary).toBe(`${(26180).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr · Företagskonto · 11 dagar försenad`);
    // Matched entries and younger ones are left out.
    await bookOnBank(`${BANK_YEAR}-10-09`, -150);
    await service.autoMatch({ bankAccountId: account.id }, userId);
    expect((await alerts.computeAlerts(["bank_unreconciled"])).groups[0]!.count).toBe(2);
    // The seed flag is a bank_* setting, reset by the suites.
    expect((await db.select().from(systemSettings).where(eq(systemSettings.key, "bank_rules_seeded"))).length).toBe(0);
  });
});

describe("startpunkt för avstämningen", () => {
  it("history before the first statement blocks Avstämd t.o.m. until the opening links it; the opening needs the right balance", async () => {
    const account = await makeAccount();
    // The opening balance (IB) on 1930, booked long before the first statement.
    const ib = await bookOnBank(`${BANK_YEAR}-01-01`, 100000, "1510", "Ingående balans");
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    await bookOnBank(`${BANK_YEAR}-10-09`, 26180, "1510");
    await bookOnBank(`${BANK_YEAR}-10-09`, -18450, "2440");
    await bookOnBank(`${BANK_YEAR}-10-09`, -150);
    expect(await service.autoMatch({ bankAccountId: account.id }, userId)).toEqual({ matched: 3, ambiguous: 0 });
    // Everything on the statement is matched, the balances even agree (IB 100 000 + 7 580) —
    // but the IB row can never meet an entry, so the mark is refused.
    await expect(service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-09` }, userId)).rejects.toMatchObject({ reason: "unmatched-rows", detail: { count: 1 } });
    let view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.summary).toMatchObject({ statementBalance: 107580, ledgerBalance: 107580, unmatchedRowsSum: 100000, inTransit: 0, difference: 0, explained: false });

    // The Startpunkt per the day before the statement: the typed balance must equal the ledger.
    const wrong = await service.createOpening(account.id, { date: `${BANK_YEAR}-10-08`, statementBalance: 99000 }, userId).catch((err: unknown) => err);
    expect(wrong).toBeInstanceOf(BankOpeningBalanceMismatchError);
    expect(wrong).toMatchObject({ statementBalance: 99000, ledgerBalance: 100000 });
    const opening = await service.createOpening(account.id, { date: `${BANK_YEAR}-10-08`, statementBalance: 100000 }, userId);
    expect(opening.reconciliation).toMatchObject({ throughDate: `${BANK_YEAR}-10-08`, statementBalance: 100000, ledgerBalance: 100000, opening: true, matchId: opening.match.id });
    expect(opening.match).toMatchObject({ kind: "opening", entries: [], rows: [expect.objectContaining({ id: ib.rowId, amount: 100000 })] });
    await expect(service.createOpening(account.id, { date: `${BANK_YEAR}-10-08`, statementBalance: 100000 }, userId)).rejects.toMatchObject({ reason: "mark-exists" });

    // Now the mark goes through, and the summary is explained.
    const marked = await service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-09` }, userId);
    expect(marked).toMatchObject({ throughDate: `${BANK_YEAR}-10-09`, statementBalance: 107580, ledgerBalance: 107580, opening: false, matchId: null });
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.summary).toMatchObject({ difference: 0, expectedDifference: 0, explained: true });
    expect(view.ledgerRows).toEqual([]);
    expect(view.reconciliations.map((r) => [r.throughDate, r.opening])).toEqual([[`${BANK_YEAR}-10-09`, false], [`${BANK_YEAR}-10-08`, true]]);
    // The Startpunkt is listed under Matchat whatever the period shown.
    expect(view.matches.find((m) => m.kind === "opening")?.id).toBe(opening.match.id);
    expect((await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-12-01`, to: `${BANK_YEAR}-12-31` })).matches.map((m) => m.kind)).toEqual(["opening"]);
    expect(view.bankAccount.reconciledThrough).toBe(`${BANK_YEAR}-10-09`);

    // Undo of the opening is refused while a later mark rests on it.
    await expect(service.undoMatch(opening.match.id, userId)).rejects.toMatchObject({ reason: "later-mark" });
    expect(new BankOpeningNotAllowedError("later-mark").name).toBe("BankOpeningNotAllowedError");
  });

  it("undoing the opening frees its rows and withdraws the mark; a new opening can then be made", async () => {
    const account = await makeAccount();
    const ib = await bookOnBank(`${BANK_YEAR}-01-01`, 5000, "1510", "IB");
    const opening = await service.createOpening(account.id, { date: `${BANK_YEAR}-09-30`, statementBalance: 5000 }, userId);
    expect((await service.listAccounts(false)).rows[0]!.reconciledThrough).toBe(`${BANK_YEAR}-09-30`);
    expect(await unreconciledBankAccountsAsOf(db, `${BANK_YEAR}-09-30`)).toEqual([]);
    const undone = await service.undoMatch(opening.match.id, userId);
    expect(undone.undoneAt).not.toBeNull();
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-01-01`, to: `${BANK_YEAR}-12-31` });
    expect(view.ledgerRows.map((r) => r.id)).toEqual([ib.rowId]);
    expect(view.reconciliations).toEqual([]);
    expect(view.matches).toEqual([]);
    expect(view.bankAccount.reconciledThrough).toBeNull();
    expect(view.changedAfterReconciliation).toBeNull();
    expect((await unreconciledBankAccountsAsOf(db, `${BANK_YEAR}-09-30`)).map((a) => a.reconciledThrough)).toEqual([null]);
    const again = await service.createOpening(account.id, { date: `${BANK_YEAR}-09-30`, statementBalance: 5000 }, userId);
    expect(again.match.rows).toHaveLength(1);
  });
});

describe("i transit", () => {
  it("a matching that crosses the balance day explains the difference and does not block the mark", async () => {
    const account = await makeAccount();
    // The bank booked the inbound payment on the 9th; the ledger row is dated the 11th.
    await service.import(uploadOf(statementWith([{ direction: "credit", amount: 1000, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "T1", addtlNtryInf: "Inbetalning" }], { closing: { amount: 1000, date: `${BANK_YEAR}-10-09` } })), { autoMatch: false }, userId);
    const late = await bookOnBank(`${BANK_YEAR}-10-11`, 1000, "1510");
    let view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-09` });
    expect(view.summary).toMatchObject({ statementBalance: 1000, ledgerBalance: 0, unmatchedEntriesSum: 1000, unmatchedRowsSum: 0, inTransit: 0, difference: 1000, explained: true });
    await service.createMatch({ bankAccountId: account.id, entryIds: [view.statementEntries[0]!.id], verificationRowIds: [late.rowId] }, userId);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-09` });
    expect(view.summary).toMatchObject({ statementBalance: 1000, ledgerBalance: 0, unmatchedEntriesSum: 0, unmatchedRowsSum: 0, inTransit: 1000, difference: 1000, expectedDifference: 1000, explained: true });
    // Per the 11th the matching is wholly on both sides: nothing in transit.
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-11` });
    expect(view.summary).toMatchObject({ statementBalanceDate: `${BANK_YEAR}-10-09`, inTransit: 1000 });
    const marked = await service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-09` }, userId);
    expect(marked).toMatchObject({ statementBalance: 1000, ledgerBalance: 0 });
    // The other direction: the ledger booked −200 on the 9th, the bank on the 12th.
    const early = await bookOnBank(`${BANK_YEAR}-10-09`, -200);
    await service.import(uploadOf(statementWith([{ direction: "debit", amount: 200, bookingDate: `${BANK_YEAR}-10-12`, acctSvcrRef: "T2", addtlNtryInf: "Avgift" }], { closing: { amount: 800, date: `${BANK_YEAR}-10-12` } })), { autoMatch: false }, userId);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-12` });
    await service.createMatch({ bankAccountId: account.id, entryIds: [view.statementEntries[0]!.id], verificationRowIds: [early.rowId] }, userId);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-09` });
    expect(view.summary).toMatchObject({ statementBalance: 1000, ledgerBalance: -200, inTransit: 1200, difference: 1200, explained: true });
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-12` });
    expect(view.summary).toMatchObject({ statementBalance: 800, ledgerBalance: 800, inTransit: 0, difference: 0, explained: true });
    const mismatch = await service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-12` }, userId);
    expect(mismatch).toMatchObject({ statementBalance: 800, ledgerBalance: 800 });
  });
});

describe("granskningsfynden", () => {
  it("locks the ledger account and the currency once the account has entries or matchings", async () => {
    const account = await makeAccount();
    expect(account.hasActivity).toBe(false);
    // Without entries the ledger account may still change.
    expect((await service.updateAccount(account.id, { ledgerAccount: "1940" }, userId)).ledgerAccount).toBe("1940");
    await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    expect((await service.getAccount(account.id)).hasActivity).toBe(true);
    const ledger = await service.updateAccount(account.id, { ledgerAccount: "1930" }, userId).catch((err: unknown) => err);
    expect(ledger).toBeInstanceOf(BankAccountInUseError);
    expect((ledger as BankAccountInUseError).field).toBe("ledgerAccount");
    await expect(service.updateAccount(account.id, { currency: "EUR" }, userId)).rejects.toMatchObject({ field: "currency" });
    // The same values and the other fields are fine.
    const same = await service.updateAccount(account.id, { ledgerAccount: "1940", currency: "SEK", name: "Nytt namn" }, userId);
    expect(same).toMatchObject({ name: "Nytt namn", ledgerAccount: "1940" });
  });

  it("learns the file's identifier only onto an account without entries; refuses to take over one with statements", async () => {
    const taken = await makeAccount("OTHER123");
    await service.import(uploadOf(statementWith([{ direction: "credit", amount: 1, bookingDate: `${BANK_YEAR}-10-01`, acctSvcrRef: "O1" }], { bban: "OTHER123" })), { autoMatch: false }, userId);
    const locked = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { bankAccountId: taken.id, autoMatch: false }, userId).catch((err: unknown) => err);
    expect(locked).toBeInstanceOf(BankAccountIdentifierLockedError);
    expect(locked).toMatchObject({ accountName: "Företagskonto", identifier: "OTHER123", fileIdentifier: SWEDBANK });
    expect((await service.getAccount(taken.id)).identifier).toBe("OTHER123");
    const preview = await service.preview({ data: Buffer.from(fixtureXml("camt053-swedbank.xml")) }, { bankAccountId: taken.id });
    expect(preview.blockers).toEqual([expect.stringContaining("kan inte tas över")]);
    expect(preview.unknownAccounts).toEqual([SWEDBANK]);
    // An empty account takes the identifier as before.
    const fresh = await service.createAccount({ name: "Nytt", identifier: "FRESH1", ledgerAccount: "1930", currency: "SEK" }, userId);
    const result = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { bankAccountId: fresh.id, autoMatch: false }, userId);
    expect(result.imported).toBe(3);
    expect((await service.getAccount(fresh.id)).identifier).toBe(SWEDBANK);
  });

  it("checks every entry's currency, not just the statement's", async () => {
    const account = await makeAccount();
    const xml = statementWith([
      { direction: "credit", amount: 10, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "C1" },
      { direction: "credit", amount: 20, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "C2" },
    ]).replace('<Amt Ccy="SEK">10.00</Amt>', '<Amt Ccy="EUR">10.00</Amt>');
    const err = await service.import(uploadOf(xml), { autoMatch: false }, userId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankStatementCurrencyError);
    expect(err).toMatchObject({ statementCurrency: "EUR", accountCurrency: "SEK" });
    const preview = await service.preview({ data: Buffer.from(xml) }, {});
    expect(preview.blockers).toEqual([`Kontoutdraget har poster i EUR men bankkontot ${account.name} är i SEK`]);
    expect(await repo.countEntries(db, account.id)).toBe(0);
  });

  it("two concurrent imports of the same file both succeed with one file row and no duplicate entries", async () => {
    const account = await makeAccount();
    const results = await Promise.all([
      service.import(uploadOf(fixtureXml("camt053-swedbank.xml"), "a.xml"), { autoMatch: false }, userId),
      service.import(uploadOf(fixtureXml("camt053-swedbank.xml"), "b.xml"), { autoMatch: false }, userId),
    ]);
    expect(results.map((r) => r.imported).sort()).toEqual([0, 3]);
    expect(results[0]!.bankFileId).toBe(results[1]!.bankFileId);
    expect((await db.select().from(bankFiles)).length).toBe(1);
    expect(await repo.countEntries(db, account.id)).toBe(3);
  });

  it("seeds the rules once under concurrent first GETs, and never for a reader who asks not to", async () => {
    await resetBankSettings();
    const lists = await Promise.all(Array.from({ length: 6 }, () => service.listRules()));
    for (const list of lists) expect(list.total).toBe(5);
    expect((await db.select().from(bankRules)).length).toBe(5);
    await db.delete(bankRules);
    await resetBankSettings();
    expect((await service.listRules({ seed: false })).total).toBe(0);
    expect((await db.select().from(systemSettings).where(eq(systemSettings.key, "bank_rules_seeded"))).length).toBe(0);
    await db.update(companyInfo).set({ iban: "SE45 5000 0000 0583 9825 7466" });
    expect((await service.listAccounts(false, { seed: false })).total).toBe(0);
    expect((await service.listAccounts(false)).total).toBe(1);
  });

  it("a failure after the import's commit becomes a warning, and an unexpected error never leaks its message", async () => {
    await makeAccount();
    const seeded = await service.listRules();
    await service.updateRule(seeded.rows.find((r) => r.textContains === "avgift")!.id, { autoBook: true }, userId);
    const logged: string[] = [];
    const broken = createBankReconciliationService({
      db,
      repo: { ...repo, entriesByIds: async () => { throw new TypeError("driver exploded"); }, findEntry: async () => { throw new TypeError("driver exploded"); } },
      economy: testEconomyService,
      settings: { read: readPostingSettings },
      company: createBankSettingsRepository(db),
      log: (msg) => logged.push(msg),
    });
    const result = await broken.import(uploadOf(fixtureXml("camt053-swedbank.xml")), { autoMatch: false }, userId);
    expect(result.imported).toBe(3);
    expect(result.autoBooked).toBe(0);
    expect(result.warnings).toEqual([`Bankreglerna kunde inte köras efter importen: ${UNEXPECTED_ERROR_TEXT}`]);
    expect(result.warnings.join(" ")).not.toContain("driver exploded");
    expect(logged).toHaveLength(1);
    const [entry] = await db.select({ id: bankStatementEntries.id }).from(bankStatementEntries).limit(1);
    const byRule = await broken.bookByRule({ entryIds: [entry!.id] }, userId);
    expect(byRule.failed).toEqual([{ entryId: entry!.id, error: { error: UNEXPECTED_ERROR_TEXT } }]);
    expect(logged).toHaveLength(2);
    // A known domain error keeps its code.
    const known = await service.bookByRule({ entryIds: [crypto.randomUUID()] }, userId);
    expect(known.failed[0]!.error.code).toBe("bank-statement-entry-not-found");
  });

  it("warns after the mark when something up to it is unmatched again (an undone matching)", async () => {
    const account = await makeAccount();
    const row = await bookOnBank(`${BANK_YEAR}-10-09`, 500, "1510");
    await service.import(uploadOf(statementWith([{ direction: "credit", amount: 500, bookingDate: `${BANK_YEAR}-10-09`, acctSvcrRef: "U1" }], { closing: { amount: 500, date: `${BANK_YEAR}-10-09` } })), {}, userId);
    await service.createReconciliation({ bankAccountId: account.id, throughDate: `${BANK_YEAR}-10-09` }, userId);
    let view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.changedAfterReconciliation).toBeNull();
    await service.undoMatch(view.matches[0]!.id, userId);
    view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.changedAfterReconciliation).toEqual({ through: `${BANK_YEAR}-10-09`, rows: 1, entries: 1 });
    expect(view.ledgerRows.map((r) => r.id)).toEqual([row.rowId]);
  });

  it("matches on a camt.054 entry keyed on Ntry/AcctSvcrRef (entry_ref) too", async () => {
    const account = await makeAccount();
    const paidFromBank = await bookOnBank(`${BANK_YEAR}-10-09`, 26180, "1510", "Inbetalning via bankfil");
    await bookOnBank(`${BANK_YEAR}-10-09`, 26180, "1510", "Annan");
    const { entry } = await makeBankEntry({ direction: "credit", amount: 26180, dedupeKey: `${SWEDBANK}|ntry:2024100984020001#0`, dedupeSource: "entry_ref" });
    const customer = await makeCustomer();
    await db.insert(customerPayments).values({
      paymentNumber: "BET-T2",
      customerId: customer.id,
      paymentDate: `${BANK_YEAR}-10-09`,
      bankAccountNumber: "1930",
      amount: "26180",
      amountSek: "26180",
      verificationId: paidFromBank.verificationId,
      bankFileEntryId: entry.id,
    });
    const result = await service.import(uploadOf(fixtureXml("camt053-swedbank.xml")), {}, userId);
    expect(result.autoMatched).toBe(1);
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.matches[0]!.rows.map((r) => r.id)).toEqual([paidFromBank.rowId]);
  });

  it("nets a reversal against its original automatically, never against a row", async () => {
    const account = await makeAccount();
    await bookOnBank(`${BANK_YEAR}-10-12`, 500, "1510", "Skulle inte matchas");
    await service.import(
      uploadOf(
        statementWith([
          { direction: "debit", amount: 500, bookingDate: `${BANK_YEAR}-10-11`, acctSvcrRef: "P1", addtlNtryInf: "Betalning" },
          { direction: "credit", amount: 500, bookingDate: `${BANK_YEAR}-10-12`, acctSvcrRef: "P2", reversal: true, addtlNtryInf: "Återföring" },
        ])
      ),
      {},
      userId
    );
    const view = await service.reconciliationView({ bankAccountId: account.id, from: `${BANK_YEAR}-10-01`, to: `${BANK_YEAR}-10-31` });
    expect(view.matches).toHaveLength(1);
    expect(view.matches[0]).toMatchObject({ kind: "auto", rows: [] });
    expect(view.matches[0]!.entries.map((e) => e.amount)).toEqual([-500, 500]);
    expect(view.ledgerRows).toHaveLength(1);
    expect(view.statementEntries).toEqual([]);
  });
});

// Keep the unused-import check honest for helpers only used in one place.
void customers;
