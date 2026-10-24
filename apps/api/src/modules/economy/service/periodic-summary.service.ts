import type { Db } from "@navet/db";
import type { PeriodicSummary, PeriodicSummaryMissingField } from "@navet/shared";
import { readEuSalesLines } from "../repository/periodic-summary.repository.js";
import { readVatAccountMovements } from "./vat-account-movements.js";
import { bucketMovements, roundToKronor } from "./vat-report.service.js";
import {
  PeriodicSummaryPeriodInvalidError,
  aggregatePeriodicSummary,
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

    const { rows, warnings } = aggregatePeriodicSummary(await readEuSalesLines(db, from, to));
    const boxes = bucketMovements(await readVatAccountMovements(db, from, to));
    const ledger = { box35: roundToKronor(boxes["35"]), box39: roundToKronor(boxes["39"]) };
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

    return { period, rows, warnings, ledger, totals, reporter, missing };
  }

  // The internal row without its column-usage flags — the API shape.
  const publicRow = ({ goodsUsed: _goods, servicesUsed: _services, ...row }: PeriodicSummaryAggregateRow) => row;

  return {
    async getSummary(query: { from: string; to: string }): Promise<PeriodicSummary> {
      const { period, rows, warnings, ledger, totals, reporter, missing } = await compute(query);
      return {
        from: query.from,
        to: query.to,
        kind: period.kind,
        periodCode: period.periodCode,
        rows: rows.map(publicRow),
        totals,
        ledger,
        differences: { goods: totals.goods - ledger.box35, services: totals.services - ledger.box39 },
        warnings: [...warnings, ...ledgerDifferenceWarnings(totals, ledger)],
        reporter,
        missing,
      };
    },

    // Skatteverket's file for exactly the summary's rows. No EU sales ⇒ no
    // file (none is to be submitted); the reporter's fields are checked
    // before the amounts.
    async getFile(query: { from: string; to: string }): Promise<{ filename: string; content: Buffer }> {
      const { period, rows, reporter, missing } = await compute(query);
      if (rows.length === 0) throw new PeriodicSummaryEmptyError();
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
