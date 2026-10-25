import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accountingPeriods,
  costCenters,
  fiscalYears,
  projects,
  sieVerificationImports,
  users,
  verificationSeries,
  verifications,
  type Db,
  type Tx,
} from "@navet/db";
import { round2, type SieMissingObject, type SieVerificationImportFields } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import type { EconomyRepository, VerificationRowWrite } from "../repository/economy.repository.js";
import { defaultVatBox } from "./bas-accounts.js";
import { VerificationSeriesNotFoundError, type EconomyService } from "./economy.service.js";
import { parseSieDocument, type ParsedSieDocument, type ParsedSieTransaction, type ParsedSieVerification } from "./sie-parse.js";

// Kostnadsställen och projekt: the two SIE dimensions the import maps —
// {1 "kod"} to a cost center, {6 "kod"} to a project; every other dimension
// in a #TRANS object list is ignored. The object's name comes from the file's
// #OBJEKT line when it has one; a code the register lacks is created by
// "Skapa saknade konton och objekt" (the same box as the accounts), an
// inactive cost center / closed project is a blocker like an inactive account.
const DIMENSION_COST_CENTER = "1";
const DIMENSION_PROJECT = "6";
const OBJECT_CODE_MAX = 20;
const OBJECT_NAME_MAX = 100;

function rowObjectCode(row: ParsedSieTransaction, dimension: string): string | null {
  return row.objects.find((object) => object.dimension === dimension)?.object ?? null;
}

type ObjectRegisters = {
  costCenters: Map<string, { id: string; code: string; active: boolean }>;
  projects: Map<string, { id: string; code: string; active: boolean; status: string }>;
};

// SIE-import av verifikat (snabbare manuell bokföring, etapp 3): the
// lönejournal from the payroll system, or any SIE 4 file with #VER blocks,
// becomes ordinary verifications in a series of the user's choice (default
// LÖ "Lönejournal", created on first use like the poster's F/L). Preview
// and import run the same checks (checkDocument); the import is ONE
// transaction — a single blocker (unbalanced, date in a locked period or a
// closed year, date outside every fiscal year, a missing account without
// Skapa saknade konton) imports nothing. The file itself is attached as
// underlag to every verification it creates, and its sha256 is the
// dubblettspärr.

export const SIE_IMPORT_SERIES = { code: "LÖ", name: "Lönejournal" } as const;

// An account the chart lacks can only be created when it fits the chart:
// accounts.number is four digits (varchar(4)), names are 100 characters.
const ACCOUNT_NUMBER_RE = /^\d{4}$/;
const ACCOUNT_NAME_MAX = 100;
const ROW_TEXT_MAX = 255;

// The file is stored as underlag on EVERY verification it creates (each
// verification must carry its own räkenskapsinformation), so a big file with
// many verifications multiplies: the preview warns above 50 MB in all and
// the import is refused above 500 MB — split the file instead.
export const UNDERLAG_WARN_BYTES = 50 * 1024 * 1024;
export const UNDERLAG_BLOCK_BYTES = 500 * 1024 * 1024;
export interface UnderlagLimits {
  warnBytes: number;
  blockBytes: number;
}
const DEFAULT_UNDERLAG_LIMITS: UnderlagLimits = { warnBytes: UNDERLAG_WARN_BYTES, blockBytes: UNDERLAG_BLOCK_BYTES };

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} MB`;
}

// Pure: the warning or blocker the duplicated underlag deserves, or null.
export function underlagSizeProblem(
  verificationCount: number,
  fileBytes: number,
  limits: UnderlagLimits = DEFAULT_UNDERLAG_LIMITS
): { kind: "warning" | "blocker"; message: string } | null {
  if (verificationCount <= 0 || fileBytes <= 0) return null;
  const total = verificationCount * fileBytes;
  const size = `${verificationCount} verifikat × ${megabytes(fileBytes)} ≈ ${megabytes(total)}`;
  if (total > limits.blockBytes) {
    return {
      kind: "blocker",
      message: `Filen sparas som underlag på varje verifikat, och ${size} överstiger gränsen ${megabytes(limits.blockBytes)} — dela upp filen i mindre delar`,
    };
  }
  if (total > limits.warnBytes) {
    return {
      kind: "warning",
      message: `Filen sparas som underlag på varje verifikat: ${size} lagras i databasen`,
    };
  }
  return null;
}

// A SIE file has no registered MIME type and is CP437 as often as UTF-8 —
// stored as octet-stream so the browser downloads rather than renders it.
const SIE_FILE_CONTENT_TYPE = "application/octet-stream";

export class SieFileAlreadyImportedError extends Error {
  constructor(
    public readonly importedAt: string,
    public readonly importedBy: string | null
  ) {
    super(`Filen är redan importerad ${importedAt}${importedBy ? ` av ${importedBy}` : ""}`);
    this.name = "SieFileAlreadyImportedError";
  }
}

export class SieVerificationImportBlockedError extends Error {
  constructor(public readonly blockers: string[]) {
    super(`Importen stoppades: ${blockers.join("; ")}`);
    this.name = "SieVerificationImportBlockedError";
  }
}

export interface SiePreviewRow {
  accountNumber: string;
  accountName: string | null;
  amount: number;
  description: string | null;
  transDate: string | null;
}

export interface SiePreviewVerification {
  index: number;
  series: string;
  number: string;
  date: string;
  text: string;
  rows: SiePreviewRow[];
  debit: number;
  credit: number;
  balanced: boolean;
  warnings: string[];
}

export interface SiePreview {
  sha256: string;
  fileName: string;
  program: string | null;
  alreadyImported: { importedAt: string; importedBy: string | null } | null;
  verifications: SiePreviewVerification[];
  missingAccounts: { number: string; name: string | null }[];
  // Kostnadsställen och projekt the rows name that the registers lack.
  missingObjects: SieMissingObject[];
  blockers: string[];
  warnings: string[];
}

type DateStatus = { period: "open" | "locked" | null; yearClosed: boolean };

interface CheckResult {
  verifications: SiePreviewVerification[];
  missingAccounts: { number: string; name: string | null }[];
  missingObjects: SieMissingObject[];
  blockers: string[];
  warnings: string[];
}

export function createSieVerificationImportService(deps: {
  db: Db;
  repo: EconomyRepository;
  economy: EconomyService;
  audit: AuditWriter;
  // Tests lower the underlag thresholds; production uses the constants.
  underlagLimits?: UnderlagLimits;
}) {
  const { db, repo, economy, audit } = deps;
  const underlagLimits = deps.underlagLimits ?? DEFAULT_UNDERLAG_LIMITS;

  // Period + fiscal-year status for every distinct date, one query — through
  // the caller's executor so the import sees what its transaction sees.
  async function dateStatuses(executor: Db | Tx, dates: string[]): Promise<Map<string, DateStatus>> {
    const result = new Map<string, DateStatus>();
    for (const date of new Set(dates)) {
      const [row] = await executor
        .select({ status: accountingPeriods.status, yearStatus: fiscalYears.status })
        .from(accountingPeriods)
        .innerJoin(fiscalYears, eq(fiscalYears.id, accountingPeriods.fiscalYearId))
        .where(and(lte(accountingPeriods.startDate, date), gte(accountingPeriods.endDate, date)));
      result.set(date, row ? { period: row.status, yearClosed: row.yearStatus === "closed" } : { period: null, yearClosed: false });
    }
    return result;
  }

  // The cost centers / projects the file's rows name, by code, through the
  // caller's executor.
  async function loadObjectRegisters(executor: Db | Tx, document: ParsedSieDocument): Promise<ObjectRegisters> {
    const rows = document.verifications.flatMap((v) => v.rows);
    const ccCodes = [...new Set(rows.map((r) => rowObjectCode(r, DIMENSION_COST_CENTER)).filter((c): c is string => c !== null))];
    const prCodes = [...new Set(rows.map((r) => rowObjectCode(r, DIMENSION_PROJECT)).filter((c): c is string => c !== null))];
    const [cc, pr] = await Promise.all([
      ccCodes.length === 0
        ? []
        : executor.select({ id: costCenters.id, code: costCenters.code, active: costCenters.active }).from(costCenters).where(inArray(costCenters.code, ccCodes)),
      prCodes.length === 0
        ? []
        : executor
            .select({ id: projects.id, code: projects.code, active: projects.active, status: projects.status })
            .from(projects)
            .where(inArray(projects.code, prCodes)),
    ]);
    return { costCenters: new Map(cc.map((r) => [r.code, r] as const)), projects: new Map(pr.map((r) => [r.code, r] as const)) };
  }

  // The checks preview and import share. `createMissingAccounts` decides
  // whether a missing account (or object) is a blocker (import) or a warning
  // (preview / import with the box ticked).
  async function checkDocument(executor: Db | Tx, document: ParsedSieDocument, fileBytes: number, createMissingAccounts: boolean): Promise<CheckResult> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (document.verifications.length === 0) blockers.push("Filen innehåller inga verifikat (#VER)");

    // Kostnadsställen och projekt: the objects the rows name.
    const registers = await loadObjectRegisters(executor, document);
    const allRows = document.verifications.flatMap((v) => v.rows);
    const objectName = (dimension: string, code: string) =>
      document.objects.find((o) => o.dimension === dimension && o.code === code)?.name?.slice(0, OBJECT_NAME_MAX) ?? null;
    const missingObjects: SieMissingObject[] = [];
    const uncreatableObjects: string[] = [];
    for (const [dimension, register, label] of [
      [DIMENSION_COST_CENTER, registers.costCenters, "Kostnadsstället"],
      [DIMENSION_PROJECT, registers.projects, "Projektet"],
    ] as const) {
      const codes = [...new Set(allRows.map((r) => rowObjectCode(r, dimension)).filter((c): c is string => c !== null))].sort();
      for (const code of codes) {
        if (register.has(code)) continue;
        if (code.length > OBJECT_CODE_MAX) {
          uncreatableObjects.push(`${label} ${code} har en kod längre än ${OBJECT_CODE_MAX} tecken och kan inte skapas`);
          continue;
        }
        missingObjects.push({ dimension: dimension === DIMENSION_COST_CENTER ? 1 : 6, code, name: objectName(dimension, code) });
      }
    }
    blockers.push(...uncreatableObjects);
    if (missingObjects.length > 0) {
      const names = missingObjects.map((o) => `${o.dimension === 1 ? "kostnadsställe" : "projekt"} ${o.code}`).join(", ");
      if (createMissingAccounts) warnings.push(`${missingObjects.length} objekt saknas i registren och skapas: ${names}`);
      else blockers.push(`Objektet ${names} finns inte i registren — välj Skapa saknade konton och objekt eller lägg upp dem först`);
    }
    const inactiveCostCenters = [...registers.costCenters.values()].filter((c) => !c.active).map((c) => c.code).sort();
    if (inactiveCostCenters.length > 0) blockers.push(`Kostnadsstället ${inactiveCostCenters.join(", ")} är inaktivt`);
    const closedProjects = [...registers.projects.values()].filter((p) => !p.active || p.status === "closed").map((p) => p.code).sort();
    if (closedProjects.length > 0) blockers.push(`Projektet ${closedProjects.join(", ")} är stängt`);

    const numbers = document.verifications.flatMap((v) => v.rows.map((r) => r.accountNumber));
    const accounts = await repo.accountsByNumbers(executor, numbers);
    const fileNames = new Map(document.accounts.map((a) => [a.number, a.name] as const));
    const missingNumbers = [...new Set(numbers.filter((n) => !accounts.has(n)))].sort();
    // A missing account that does not fit the chart can never be created —
    // a blocker whatever the box says (it used to reach Postgres as a 500).
    const uncreatable = missingNumbers.filter((n) => !ACCOUNT_NUMBER_RE.test(n));
    const creatable = missingNumbers.filter((n) => ACCOUNT_NUMBER_RE.test(n));
    const missingAccounts = creatable.map((number) => ({ number, name: fileNames.get(number)?.slice(0, ACCOUNT_NAME_MAX) ?? null }));
    const inactive = [...new Set(numbers.filter((n) => accounts.get(n)?.active === false))].sort();
    for (const number of uncreatable) blockers.push(`Kontot ${number} har inte fyra siffror och kan inte skapas`);
    if (creatable.length > 0) {
      if (createMissingAccounts) warnings.push(`${creatable.length} konton saknas i kontoplanen och skapas: ${creatable.join(", ")}`);
      else blockers.push(`Kontot ${creatable.join(", ")} finns inte i kontoplanen — välj Skapa saknade konton eller lägg upp dem först`);
    }
    if (inactive.length > 0) blockers.push(`Kontot ${inactive.join(", ")} är inaktivt`);

    const underlag = underlagSizeProblem(document.verifications.length, fileBytes, underlagLimits);
    if (underlag?.kind === "blocker") blockers.push(underlag.message);
    else if (underlag) warnings.push(underlag.message);

    const statuses = await dateStatuses(
      executor,
      document.verifications.map((v) => v.date)
    );

    const verifications = document.verifications.map((v, index): SiePreviewVerification => {
      const own: string[] = [];
      const rows = v.rows.filter((r) => r.amount !== 0);
      if (rows.length < v.rows.length) own.push(`${v.rows.length - rows.length} rad(er) med belopp 0 hoppas över`);
      const debit = round2(rows.filter((r) => r.amount > 0).reduce((sum, r) => sum + r.amount, 0));
      const credit = round2(rows.filter((r) => r.amount < 0).reduce((sum, r) => sum - r.amount, 0));
      const balanced = debit === credit && rows.length >= 2;
      const label = `Ver ${v.series} ${v.number}`.trim();
      if (rows.length < 2) {
        own.push("Färre än två rader");
        blockers.push(`${label} har färre än två rader`);
      } else if (debit !== credit) {
        own.push(`Balanserar inte (debet ${debit}, kredit ${credit})`);
        blockers.push(`${label} balanserar inte (debet ${debit}, kredit ${credit})`);
      }
      const status = statuses.get(v.date)!;
      if (status.period === null) {
        own.push("Datumet ligger utanför alla räkenskapsår");
        blockers.push(`${label}: datumet ${v.date} ligger utanför alla räkenskapsår`);
      } else if (status.yearClosed) {
        own.push("Räkenskapsåret är stängt");
        blockers.push(`${label}: räkenskapsåret för ${v.date} är stängt`);
      } else if (status.period === "locked") {
        own.push("Perioden är låst");
        blockers.push(`${label}: perioden för ${v.date} är låst`);
      }
      for (const row of rows) {
        if (!accounts.has(row.accountNumber)) own.push(`Konto ${row.accountNumber} saknas`);
        const cc = rowObjectCode(row, DIMENSION_COST_CENTER);
        if (cc !== null && !registers.costCenters.has(cc)) own.push(`Kostnadsställe ${cc} saknas`);
        const pr = rowObjectCode(row, DIMENSION_PROJECT);
        if (pr !== null && !registers.projects.has(pr)) own.push(`Projekt ${pr} saknas`);
      }
      return {
        index,
        series: v.series,
        number: v.number,
        date: v.date,
        text: v.text,
        rows: rows.map((r) => ({
          accountNumber: r.accountNumber,
          accountName: accounts.get(r.accountNumber)?.name ?? null,
          amount: r.amount,
          description: rowText(r.description),
          transDate: r.transDate,
        })),
        debit,
        credit,
        balanced,
        warnings: [...new Set(own)],
      };
    });

    return { verifications, missingAccounts, missingObjects, blockers: [...new Set(blockers)], warnings };
  }

  // Skapa saknade konton och objekt: the cost centers / projects the rows
  // name but the registers lack, inside the import's transaction. ON CONFLICT
  // on the code (a concurrent import or user may have created one meanwhile).
  async function createMissingObjects(tx: Tx, missing: SieMissingObject[]) {
    for (const object of missing) {
      if (object.dimension === 1) {
        await tx.insert(costCenters).values({ code: object.code, name: object.name ?? object.code }).onConflictDoNothing({ target: costCenters.code });
      } else {
        await tx.insert(projects).values({ code: object.code, name: object.name ?? object.code }).onConflictDoNothing({ target: projects.code });
      }
    }
  }

  async function findImport(sha256: string) {
    const [row] = await db
      .select({ importedAt: sieVerificationImports.importedAt, importedBy: users.name })
      .from(sieVerificationImports)
      .leftJoin(users, eq(users.id, sieVerificationImports.importedBy))
      .where(eq(sieVerificationImports.sha256, sha256));
    return row ? { importedAt: row.importedAt.toISOString(), importedBy: row.importedBy ?? null } : null;
  }

  function sha(file: Buffer) {
    return createHash("sha256").update(file).digest("hex");
  }

  // A row's text within its column (255), like the header's description —
  // the preview shows what the import will store.
  function rowText(description: string | null): string | null {
    return description === null ? null : description.slice(0, ROW_TEXT_MAX);
  }

  // "<text> (SIE-import ver <serie> <nr>)", within the column.
  function importDescription(v: ParsedSieVerification): string {
    const suffix = ` (SIE-import ver ${v.series} ${v.number})`.replace(/\s+/g, " ");
    const text = v.text.trim() || "Importerat verifikat";
    return `${text.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
  }

  return {
    async preview(file: Buffer, fileName: string): Promise<SiePreview> {
      const document = parseSieDocument(file);
      const sha256 = sha(file);
      const [alreadyImported, check] = await Promise.all([findImport(sha256), checkDocument(db, document, file.length, true)]);
      // At preview a missing account is information (the box decides at
      // import), so it is a warning here and the blockers hold the rest.
      return { sha256, fileName, program: document.program, alreadyImported, ...check };
    },

    async import(file: Buffer, fileName: string, fields: SieVerificationImportFields, userId: string) {
      const document = parseSieDocument(file);
      const sha256 = sha(file);
      const existing = await findImport(sha256);
      if (existing) throw new SieFileAlreadyImportedError(existing.importedAt, existing.importedBy);
      if (fields.seriesId && !(await repo.findSeriesById(fields.seriesId))) throw new VerificationSeriesNotFoundError(fields.seriesId);

      const result = await db.transaction(async (tx) => {
        // The dubblettspärr first: a concurrent import of the same file
        // blocks on this row until we commit, then sees the violation.
        try {
          await tx.insert(sieVerificationImports).values({
            sha256,
            fileName: fileName.slice(0, 255),
            verificationCount: document.verifications.length,
            importedBy: userId,
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw new SieDuplicateSignal();
          throw err;
        }

        const check = await checkDocument(tx, document, file.length, fields.createMissingAccounts);
        if (check.blockers.length > 0) throw new SieVerificationImportBlockedError(check.blockers);

        for (const missing of check.missingAccounts) {
          await repo.createAccountTx(tx, {
            number: missing.number,
            name: missing.name ?? missing.number,
            // BAS default or null — a guessed VAT box is worse than none.
            vatBox: defaultVatBox(missing.number),
          });
        }
        await createMissingObjects(tx, check.missingObjects);
        const registers = await loadObjectRegisters(tx, document);

        const series = fields.seriesId
          ? { id: fields.seriesId }
          : await repo.ensureSeriesTx(tx, { code: SIE_IMPORT_SERIES.code, name: SIE_IMPORT_SERIES.name });
        const accounts = await repo.accountsByNumbers(
          tx,
          document.verifications.flatMap((v) => v.rows.map((r) => r.accountNumber))
        );

        const created: { id: string; verificationNumber: number | null; date: string; description: string }[] = [];
        for (const v of document.verifications) {
          const rows: VerificationRowWrite[] = v.rows
            .filter((r) => r.amount !== 0)
            .map((r) => {
              const cc = rowObjectCode(r, DIMENSION_COST_CENTER);
              const pr = rowObjectCode(r, DIMENSION_PROJECT);
              return {
                accountId: accounts.get(r.accountNumber)!.id,
                debit: r.amount > 0 ? round2(r.amount) : 0,
                credit: r.amount < 0 ? round2(-r.amount) : 0,
                description: rowText(r.description),
                costCenterId: cc !== null ? (registers.costCenters.get(cc)?.id ?? null) : null,
                projectId: pr !== null ? (registers.projects.get(pr)?.id ?? null) : null,
              };
            });
          const description = importDescription(v);
          const { id, verificationNumber } = await economy.createVerificationInTx(
            tx,
            { seriesId: series.id, date: v.date, description, rows },
            userId,
            { book: fields.mode === "book" }
          );
          await repo.addVerificationFileTx(tx, {
            verificationId: id,
            filename: fileName.slice(0, 255),
            contentType: SIE_FILE_CONTENT_TYPE,
            sizeBytes: file.length,
            sha256,
            data: file,
            uploadedBy: userId,
          });
          created.push({ id, verificationNumber, date: v.date, description });
        }
        return {
          created,
          seriesId: series.id,
          accountsCreated: check.missingAccounts.map((a) => a.number),
          objectsCreated: check.missingObjects.map((o) => `${o.dimension}:${o.code}`),
        };
      }).catch(async (err) => {
        if (err instanceof SieDuplicateSignal) {
          const now = await findImport(sha256);
          throw new SieFileAlreadyImportedError(now?.importedAt ?? new Date().toISOString(), now?.importedBy ?? null);
        }
        throw err;
      });

      // Display numbers from the committed rows (series code + year label).
      const ids = result.created.map((c) => c.id);
      const numbered = await displayNumbers(db, ids);
      await audit.log({
        entityType: "sie_import",
        entityId: sha256.slice(0, 16),
        action: "verifications_imported",
        detail: {
          fileName,
          count: ids.length,
          mode: fields.mode,
          accountsCreated: result.accountsCreated,
          objectsCreated: result.objectsCreated,
          seriesId: result.seriesId,
        },
        userId,
      });
      return {
        imported: ids.length,
        verifications: result.created.map((c) => ({
          id: c.id,
          displayNumber: numbered.get(c.id) ?? null,
          date: c.date,
          description: c.description,
        })),
      };
    },
  };

  async function displayNumbers(executor: Db, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await executor
      .select({
        id: verifications.id,
        status: verifications.status,
        number: verifications.verificationNumber,
        code: verificationSeries.code,
        year: fiscalYears.label,
      })
      .from(verifications)
      .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
      .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
      .where(inArray(verifications.id, ids));
    return new Map(
      rows.filter((r) => r.status === "booked" && r.number !== null).map((r) => [r.id, `${r.code}-${r.year}-${r.number}`] as const)
    );
  }
}

// Internal: the sha256 row already exists — turned into
// SieFileAlreadyImportedError outside the transaction.
class SieDuplicateSignal extends Error {}

export type SieVerificationImportService = ReturnType<typeof createSieVerificationImportService>;
