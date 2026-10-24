import type { Db } from "@navet/db";
import type { PeriodicSummary, PeriodicSummaryMissingField } from "@navet/shared";
import { readEuSalesLines } from "../repository/periodic-summary.repository.js";
import { readVatAccountMovements } from "./vat-account-movements.js";
import { bucketMovements, roundToKronor } from "./vat-report.service.js";
import {
  PeriodicSummaryPeriodInvalidError,
  aggregatePeriodicSummary,
  ledgerDifference,
  ledgerDifferenceWarnings,
  periodicSummaryPeriod,
  type PeriodicSummaryAggregateRow,
} from "./periodic-summary.js";
import {
  buildPeriodicSummaryFile,
  contactNameField,
  normalizeContactPhone,
  periodicSummaryFileName,
  reporterVatDigits,
} from "./periodic-summary-file.js";
import { readVatReportingSettings } from "../../system/service/vat-reporting-settings.js";

// Periodisk sammanställning (Momskoder steg 3): the issued invoices' EU sales
// per buyer for one calendar month or quarter, reconciled against the VAT
// report's booked ruta 35/39 (the same movements and bucketing as the
// momsrapport), and Skatteverket's file. Reads only — nothing is stored.

export class PeriodicSummaryReporterIncompleteError extends Error {
  readonly missing: PeriodicSummaryMissingField[];
  constructor(missing: PeriodicSummaryMissingField[]) {
    super(
      "Uppgifter saknas för filen: företagets momsregistreringsnummer (Företagsuppgifter) och kontaktpersonens namn och telefonnummer måste vara ifyllda"
    );
    this.name = "PeriodicSummaryReporterIncompleteError";
    this.missing = missing;
  }
}

export class PeriodicSummaryEmptyError extends Error {
  constructor() {
    super("Ingen EU-försäljning i perioden — ingen periodisk sammanställning ska lämnas");
    this.name = "PeriodicSummaryEmptyError";
  }
}

// There were EU sales, but none of them carries a valid buyer number — the
// file would be empty although something is to be reported.
export class PeriodicSummaryNoValidRowsError extends Error {
  constructor() {
    super("Alla EU-fakturor i perioden saknar giltigt momsnummer — rätta kunderna");
    this.name = "PeriodicSummaryNoValidRowsError";
  }
}

const blankToNull = (value: string | null | undefined) => (value === null || value === undefined || value.trim() === "" ? null : value.trim());

export function createPeriodicSummaryService(deps: {
  db: Db;
  // Företagsuppgifter's momsregistreringsnummer.
  company: { vatNumber(): Promise<string | null> };
}) {
  const { db } = deps;

  async function compute(query: { from: string; to: string }) {
    const { from, to } = query;
    const period = periodicSummaryPeriod(from, to);
    if (!period) throw new PeriodicSummaryPeriodInvalidError(from, to);

    const { rows, warnings, totalsOre, lineCount } = aggregatePeriodicSummary(await readEuSalesLines(db, from, to));
    const boxes = bucketMovements(await readVatAccountMovements(db, from, to));
    const ledger = { box35: roundToKronor(boxes["35"]), box39: roundToKronor(boxes["39"]) };
    // The booked boxes in öre — the reconciliation's unit (round2 amounts,
    // so Math.round only removes float noise).
    const ledgerOre = { box35: Math.round(boxes["35"] * 100), box39: Math.round(boxes["39"] * 100) };
    const totals = {
      goods: rows.reduce((sum, row) => sum + row.goods, 0),
      services: rows.reduce((sum, row) => sum + row.services, 0),
    };

    const settings = await readVatReportingSettings(db);
    const companyVatNumber = blankToNull(await deps.company.vatNumber());
    const reporter = {
      vatNumber: companyVatNumber,
      contactName: settings.contactName,
      contactPhone: settings.contactPhone,
      contactEmail: settings.contactEmail,
    };
    const missing: PeriodicSummaryMissingField[] = [];
    if (reporterVatDigits(companyVatNumber) === null) missing.push("vatNumber");
    if (contactNameField(settings.contactName) === null) missing.push("contactName");
    if (normalizeContactPhone(settings.contactPhone) === null) missing.push("contactPhone");

    return { period, rows, warnings, ledger, ledgerOre, totals, totalsOre, lineCount, reporter, missing };
  }

  // The internal row without its column-usage flags — the API shape.
  const publicRow = ({ goodsUsed: _goods, servicesUsed: _services, ...row }: PeriodicSummaryAggregateRow) => row;

  return {
    async getSummary(query: { from: string; to: string }): Promise<PeriodicSummary> {
      const { period, rows, warnings, ledger, ledgerOre, totals, totalsOre, reporter, missing } = await compute(query);
      return {
        from: query.from,
        to: query.to,
        kind: period.kind,
        periodCode: period.periodCode,
        rows: rows.map(publicRow),
        totals,
        ledger,
        // The öre difference rounded to whole kronor — 0 exactly when the
        // rows' öre sum equals the booked box (ledgerDifference).
        differences: {
          goods: ledgerDifference(totalsOre.goods, ledgerOre.box35),
          services: ledgerDifference(totalsOre.services, ledgerOre.box39),
        },
        warnings: [...warnings, ...ledgerDifferenceWarnings(totalsOre, ledgerOre)],
        reporter,
        missing,
      };
    },

    // Skatteverket's file for exactly the summary's rows. No EU sales ⇒ no
    // file (none is to be submitted); EU sales without a single valid buyer
    // number ⇒ its own refusal (something IS to be reported — the customers
    // need fixing); the reporter's fields are checked before the amounts.
    async getFile(query: { from: string; to: string }): Promise<{ filename: string; content: Buffer }> {
      const { period, rows, lineCount, reporter, missing } = await compute(query);
      if (lineCount === 0) throw new PeriodicSummaryEmptyError();
      if (rows.length === 0) throw new PeriodicSummaryNoValidRowsError();
      if (missing.length > 0) throw new PeriodicSummaryReporterIncompleteError(missing);
      const content = buildPeriodicSummaryFile({
        reporterVatDigits: reporterVatDigits(reporter.vatNumber)!,
        periodCode: period.periodCode,
        contactName: contactNameField(reporter.contactName)!,
        contactPhone: normalizeContactPhone(reporter.contactPhone)!,
        contactEmail: reporter.contactEmail,
        rows: rows.map((row) => ({
          vatNumber: row.vatNumber,
          goods: row.goodsUsed ? row.goods : null,
          services: row.servicesUsed ? row.services : null,
        })),
      });
      return { filename: periodicSummaryFileName(period.fileSuffix), content };
    },
  };
}

export type PeriodicSummaryService = ReturnType<typeof createPeriodicSummaryService>;
