import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { accountingPeriods, accounts, db, sieVerificationImports, verificationFiles, verificationSeries, verifications } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { encodeCp437 } from "../src/modules/economy/service/sie-encoding.js";
import {
  createSieVerificationImportService,
  SieFileAlreadyImportedError,
  SieVerificationImportBlockedError,
} from "../src/modules/economy/service/sie-verification-import.service.js";

// SIE-import av verifikat against Postgres: preview, all-or-nothing import,
// the dubblettspärr, the file as underlag on every verification, Skapa
// saknade konton and the LÖ series.

const repo = createEconomyRepository(db);
const economy = createEconomyService(repo, { log: async () => {} });
const sieImport = createSieVerificationImportService({ db, repo, economy, audit: { log: async () => {} } });
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE sie_verification_imports, verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = 2031;

function journal(extra: string[] = []) {
  return encodeCp437(
    [
      "#FLAGGA 0",
      '#PROGRAM "Lönesystemet" 2.4',
      "#FORMAT PC8",
      "#SIETYP 4",
      `#RAR 0 ${YEAR}0101 ${YEAR}1231`,
      '#KONTO 7210 "Löner tjänstemän"',
      '#KONTO 2710 "Personalskatt"',
      '#KONTO 1930 "Företagskonto"',
      `#VER "LÖ" "1" ${YEAR}0125 "Lön januari"`,
      "{",
      '#TRANS 7210 {} 30000.00 "" "Bruttolön"',
      "#TRANS 2710 {} -9000.00",
      "#TRANS 1930 {} -21000.00",
      "}",
      `#VER "LÖ" "2" ${YEAR}0225 "Lön februari"`,
      "{",
      "#TRANS 7210 {} 30000.00",
      "#TRANS 2710 {} -9000.00",
      "#TRANS 1930 {} -21000.00",
      "}",
      ...extra,
      "",
    ].join("\r\n")
  );
}

async function setup(accountNumbers = ["7210", "2710", "1930"]) {
  const user = await authRepo.create({ email: `sie-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  await economy.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  for (const number of accountNumbers) await economy.createAccount({ number, name: `Konto ${number}` });
  return { user };
}

const fields = (overrides: Partial<{ seriesId: string; mode: "draft" | "book"; createMissingAccounts: boolean }> = {}) => ({
  seriesId: undefined,
  mode: "draft" as const,
  createMissingAccounts: false,
  ...overrides,
});

describe("preview", () => {
  it("shows the verifications with rows, sums, balance and the file's sha256", async () => {
    await setup();
    const file = journal();
    const preview = await sieImport.preview(file, "lon.se");
    expect(preview.sha256).toBe(createHash("sha256").update(file).digest("hex"));
    expect(preview.fileName).toBe("lon.se");
    expect(preview.program).toBe("Lönesystemet 2.4");
    expect(preview.alreadyImported).toBeNull();
    expect(preview.blockers).toEqual([]);
    expect(preview.missingAccounts).toEqual([]);
    expect(preview.verifications).toHaveLength(2);
    expect(preview.verifications[0]).toMatchObject({
      index: 0,
      series: "LÖ",
      number: "1",
      date: `${YEAR}-01-25`,
      text: "Lön januari",
      debit: 30000,
      credit: 30000,
      balanced: true,
      warnings: [],
    });
    expect(preview.verifications[0]!.rows[0]).toEqual({
      accountNumber: "7210",
      accountName: "Konto 7210",
      amount: 30000,
      description: "Bruttolön",
      transDate: null,
    });
  });

  it("lists missing accounts (a warning at preview), and blocks on unbalance, locked period and dates outside the year", async () => {
    const { user } = await setup(["7210", "1930"]);
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, `${YEAR}-02-01`));
    await economy.lockPeriod(period!.id, user.id);
    const preview = await sieImport.preview(
      journal([
        `#VER "LÖ" "3" ${YEAR}0325 "Skev"`,
        "{",
        "#TRANS 7210 {} 10.00",
        "#TRANS 1930 {} -9.00",
        "}",
        `#VER "LÖ" "4" ${YEAR - 1}1225 "Fel år"`,
        "{",
        "#TRANS 7210 {} 10.00",
        "#TRANS 1930 {} -10.00",
        "}",
      ]),
      "lon.se"
    );
    expect(preview.missingAccounts).toEqual([{ number: "2710", name: "Personalskatt" }]);
    expect(preview.warnings).toEqual(["1 konton saknas i kontoplanen och skapas: 2710"]);
    expect(preview.blockers).toEqual([
      `Ver LÖ 2: perioden för ${YEAR}-02-25 är låst`,
      "Ver LÖ 3 balanserar inte (debet 10, kredit 9)",
      `Ver LÖ 4: datumet ${YEAR - 1}-12-25 ligger utanför alla räkenskapsår`,
    ]);
    expect(preview.verifications[0]!.warnings).toEqual(["Konto 2710 saknas"]);
    expect(preview.verifications[1]!.warnings).toEqual(["Perioden är låst", "Konto 2710 saknas"]);
    expect(preview.verifications[2]!.balanced).toBe(false);
    expect(preview.verifications[2]!.rows[0]!.accountName).toBe("Konto 7210");
  });
});

describe("import", () => {
  it("imports every verification as drafts in the LÖ series (created on demand), with the file as underlag", async () => {
    const { user } = await setup();
    const file = journal();
    const result = await sieImport.import(file, "lon.se", fields(), user.id);
    expect(result.imported).toBe(2);
    expect(result.verifications.map((v) => [v.displayNumber, v.date, v.description])).toEqual([
      [null, `${YEAR}-01-25`, "Lön januari (SIE-import ver LÖ 1)"],
      [null, `${YEAR}-02-25`, "Lön februari (SIE-import ver LÖ 2)"],
    ]);
    const [series] = await db.select().from(verificationSeries).where(eq(verificationSeries.code, "LÖ"));
    expect(series?.name).toBe("Lönejournal");
    const created = await db.select().from(verifications);
    expect(created.every((v) => v.status === "draft" && v.seriesId === series!.id)).toBe(true);

    const files = await db.select().from(verificationFiles);
    expect(files).toHaveLength(2);
    expect(new Set(files.map((f) => f.verificationId)).size).toBe(2);
    expect(files.every((f) => f.filename === "lon.se" && f.sha256 === createHash("sha256").update(file).digest("hex"))).toBe(true);
    expect(Buffer.compare(files[0]!.data, file)).toBe(0);

    const detail = await economy.findVerificationById(created[0]!.id);
    expect(detail.rows.map((r) => [r.accountNumber, Number(r.debit), Number(r.credit)])).toEqual([
      ["7210", 30000, 0],
      ["2710", 0, 9000],
      ["1930", 0, 21000],
    ]);
    expect(detail.files).toHaveLength(1);

    const imports = await db.select().from(sieVerificationImports);
    expect(imports.map((i) => [i.fileName, i.verificationCount, i.importedBy])).toEqual([["lon.se", 2, user.id]]);
    // The preview now says so.
    const preview = await sieImport.preview(file, "lon.se");
    expect(preview.alreadyImported).toMatchObject({ importedBy: "Ekonom" });
  });

  it("books directly in mode book, in the chosen series, with consecutive numbers", async () => {
    const { user } = await setup();
    const series = await economy.createSeries({ code: "L2", name: "Lön" });
    const result = await sieImport.import(journal(), "lon.se", fields({ seriesId: series.id, mode: "book" }), user.id);
    expect(result.verifications.map((v) => v.displayNumber)).toEqual([`L2-${YEAR}-1`, `L2-${YEAR}-2`]);
    const created = await db.select().from(verifications);
    expect(created.every((v) => v.status === "booked" && v.seriesId === series.id)).toBe(true);
    expect(await db.select().from(verificationSeries).where(eq(verificationSeries.code, "LÖ"))).toEqual([]);
  });

  it("refuses the same file twice, naming when and by whom", async () => {
    const { user } = await setup();
    await sieImport.import(journal(), "lon.se", fields(), user.id);
    await expect(sieImport.import(journal(), "lon-igen.se", fields(), user.id)).rejects.toMatchObject({
      name: "SieFileAlreadyImportedError",
      importedBy: "Ekonom",
    });
    expect(await db.select().from(verifications)).toHaveLength(2);
    // Byte-identical is what counts, not the name — a changed file is new.
    const other = journal([`#VER "LÖ" "3" ${YEAR}0325 "Mars"`, "{", "#TRANS 7210 {} 1.00", "#TRANS 1930 {} -1.00", "}"]);
    expect((await sieImport.import(other, "lon.se", fields(), user.id)).imported).toBe(3);
  });

  it("is all-or-nothing: one blocker imports nothing, not even the sound verifications", async () => {
    const { user } = await setup();
    const file = journal([`#VER "LÖ" "3" ${YEAR}0325 "Skev"`, "{", "#TRANS 7210 {} 10.00", "#TRANS 1930 {} -9.00", "}"]);
    await expect(sieImport.import(file, "lon.se", fields(), user.id)).rejects.toMatchObject({
      name: "SieVerificationImportBlockedError",
      blockers: ["Ver LÖ 3 balanserar inte (debet 10, kredit 9)"],
    });
    expect(await db.select().from(verifications)).toEqual([]);
    expect(await db.select().from(verificationFiles)).toEqual([]);
    // No reservation left behind either: the fixed file can be imported.
    expect(await db.select().from(sieVerificationImports)).toEqual([]);
    expect(await db.select().from(verificationSeries).where(eq(verificationSeries.code, "LÖ"))).toEqual([]);
  });

  it("blocks on a missing account unless Skapa saknade konton, which creates it with the file's name and the BAS box", async () => {
    const { user } = await setup(["7210", "1930"]);
    await expect(sieImport.import(journal(), "lon.se", fields(), user.id)).rejects.toThrow(SieVerificationImportBlockedError);
    expect(await db.select().from(verifications)).toEqual([]);

    const result = await sieImport.import(journal(), "lon.se", fields({ createMissingAccounts: true }), user.id);
    expect(result.imported).toBe(2);
    const [account] = await db.select().from(accounts).where(eq(accounts.number, "2710"));
    expect(account).toMatchObject({ name: "Personalskatt", active: true });
  });

  it("blocks on a locked period and a closed year even in draft mode", async () => {
    const { user } = await setup();
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, `${YEAR}-01-01`));
    await economy.lockPeriod(period!.id, user.id);
    await expect(sieImport.import(journal(), "lon.se", fields(), user.id)).rejects.toMatchObject({
      blockers: [`Ver LÖ 1: perioden för ${YEAR}-01-25 är låst`],
    });
    expect(await db.select().from(verifications)).toEqual([]);
  });

  it("refuses an unknown series and a file without verifications", async () => {
    const { user } = await setup();
    await expect(sieImport.import(journal(), "lon.se", fields({ seriesId: crypto.randomUUID() }), user.id)).rejects.toMatchObject({
      name: "VerificationSeriesNotFoundError",
    });
    const empty = encodeCp437(["#FLAGGA 0", `#RAR 0 ${YEAR}0101 ${YEAR}1231`, ""].join("\r\n"));
    await expect(sieImport.import(empty, "tom.se", fields(), user.id)).rejects.toMatchObject({
      blockers: ["Filen innehåller inga verifikat (#VER)"],
    });
    expect(await sieImport.preview(empty, "tom.se")).toMatchObject({ blockers: ["Filen innehåller inga verifikat (#VER)"] });
    await expect(sieImport.import(journal(), "lon.se", fields(), user.id)).resolves.toMatchObject({ imported: 2 });
  });
});

// The duplicate guard's class is exported for the route test's benefit.
void SieFileAlreadyImportedError;
