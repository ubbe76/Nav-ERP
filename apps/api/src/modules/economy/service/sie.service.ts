// SIE 4 export + opening-balance import (B6b). The file format itself lives
// in sie-export.ts / sie-parse.ts (pure); this service is the seam that
// gathers data from the database and books the import.
import { round2, type VatBoxSetting } from "@navet/shared";
import type { Db, Tx } from "@navet/db";
import { readAccountBalances } from "./account-balances.js";
import { defaultVatBox } from "./bas-accounts.js";
import { parseSieFile } from "./sie-parse.js";
import type { VerificationPoster } from "./verification-poster.js";
import { buildSieFile, sieAccountType, type SieExportData } from "./sie-export.js";
import { sieDate } from "./sie-format.js";

export class SieFiscalYearNotFoundError extends Error {
  constructor(id: string) {
    super(`Räkenskapsåret hittades inte: ${id}`);
    this.name = "SieFiscalYearNotFoundError";
  }
}

// The file's #RAR 0 must be the year the user picked — importing 2025's
// balances into 2026 would be silent and unrecoverable.
export class SieFiscalYearMismatchError extends Error {
  constructor(fileRange: string, yearRange: string) {
    super(`Filens räkenskapsår (${fileRange}) stämmer inte med det valda (${yearRange})`);
    this.name = "SieFiscalYearMismatchError";
  }
}

// A balance sheet that does not balance is a broken source file; inventing a
// counter-posting would hide that.
export class SieUnbalancedError extends Error {
  constructor(public readonly difference: number) {
    super(`De ingående balanserna summerar inte till noll — differens ${difference.toFixed(2)}`);
    this.name = "SieUnbalancedError";
  }
}

// An #IB account the chart lacks is created on the fly — but only when it
// fits the chart (four digits). Anything else used to reach Postgres as a
// value-too-long error (a 500); now the file is refused with the account.
export class SieInvalidAccountNumberError extends Error {
  constructor(public readonly accounts: string[]) {
    super(`Kontot ${accounts.join(", ")} har inte fyra siffror och kan inte skapas`);
    this.name = "SieInvalidAccountNumberError";
  }
}

// Opening balances are for migrating INTO the system. If the system already
// holds bookkeeping dated before the fiscal year starts, the opening balance
// is already derivable from it (the ledger carries forward automatically) and
// importing would silently double every balance.
export class SiePriorBookkeepingError extends Error {
  constructor(date: string) {
    super(
      `Det finns redan bokförda verifikat före räkenskapsårets start (senast ${date}) — ` +
        "ingående balanser räknas då fram automatiskt och ska inte importeras"
    );
    this.name = "SiePriorBookkeepingError";
  }
}

// Importing twice would double every balance.
export class SieAlreadyImportedError extends Error {
  constructor(displayNumber: string) {
    super(`Ingående balanser är redan importerade för räkenskapsåret (verifikat ${displayNumber})`);
    this.name = "SieAlreadyImportedError";
  }
}

export interface SieFiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
}

export interface SieCompanyReader {
  getCompanyInfo(): Promise<{ name: string; orgNumber: string | null } | null>;
}

export interface SieVerificationRow {
  accountNumber: string;
  debit: string;
  credit: string;
  description: string | null;
  // Kostnadsställen och projekt: the row's object codes (null = none).
  costCenterCode?: string | null;
  projectCode?: string | null;
}

export interface SieVerification {
  seriesCode: string;
  verificationNumber: number;
  date: string;
  description: string;
  rows: SieVerificationRow[];
}

export interface SieRepositoryReader {
  findFiscalYearById(id: string): Promise<(SieFiscalYear & { periods: unknown[] }) | null>;
  listFiscalYears(): Promise<SieFiscalYear[]>;
  listAccounts(query: {
    includeInactive: boolean;
    limit: number;
    offset: number;
  }): Promise<{ rows: { number: string; name: string }[]; total: number }>;
  listVerificationsForSie(fiscalYearId: string): Promise<SieVerification[]>;
  // Kostnadsställen och projekt: every object of the two registers (#OBJEKT).
  listSieObjects(): Promise<{ dimension: 1 | 6; code: string; name: string }[]>;
  findOpeningBalanceVerification(fiscalYearId: string): Promise<{ displayNumber: string } | null>;
  findLatestBookedDateBefore(date: string): Promise<string | null>;
  findAccountByNumberTx(tx: Tx, number: string): Promise<{ id: string } | null>;
  createAccountTx(tx: Tx, input: { number: string; name: string; vatBox: VatBoxSetting | null }): Promise<void>;
}

export function createSieService(deps: {
  db: Db;
  repo: SieRepositoryReader;
  system: SieCompanyReader;
  poster: VerificationPoster;
  programVersion: string;
}) {
  const { db, repo, system, poster, programVersion } = deps;

  return {
    async exportFiscalYear(fiscalYearId: string, signature: string) {
      const year = await repo.findFiscalYearById(fiscalYearId);
      if (!year) throw new SieFiscalYearNotFoundError(fiscalYearId);

      // The comparison year (#RAR -1) is the one ending the day before this
      // one starts. Absent is fine — the spec only wants it when it exists.
      const allYears = await repo.listFiscalYears();
      const previous = allYears.find((candidate) => candidate.endDate < year.startDate);

      const company = (await system.getCompanyInfo()) ?? { name: "", orgNumber: null };

      // Chart of accounts: everything, including deactivated accounts, since
      // a booked row may reference one.
      const accountPage = await repo.listAccounts({ includeInactive: true, limit: 10000, offset: 0 });

      const [current, prior] = await Promise.all([
        readAccountBalances(db, { from: year.startDate, to: year.endDate }),
        previous
          ? readAccountBalances(db, { from: previous.startDate, to: previous.endDate })
          : Promise.resolve([]),
      ]);

      // Debit-positive throughout — the spec's own convention, so an asset
      // comes out positive and a liability negative with no sign flipping.
      const balancesFor = (
        rows: Awaited<ReturnType<typeof readAccountBalances>>,
        yearIndex: number
      ): SieExportData["balances"] =>
        rows.map((row) => ({
          yearIndex,
          accountNumber: row.accountNumber,
          ib: row.openingDebit - row.openingCredit,
          ub: row.openingDebit - row.openingCredit + (row.periodDebit - row.periodCredit),
          res: row.periodDebit - row.periodCredit,
        }));

      const verifications = await repo.listVerificationsForSie(fiscalYearId);
      const objects = await repo.listSieObjects();

      const data: SieExportData = {
        program: { name: "Nav-ERP", version: programVersion },
        generatedDate: new Date().toLocaleDateString("sv-SE"),
        generatedBy: signature,
        company: { name: company.name, orgNumber: company.orgNumber },
        fiscalYears: [
          { yearIndex: 0, startDate: year.startDate, endDate: year.endDate },
          ...(previous
            ? [{ yearIndex: -1, startDate: previous.startDate, endDate: previous.endDate }]
            : []),
        ],
        accounts: accountPage.rows.map((account) => ({
          number: account.number,
          name: account.name,
          type: sieAccountType(account.number),
        })),
        balances: [...balancesFor(current, 0), ...balancesFor(prior, -1)],
        verifications: verifications.map((verification) => ({
          series: verification.seriesCode,
          number: verification.verificationNumber,
          date: verification.date,
          description: verification.description,
          rows: verification.rows.map((row) => ({
            accountNumber: row.accountNumber,
            // #TRANS is debit-positive like the balances.
            amount: Number(row.debit) - Number(row.credit),
            description: row.description,
            costCenterCode: row.costCenterCode,
            projectCode: row.projectCode,
          })),
        })),
        objects,
      };

      return {
        filename: `${company.name ? slug(company.name) : "export"}-${sieDate(year.startDate)}-${sieDate(
          year.endDate
        )}.se`,
        content: buildSieFile(data),
      };
    },

    // Reads #RAR/#KONTO/#IB, creates any missing accounts, and books the
    // balances as ONE verification dated the fiscal year's first day — all
    // in a single transaction, so a rejected file leaves nothing behind.
    async importOpeningBalances(fiscalYearId: string, file: Buffer, userId: string) {
      const year = await repo.findFiscalYearById(fiscalYearId);
      if (!year) throw new SieFiscalYearNotFoundError(fiscalYearId);

      const parsed = parseSieFile(file);
      if (
        parsed.fiscalYear.startDate !== year.startDate ||
        parsed.fiscalYear.endDate !== year.endDate
      ) {
        throw new SieFiscalYearMismatchError(
          `${parsed.fiscalYear.startDate}–${parsed.fiscalYear.endDate}`,
          `${year.startDate}–${year.endDate}`
        );
      }

      // Debit-positive in the file, debit-positive in the ledger — the sum
      // over a complete balance sheet is zero.
      const difference = round2(parsed.openingBalances.reduce((sum, row) => round2(sum + row.amount), 0));
      if (difference !== 0) throw new SieUnbalancedError(difference);

      const existing = await repo.findOpeningBalanceVerification(fiscalYearId);
      if (existing) throw new SieAlreadyImportedError(existing.displayNumber);

      const priorDate = await repo.findLatestBookedDateBefore(year.startDate);
      if (priorDate) throw new SiePriorBookkeepingError(priorDate);

      const nameByNumber = new Map(parsed.accounts.map((account) => [account.number, account.name]));

      return db.transaction(async (tx) => {
        const created: string[] = [];
        const uncreatable: string[] = [];
        for (const balance of parsed.openingBalances) {
          const account = await repo.findAccountByNumberTx(tx, balance.accountNumber);
          if (account) continue;
          if (!/^\d{4}$/.test(balance.accountNumber)) {
            uncreatable.push(balance.accountNumber);
            continue;
          }
          await repo.createAccountTx(tx, {
            number: balance.accountNumber,
            // #KONTO carries the name (within its column); fall back to the
            // number when the file omits the account from its chart.
            name: (nameByNumber.get(balance.accountNumber) ?? balance.accountNumber).slice(0, 100),
            // BAS default or null — an imported unknown VAT account must not
            // get a guessed box; the VAT report warns on its movement.
            vatBox: defaultVatBox(balance.accountNumber),
          });
          created.push(balance.accountNumber);
        }
        // Thrown inside the transaction: the accounts created above go too.
        if (uncreatable.length > 0) throw new SieInvalidAccountNumberError([...new Set(uncreatable)]);

        const resolved = await Promise.all(
          parsed.openingBalances.map(async (balance) => {
            const account = await repo.findAccountByNumberTx(tx, balance.accountNumber);
            return { accountId: account!.id, amount: balance.amount };
          })
        );

        const posted = await poster.postOpeningBalances(
          tx,
          { date: year.startDate, balances: resolved },
          userId
        );

        return {
          verificationId: posted.verificationId,
          displayNumber: posted.displayNumber,
          accountsCreated: created,
          balanceCount: parsed.openingBalances.length,
        };
      });
    },
  };
}

// Filename-safe ASCII slug — the download filename travels in an HTTP header.
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[åä]/g, "a")
      .replace(/ö/g, "o")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "export"
  );
}

export type SieService = ReturnType<typeof createSieService>;
