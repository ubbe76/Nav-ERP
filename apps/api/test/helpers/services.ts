import { eq } from "drizzle-orm";
import { db, salesOrders, type Db } from "@navet/db";
import { createArticleRepository } from "../../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../../src/modules/article/service/article.service.js";
import { createEconomyRepository } from "../../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../../src/modules/economy/service/economy.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../../src/modules/economy/service/bas-accounts.js";
import { createDocumentPdfService } from "../../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../../src/modules/system/service/system.service.js";

// Shared collaborators for tests that only need a working service instance
// (PDF rendering + article files) rather than exercising those parts.
export const testSystemService = createSystemService(createSystemRepository(db));
export const testArticleService = createArticleService(createArticleRepository(db));
export const testDocumentPdfService = createDocumentPdfService(testSystemService);

// Economy collaborators for the automatkontering (B2) fixtures below. The
// audit writer is a no-op stub — none of the fixtures assert on the audit
// trail (same idiom as economy-posting-rules.test.ts).
export const testEconomyRepository = createEconomyRepository(db);
export const testEconomyService = createEconomyService(testEconomyRepository, { log: async () => {} });

// Same CURRENT_YEAR rationale as economy-verifications.test.ts: a literal
// year would go red the moment the real calendar rolls over.
export const POSTING_BASELINE_YEAR = new Date().getFullYear();

// The posting accounts as readPostingSettings resolves them with no settings
// rows written (codeSetting fallbacks) — all BAS numbers, so seeding the
// standard chart below makes every posting role resolve (the revenue/VAT
// accounts come with the seeded momskoder, also BAS numbers). postingBank/
// postingReminderFeeAccount/postingPaymentWriteOff (B3) are here to satisfy
// PostingAccountNumbers' shape; nothing posts against them yet.
export const DEFAULT_POSTING_SETTINGS = {
  postingAccountsReceivable: "1510",
  postingAccountsPayable: "2440",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  // Momsrapport (B5).
  postingVatSettlement: "2650",
  // Årsbokslut (steg 2).
  postingInventory: "1460",
  postingInventoryChange: "4990",
  // Valuta.
  postingFxGain: "3960",
  postingFxLoss: "7960",
  postingBankFees: "6570",
} as const;

// Automatkontering (B2): issuing a customer invoice / approving a supplier
// invoice books a verification, so every suite that does so needs a fiscal
// year (with its monthly periods) covering "today" — the document date — plus
// the accounts the posting settings point at. Idempotent: re-running against
// a database that already has the year/accounts is a no-op, so suites that
// truncate between tests and suites that don't can share it.
export async function setupPostingBaseline(): Promise<{ fiscalYearId: string }> {
  const label = String(POSTING_BASELINE_YEAR);
  const existing = (await testEconomyService.listFiscalYears()).find((year) => year.label === label);
  const fiscalYear =
    existing ??
    (await testEconomyService.createFiscalYear({
      label,
      startDate: `${POSTING_BASELINE_YEAR}-01-01`,
      endDate: `${POSTING_BASELINE_YEAR}-12-31`,
    }));
  // ON CONFLICT DO NOTHING on the account number — existing accounts survive.
  await testEconomyRepository.seedAccounts([...BAS_STANDARD_ACCOUNTS]);
  return { fiscalYearId: fiscalYear.id };
}

// Stamps an order the way pre-C1 invoicing did — the legacy shape old
// orders still carry in production. Test-only: the C1 module never writes
// these columns.
export async function stampOrderInvoiced(db: Db, orderId: string, invoiceNumber: string) {
  await db
    .update(salesOrders)
    .set({ status: "invoiced", invoiceNumber, invoicedAt: new Date(), updatedAt: new Date() })
    .where(eq(salesOrders.id, orderId));
}

// The settings defaults for the four computed PAXml tidkoder. Payroll tests
// that are not about the export itself just spread these into their settings
// stub; payroll-export.test.ts spells them out, since it asserts on them.
export const PAXML_CODES = {
  paxmlCodeWorked: "TID",
  paxmlCodeOvertime: "ÖT1",
  paxmlCodeOvertimeOffSchedule: "ÖT2",
  paxmlCodeOvertimeComp: "ÖK1",
  paxmlCodeOvertimeOffScheduleComp: "ÖK2",
  paxmlCodeAtf: "ATF",
} as const;
