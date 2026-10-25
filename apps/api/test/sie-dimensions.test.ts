import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { costCenters, db, projects, verificationRows } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { decodeCp437, encodeCp437 } from "../src/modules/economy/service/sie-encoding.js";
import { buildSieFile, sieObjectList, type SieExportData } from "../src/modules/economy/service/sie-export.js";
import { parseSieDocument } from "../src/modules/economy/service/sie-parse.js";
import { createSieService } from "../src/modules/economy/service/sie.service.js";
import { createSieVerificationImportService, SieVerificationImportBlockedError } from "../src/modules/economy/service/sie-verification-import.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";

// SIE with kostnadsställen och projekt: the export declares #DIM 1/#DIM 6
// with their #OBJEKT lines and writes {1 "kod" 6 "kod"} on #TRANS; the
// verification import maps the object lists back to the registers, lists
// what is missing (missingObjects) and creates it with Skapa saknade konton
// och objekt.

const repo = createEconomyRepository(db);
const economy = createEconomyService(repo, { log: async () => {} });
const sieImport = createSieVerificationImportService({ db, repo, economy, audit: { log: async () => {} } });
const sie = createSieService({
  db,
  repo,
  system: { getCompanyInfo: async () => ({ name: "Test AB", orgNumber: null }) },
  poster: createVerificationPoster({ read: async () => ({}) as never }),
  programVersion: "test",
});
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE sie_verification_imports, verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, cost_centers, projects, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = 2031;

const BASE: SieExportData = {
  program: { name: "Nav-ERP", version: "1.0" },
  generatedDate: "2026-08-07",
  generatedBy: "urban",
  company: { name: "Test AB", orgNumber: null },
  fiscalYears: [{ yearIndex: 0, startDate: "2026-01-01", endDate: "2026-12-31" }],
  accounts: [{ number: "3001", name: "Försäljning", type: "I" }],
  balances: [],
  verifications: [
    {
      series: "A",
      number: 1,
      date: "2026-02-10",
      description: "Försäljning",
      rows: [
        { accountNumber: "1930", amount: 1000, description: null },
        { accountNumber: "3001", amount: -1000, description: "Rad", costCenterCode: "100", projectCode: "P1" },
        { accountNumber: "3001", amount: 0, description: null, costCenterCode: null, projectCode: "P1" },
      ],
    },
  ],
};

describe("buildSieFile — dimensions", () => {
  it("declares the two fixed dimensions and their objects, and writes the object list on #TRANS", () => {
    const lines = decodeCp437(
      buildSieFile({
        ...BASE,
        objects: [
          { dimension: 1, code: "100", name: "Verkstad" },
          { dimension: 6, code: "P1", name: "Storköket" },
        ],
      })
    ).split("\r\n");
    const dimIndex = lines.indexOf('#DIM 1 "Kostnadsställe"');
    expect(dimIndex).toBeGreaterThan(lines.indexOf("#KTYP 3001 I"));
    expect(lines[dimIndex + 1]).toBe('#OBJEKT 1 "100" "Verkstad"');
    expect(lines[dimIndex + 2]).toBe('#DIM 6 "Projekt"');
    expect(lines[dimIndex + 3]).toBe('#OBJEKT 6 "P1" "Storköket"');
    expect(lines).toContain("\t#TRANS 1930 {} 1000");
    expect(lines).toContain('\t#TRANS 3001 {1 "100" 6 "P1"} -1000 "" "Rad"');
    expect(lines).toContain('\t#TRANS 3001 {6 "P1"} 0');
  });

  it("writes no #DIM when the registers are empty, and {} for a row without objects", () => {
    const text = decodeCp437(buildSieFile(BASE));
    expect(text).not.toContain("#DIM");
    expect(text).not.toContain("#OBJEKT");
    expect(sieObjectList({})).toBe("{}");
    expect(sieObjectList({ costCenterCode: "10 A" })).toBe('{1 "10 A"}');
  });

  it("the parser reads #OBJEKT lines and the object list of a #TRANS", () => {
    const document = parseSieDocument(
      encodeCp437(
        ['#FLAGGA 0', '#DIM 1 "Kostnadsställe"', '#OBJEKT 1 "100" "Verkstad"', '#OBJEKT 6 P1', `#VER A 1 ${YEAR}0110 "X"`, "{", '#TRANS 3001 {1 "100" 6 "P1"} -10.00', "#TRANS 1930 {} 10.00", "}", ""].join("\r\n")
      )
    );
    expect(document.objects).toEqual([
      { dimension: "1", code: "100", name: "Verkstad" },
      { dimension: "6", code: "P1", name: null },
    ]);
    expect(document.verifications[0]!.rows[0]!.objects).toEqual([
      { dimension: "1", object: "100" },
      { dimension: "6", object: "P1" },
    ]);
  });
});

async function setup() {
  const user = await authRepo.create({ email: `sie-dim-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  const year = await economy.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await economy.createSeries({ code: "A", name: "Manuella verifikat" });
  const accounts: Record<string, { id: string }> = {};
  for (const [number, name] of [
    ["1930", "Företagskonto"],
    ["7210", "Löner tjänstemän"],
    ["2710", "Personalskatt"],
  ]) {
    accounts[number!] = await economy.createAccount({ number: number!, name: name! });
  }
  return { user, year, series, accounts };
}

function journal(objectLines: string[], trans: string) {
  return encodeCp437(
    [
      "#FLAGGA 0",
      '#PROGRAM "Lönesystemet" 2.4',
      "#FORMAT PC8",
      "#SIETYP 4",
      `#RAR 0 ${YEAR}0101 ${YEAR}1231`,
      ...objectLines,
      `#VER "LÖ" "1" ${YEAR}0125 "Lön januari"`,
      "{",
      trans,
      "#TRANS 2710 {} -9000.00",
      "#TRANS 1930 {} -21000.00",
      "}",
      "",
    ].join("\r\n")
  );
}

describe("export through the service", () => {
  it("lists every object of the registers (inactive too) and the codes a booked row carries", async () => {
    const { user, year, series, accounts } = await setup();
    const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
    await db.insert(costCenters).values({ code: "900", name: "Nedlagt", active: false });
    const [project] = await db.insert(projects).values({ code: "P1", name: "Storköket" }).returning();
    await economy.createVerification(
      {
        seriesId: series.id,
        date: `${YEAR}-02-10`,
        description: "Lön",
        rows: [
          { accountId: accounts["7210"]!.id, debit: 100, credit: 0, costCenterId: workshop!.id, projectId: project!.id },
          { accountId: accounts["1930"]!.id, debit: 0, credit: 100 },
        ],
        book: true,
      },
      user.id
    );
    const file = await sie.exportFiscalYear(year.id, "test");
    const text = decodeCp437(file.content);
    expect(text).toContain('#DIM 1 "Kostnadsställe"\r\n#OBJEKT 1 "100" "Verkstad"\r\n#OBJEKT 1 "900" "Nedlagt"');
    expect(text).toContain('#DIM 6 "Projekt"\r\n#OBJEKT 6 "P1" "Storköket"');
    expect(text).toContain('#TRANS 7210 {1 "100" 6 "P1"} 100');
    expect(text).toContain("#TRANS 1930 {} -100");
  });
});

describe("import of verifications with objects", () => {
  it("lists the missing objects with their #OBJEKT names in the preview and blocks the import unless the box is ticked", async () => {
    const { user } = await setup();
    const file = journal(['#DIM 1 "Kostnadsställe"', '#OBJEKT 1 "100" "Verkstad"', '#OBJEKT 6 "P1" "Storköket"'], '#TRANS 7210 {1 "100" 6 "P1"} 30000.00');
    const preview = await sieImport.preview(file, "lon.se");
    expect(preview.missingObjects).toEqual([
      { dimension: 1, code: "100", name: "Verkstad" },
      { dimension: 6, code: "P1", name: "Storköket" },
    ]);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toEqual(["2 objekt saknas i registren och skapas: kostnadsställe 100, projekt P1"]);
    expect(preview.verifications[0]!.warnings).toEqual(["Kostnadsställe 100 saknas", "Projekt P1 saknas"]);

    await expect(sieImport.import(file, "lon.se", { seriesId: undefined, mode: "draft", createMissingAccounts: false }, user.id)).rejects.toBeInstanceOf(
      SieVerificationImportBlockedError
    );
    expect(await db.select().from(costCenters)).toEqual([]);

    const result = await sieImport.import(file, "lon.se", { seriesId: undefined, mode: "book", createMissingAccounts: true }, user.id);
    expect(result.imported).toBe(1);
    const [cc] = await db.select().from(costCenters);
    const [pr] = await db.select().from(projects);
    expect(cc).toMatchObject({ code: "100", name: "Verkstad", active: true });
    expect(pr).toMatchObject({ code: "P1", name: "Storköket", status: "open" });
    const rows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, result.verifications[0]!.id));
    const salary = rows.find((r) => Number(r.debit) === 30000)!;
    expect(salary.costCenterId).toBe(cc!.id);
    expect(salary.projectId).toBe(pr!.id);
    expect(rows.filter((r) => r.costCenterId === null)).toHaveLength(2);
  });

  it("maps existing objects by code, names a nameless missing one by its code, and blocks on a closed project", async () => {
    const { user } = await setup();
    const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
    const file = journal([], '#TRANS 7210 {1 "100" 6 "P2" 3 "Ignorerad"} 30000.00');
    const preview = await sieImport.preview(file, "lon.se");
    expect(preview.missingObjects).toEqual([{ dimension: 6, code: "P2", name: null }]);
    const result = await sieImport.import(file, "lon.se", { seriesId: undefined, mode: "draft", createMissingAccounts: true }, user.id);
    const [project] = await db.select().from(projects);
    expect(project).toMatchObject({ code: "P2", name: "P2" });
    const rows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, result.verifications[0]!.id));
    expect(rows.find((r) => Number(r.debit) === 30000)).toMatchObject({ costCenterId: workshop!.id, projectId: project!.id });

    await db.update(projects).set({ status: "closed" }).where(eq(projects.id, project!.id));
    const again = await sieImport.preview(journal([], '#TRANS 7210 {6 "P2"} 30000.00'), "lon2.se");
    expect(again.blockers).toEqual(["Projektet P2 är stängt"]);
  });
});
