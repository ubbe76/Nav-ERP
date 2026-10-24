import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db, systemSettings, vatCodes } from "@navet/db";
import { VAT_CODES, VAT_CODE_CATALOG } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createVatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { createVatCodeService } from "../src/modules/economy/service/vat-code.service.js";
import { createFinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import { economyRoutes } from "../src/modules/economy/routes/economy.routes.js";
import type { SieService } from "../src/modules/economy/service/sie.service.js";
import type { AuditEntry } from "../src/modules/system/repository/audit.repository.js";
import {
  VAT_CONTACT_EMAIL_KEY,
  VAT_CONTACT_NAME_KEY,
  VAT_CONTACT_PHONE_KEY,
  VAT_REPORTING_PERIOD_KEY,
} from "../src/modules/system/service/vat-reporting-settings.js";
import { resetVatCodes, vatCodeId } from "./helpers/vat-codes.js";

// Momskoder's routes: the register (GET/PATCH /vat-codes), the importmoms
// posting, the declaration file and the VAT reporting settings — contract
// and error mapping on a bare app (permissions are permissions-coverage's).

const repo = testEconomyRepository;
const service = testEconomyService;
const authRepo = createAuthRepository(db);

const SETTINGS = {
  postingAccountsReceivable: "1510",
  postingAccountsPayable: "2440",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  postingVatSettlement: "2650",
  postingInventory: "1460",
  postingInventoryChange: "4990",
};
const settingsReader = { read: async () => SETTINGS };
const poster = createVerificationPoster(settingsReader);
const audited: AuditEntry[] = [];
const audit = { log: async (entry: AuditEntry) => void audited.push(entry) };
let orgNumber: string | null = "5560000175";
const vatReport = createVatReportService({
  db,
  poster,
  settings: settingsReader,
  company: { orgNumber: async () => orgNumber },
  audit,
});
const vatCodeService = createVatCodeService({ db, poster, audit });
const reports = createFinancialReportsService({ db, repo });

const TRUNCATE = sql`TRUNCATE vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;
const VAT_SETTING_KEYS = [VAT_REPORTING_PERIOD_KEY, VAT_CONTACT_NAME_KEY, VAT_CONTACT_PHONE_KEY, VAT_CONTACT_EMAIL_KEY];

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
  await db.delete(systemSettings).where(inArray(systemSettings.key, VAT_SETTING_KEYS));
  audited.length = 0;
  orgNumber = "5560000175";
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
  await db.delete(systemSettings).where(inArray(systemSettings.key, VAT_SETTING_KEYS));
});

const YEAR = new Date().getFullYear();
const MAR = { from: `${YEAR}-03-01`, to: `${YEAR}-03-31` };

async function setupEconomy() {
  const user = await authRepo.create({
    email: `vat-codes-route-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  await service.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  await service.createSeries({ code: "A", name: "Manuella verifikat" });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user };
}

function buildApp(userId: string) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "test@example.com", name: "Testanvändare", role: "admin" } as never;
  });
  app.register(economyRoutes, {
    service,
    vatReport,
    reports,
    sie: {} as unknown as SieService,
    vatCodes: vatCodeService,
  });
  return app;
}

describe("GET /vat-codes", () => {
  it("lists every catalog code in catalog order with its accounts and their momsruta", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({ url: "/vat-codes" });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { code: string; accounts: { slot: string; accountNumber: string; warning: string | null }[] }[];
    expect(rows.map((row) => row.code)).toEqual([...VAT_CODES]);

    const euv = res.json().find((row: { code: string }) => row.code === "EUV");
    expect(euv).toMatchObject({
      name: "Varor till annat EU-land",
      label: "Varor till annat EU-land",
      direction: "sales",
      kind: "eu_sale",
      rate: 0,
      requiresBuyerVatNumber: true,
      invoiceText: "Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)",
      active: true,
      ruleCount: 0,
    });
    expect(euv.accounts).toEqual([
      {
        slot: "revenue",
        accountNumber: "3108",
        defaultAccountNumber: "3108",
        expectedBox: "35",
        accountName: "Försäljning varor till annat EU-land",
        accountActive: true,
        actualBox: "35",
        warning: null,
      },
    ]);
    // The BAS chart carries every catalog account with its slot's box.
    expect(rows.flatMap((row) => row.accounts).filter((account) => account.warning !== null)).toEqual([]);
    await app.close();
  });

  it("flags an account the chart lacks or that carries another box", async () => {
    const { user } = await setupEconomy();
    await db.execute(sql`UPDATE accounts SET vat_box = '05' WHERE number = '3108'`);
    await db.execute(sql`DELETE FROM accounts WHERE number = '4549'`);
    const app = buildApp(user.id);
    const rows = (await app.inject({ url: "/vat-codes" })).json() as { code: string; accounts: { slot: string; warning: string | null }[] }[];
    expect(rows.find((row) => row.code === "EUV")!.accounts[0]!.warning).toBe("box_mismatch");
    expect(rows.find((row) => row.code === "IMP25")!.accounts.find((account) => account.slot === "baseCounter")!.warning).toBe("missing");
    await app.close();
  });
});

describe("PATCH /vat-codes/:id", () => {
  it("edits name, invoice text, active and an account, logs vat_code_changed and warns when a rule uses an inactive code", async () => {
    const { user } = await setupEconomy();
    const id = await vatCodeId("EUV");
    await service.createAccount({ number: "3109", name: "Försäljning EU egen", vatBox: "35" });
    const [group] = await db.execute<{ id: string }>(sql`INSERT INTO article_groups (code, name) VALUES ('310', 'Diskbänkar') RETURNING id`);
    await service.createPostingRule({
      articleGroupId: group!.id,
      vatCodeId: id,
      revenueAccountId: (await repo.findAccountByNumber("3109"))!.id,
      costAccountId: null,
    });

    const app = buildApp(user.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/vat-codes/${id}`,
      payload: { name: "EU-varor", invoiceText: "Intra-EU supply", active: false, revenueAccount: "3109" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vatCode).toMatchObject({ code: "EUV", name: "EU-varor", invoiceText: "Intra-EU supply", active: false, ruleCount: 1 });
    expect(body.vatCode.accounts[0]).toMatchObject({ accountNumber: "3109", defaultAccountNumber: "3108", warning: null });
    expect(body.warnings).toEqual([
      "Momskoden EUV är inaktiv men används av 1 konteringsregel",
      "Momskoden EUV väljs automatiskt för varor till företagskunder i andra EU-länder — nya fakturarader för sådana kunder måste då få en momskod för hand",
    ]);

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      entityType: "vat_code",
      entityId: "EUV",
      action: "vat_code_changed",
      detail: {
        before: { name: "Varor till annat EU-land", active: true, revenueAccount: "3108" },
        after: { name: "EU-varor", active: false, revenueAccount: "3109" },
      },
    });

    // "" resets the account to the catalog default; null clears the text.
    const reset = await app.inject({ method: "PATCH", url: `/vat-codes/${id}`, payload: { revenueAccount: "", invoiceText: null } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().vatCode.accounts[0].accountNumber).toBe("3108");
    expect(reset.json().vatCode.invoiceText).toBeNull();
    await app.close();
  });

  it("refuses to deactivate a domestic code (400 vat-code-required) and warns about every other automatically chosen code", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    for (const code of ["MP25", "MP12", "MP6", "MF"] as const) {
      const res = await app.inject({ method: "PATCH", url: `/vat-codes/${await vatCodeId(code)}`, payload: { active: false } });
      expect([res.statusCode, res.json().code, res.json().error]).toEqual([
        400,
        "vat-code-required",
        "Momskoden används när Nav väljer momskod automatiskt och kan inte inaktiveras",
      ]);
    }
    const [mp25] = await db.select().from(vatCodes).where(eq(vatCodes.code, "MP25"));
    expect(mp25!.active).toBe(true);
    // Other edits of a domestic code are fine, active: true too.
    const renamed = await app.inject({ method: "PATCH", url: `/vat-codes/${mp25!.id}`, payload: { name: "Moms 25", active: true } });
    expect(renamed.statusCode).toBe(200);

    const expected: Record<string, string> = {
      EUV: "Momskoden EUV väljs automatiskt för varor till företagskunder i andra EU-länder — nya fakturarader för sådana kunder måste då få en momskod för hand",
      EUT: "Momskoden EUT väljs automatiskt för tjänster till företagskunder i andra EU-länder — nya fakturarader för sådana kunder måste då få en momskod för hand",
      EXV: "Momskoden EXV väljs automatiskt för varor till kunder utanför EU — nya fakturarader för sådana kunder måste då få en momskod för hand",
      EXT: "Momskoden EXT väljs automatiskt för tjänster till företagskunder utanför EU — nya fakturarader för sådana kunder måste då få en momskod för hand",
      OB: "Momskoden OB väljs automatiskt för tjänster till kunder med omvänd betalningsskyldighet för byggtjänster — nya fakturarader för sådana kunder måste då få en momskod för hand",
      IEUV25:
        "Momskoden IEUV25 väljs automatiskt som förval för leverantörer i andra EU-länder — nya leverantörsfakturor för sådana leverantörer måste då få en momskod för hand",
      IUTV: "Momskoden IUTV väljs automatiskt som förval för leverantörer utanför EU — nya leverantörsfakturor för sådana leverantörer måste då få en momskod för hand",
    };
    for (const [code, warning] of Object.entries(expected)) {
      const res = await app.inject({
        method: "PATCH",
        url: `/vat-codes/${await vatCodeId(code as (typeof VAT_CODES)[number])}`,
        payload: { active: false },
      });
      expect([code, res.statusCode, res.json().warnings]).toEqual([code, 200, [warning]]);
    }
    // A code Nav never picks by itself deactivates without a warning.
    const ieut = await app.inject({ method: "PATCH", url: `/vat-codes/${await vatCodeId("IEUT")}`, payload: { active: false } });
    expect(ieut.json().warnings).toEqual([]);
    await app.close();
  });

  it("warns when the chosen account carries another box than the slot expects", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({ method: "PATCH", url: `/vat-codes/${await vatCodeId("EUV")}`, payload: { revenueAccount: "3001" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(["Konto 3001 har ruta 05 men ska ha ruta 35"]);
    await app.close();
  });

  it("refuses an unused slot, a missing or inactive account and two slots on one account (400), an unknown id (404)", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const patch = async (code: (typeof VAT_CODES)[number], payload: unknown) =>
      app.inject({ method: "PATCH", url: `/vat-codes/${await vatCodeId(code)}`, payload: payload as object });

    let res = await patch("EUV", { costAccount: "4010" });
    expect([res.statusCode, res.json().code]).toEqual([400, "vat-code-slot-not-used"]);
    res = await patch("EUV", { revenueAccount: "3999" });
    expect([res.statusCode, res.json().code]).toEqual([400, "vat-code-account-invalid"]);
    await service.updateAccount((await repo.findAccountByNumber("3990"))!.id, { active: false });
    res = await patch("EUV", { revenueAccount: "3990" });
    expect([res.statusCode, res.json().code]).toEqual([400, "vat-code-account-invalid"]);
    res = await patch("IEUV25", { inputVatAccount: "2614" });
    expect([res.statusCode, res.json().code]).toEqual([400, "vat-code-account-conflict"]);
    res = await patch("EUV", { revenueAccount: "31080" });
    expect([res.statusCode, res.json().code]).toEqual([400, "validation-failed"]);
    res = await patch("EUV", { code: "XX" });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: "PATCH", url: "/vat-codes/00000000-0000-0000-0000-000000000000", payload: { name: "X" } });
    expect([res.statusCode, res.json().code]).toEqual([404, "vat-code-not-found"]);

    const [unchanged] = await db.select().from(vatCodes).where(eq(vatCodes.code, "EUV"));
    expect(unchanged!.revenueAccount).toBe("3108");
    await app.close();
  });
});

describe("POST /import-vat", () => {
  it("books the customs decision as an IM verification", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/import-vat",
      payload: {
        date: `${YEAR}-03-10`,
        description: "Tullbeslut 4711",
        rows: [{ vatCodeId: await vatCodeId("IMP25"), taxBase: 8000 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().verification).toMatchObject({ displayNumber: `IM-${YEAR}-1` });
    expect(typeof res.json().verification.id).toBe("string");

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["50"]).toBe(8000);
    expect(report.boxes["60"]).toBe(2000);
    expect(report.boxes["48"]).toBe(2000);
    await app.close();
  });

  it("refuses a code that is not an active import code (400), an empty row list (400) and a locked period (409)", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/import-vat", payload: payload as object });

    let res = await post({ date: `${YEAR}-03-10`, description: "x", rows: [{ vatCodeId: await vatCodeId("MP25"), taxBase: 100 }] });
    expect([res.statusCode, res.json().code]).toEqual([400, "import-vat-code"]);
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "IMP12"));
    res = await post({ date: `${YEAR}-03-10`, description: "x", rows: [{ vatCodeId: await vatCodeId("IMP12"), taxBase: 100 }] });
    expect([res.statusCode, res.json().code]).toEqual([400, "import-vat-code"]);
    res = await post({ date: `${YEAR}-03-10`, description: "x", rows: [] });
    expect(res.statusCode).toBe(400);

    const period = await repo.findPeriodForDate(`${YEAR}-03-10`);
    await service.lockPeriod(period!.id, user.id);
    res = await post({ date: `${YEAR}-03-10`, description: "x", rows: [{ vatCodeId: await vatCodeId("IMP25"), taxBase: 100 }] });
    expect([res.statusCode, res.json().code]).toEqual([409, "accounting-period-locked"]);
    await app.close();
  });
});

describe("GET /vat-report/file", () => {
  it("returns the declaration as ISO-8859-1 XML named after the period's last month", async () => {
    const { user } = await setupEconomy();
    const series = await repo.findSeriesByCode("A");
    const draft = await service.createVerification(
      {
        seriesId: series!.id,
        date: `${YEAR}-03-05`,
        description: "Försäljning",
        rows: [
          { accountId: (await repo.findAccountByNumber("1510"))!.id, debit: 1250.6, credit: 0 },
          { accountId: (await repo.findAccountByNumber("3001"))!.id, debit: 0, credit: 1000.5 },
          { accountId: (await repo.findAccountByNumber("2610"))!.id, debit: 0, credit: 250.1 },
        ],
      },
      user.id
    );
    await service.book(draft.id, user.id);

    const app = buildApp(user.id);
    const res = await app.inject({ url: `/vat-report/file?from=${YEAR}-01-01&to=${MAR.to}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/xml; charset=ISO-8859-1");
    expect(res.headers["content-disposition"]).toContain(`momsdeklaration-${YEAR}03.xml`);
    const text = res.rawPayload.toString("latin1");
    expect(text).toContain("<OrgNr>556000-0175</OrgNr>");
    expect(text).toContain(`<Period>${YEAR}03</Period>`);
    expect(text).toContain("<ForsMomsEjAnnan>1001</ForsMomsEjAnnan>");
    expect(text).toContain("<MomsUtgHog>250</MomsUtgHog>");
    expect(text).toContain("<MomsBetala>250</MomsBetala>");
    await app.close();
  });

  it("409s vat-file-org-number-missing without an organisationsnummer, 400 for an uncovered range", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    orgNumber = null;
    let res = await app.inject({ url: `/vat-report/file?from=${MAR.from}&to=${MAR.to}` });
    expect([res.statusCode, res.json().code]).toEqual([409, "vat-file-org-number-missing"]);
    orgNumber = "5560000175";
    res = await app.inject({ url: `/vat-report/file?from=${YEAR}-03-15&to=${MAR.to}` });
    expect([res.statusCode, res.json().code]).toEqual([400, "vat-period-not-covered"]);
    await app.close();
  });
});

describe("/settings/vat-reporting", () => {
  it("defaults to quarter with no contact, saves partially, clears with null/\"\" and logs the changed keys", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    expect((await app.inject({ url: "/settings/vat-reporting" })).json()).toEqual({
      period: "quarter",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
    });

    let res = await app.inject({
      method: "PATCH",
      url: "/settings/vat-reporting",
      payload: { period: "month", contactName: "Eva Ekonom", contactPhone: "08-123 456", contactEmail: "eva@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ period: "month", contactName: "Eva Ekonom", contactPhone: "08-123 456", contactEmail: "eva@example.com" });
    expect(audited.at(-1)).toMatchObject({ entityType: "system_settings", action: "updated" });

    res = await app.inject({ method: "PATCH", url: "/settings/vat-reporting", payload: { contactPhone: null, contactEmail: "" } });
    expect(res.json()).toEqual({ period: "month", contactName: "Eva Ekonom", contactPhone: null, contactEmail: null });

    for (const payload of [{}, { period: "week" }, { contactEmail: "not-an-email" }, { contactName: "x".repeat(36) }, { other: 1 }]) {
      expect((await app.inject({ method: "PATCH", url: "/settings/vat-reporting", payload })).statusCode).toBe(400);
    }
    await app.close();
  });

  it("refuses a contact name or phone Skatteverket's file cannot carry (400 vat-reporting-contact-invalid, nothing saved)", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const patch = (payload: object) => app.inject({ method: "PATCH", url: "/settings/vat-reporting", payload });

    for (const [payload, field] of [
      [{ contactName: "Łukasz Kowalski" }, "contactName"],
      [{ contactName: "Anna €uro" }, "contactName"],
      [{ contactPhone: "08-123-456" }, "contactPhone"],
      [{ contactPhone: "08/123456" }, "contactPhone"],
      [{ contactPhone: "tel 0812345" }, "contactPhone"],
      [{ contactPhone: "0046-123+45" }, "contactPhone"],
    ] as const) {
      const res = await patch({ period: "month", ...payload });
      expect([res.statusCode, res.json().code, res.json().field]).toEqual([400, "vat-reporting-contact-invalid", field]);
    }
    expect((await patch({ contactPhone: "08 / 123" })).json().error).toMatch(/^Telefonnumret ska vara siffror/);
    // Nothing of a refused PATCH is saved — not even its valid period.
    expect((await app.inject({ url: "/settings/vat-reporting" })).json().period).toBe("quarter");

    // Latin-1 letters and the file's own formats are fine.
    const ok = await patch({ contactName: "Åsa Öberg-Müller", contactPhone: "+46 8 123 456" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ contactName: "Åsa Öberg-Müller", contactPhone: "+46 8 123 456" });
    await app.close();
  });
});

// Catalog defaults sanity on the live table: what migration 0142 seeded is
// what resetVatCodes restores, so the two descriptions cannot drift apart.
describe("vat_codes seed ↔ catalog", () => {
  it("holds exactly the catalog's codes", async () => {
    const rows = await db.select({ code: vatCodes.code }).from(vatCodes);
    expect(rows.map((row) => row.code).sort()).toEqual([...VAT_CODES].sort());
    expect(VAT_CODE_CATALOG.map((entry) => entry.code)).toEqual([...VAT_CODES]);
  });
});
