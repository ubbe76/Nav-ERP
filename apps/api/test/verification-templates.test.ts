import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createRecurringVerificationRepository } from "../src/modules/economy/repository/recurring-verification.repository.js";
import { createVerificationTemplateRepository } from "../src/modules/economy/repository/verification-template.repository.js";
import { createEconomyService, VerificationSeriesNotFoundError } from "../src/modules/economy/service/economy.service.js";
import {
  createVerificationTemplateService,
  VerificationTemplateAccountMissingError,
  VerificationTemplateInUseError,
  VerificationTemplateNameTakenError,
  VerificationTemplateNotFoundError,
} from "../src/modules/economy/service/verification-template.service.js";

// Verifikatmallar against Postgres: CRUD, the unique name, missing accounts,
// the in-use guard and Spara som mall.

const economyRepo = createEconomyRepository(db);
const economy = createEconomyService(economyRepo, { log: async () => {} });
const templateRepo = createVerificationTemplateRepository(db);
const templates = createVerificationTemplateService({ repo: templateRepo, economy: economyRepo, audit: { log: async () => {} } });
const recurringRepo = createRecurringVerificationRepository(db);
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE recurring_verification_runs, recurring_verifications, verification_template_rows, verification_templates, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();

async function setup() {
  const user = await authRepo.create({ email: `tpl-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  await economy.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await economy.createSeries({ code: "A", name: "Manuella verifikat" });
  await economy.createAccount({ number: "1930", name: "Företagskonto" });
  await economy.createAccount({ number: "5010", name: "Lokalhyra" });
  await economy.createAccount({ number: "2640", name: "Ingående moms" });
  return { user, series };
}

describe("verification templates", () => {
  it("creates a template with ordered rows, account names joined, amounts as numbers or null", async () => {
    const { user, series } = await setup();
    const created = await templates.create(
      {
        name: "Hyra",
        seriesId: series.id,
        description: "Hyra för månaden",
        rows: [
          { accountNumber: "5010", debit: 8000, description: "Hyra" },
          { accountNumber: "2640", debit: 2000 },
          { accountNumber: "1930", credit: 10000 },
          { accountNumber: "1930", debit: null, credit: 0 },
        ],
      },
      user.id
    );
    expect(created).toMatchObject({ name: "Hyra", seriesId: series.id, seriesCode: "A", description: "Hyra för månaden", active: true });
    expect(created.rows.map((r) => [r.accountNumber, r.accountName, r.debit, r.credit, r.description, r.sortOrder])).toEqual([
      ["5010", "Lokalhyra", 8000, null, "Hyra", 0],
      ["2640", "Ingående moms", 2000, null, null, 1],
      ["1930", "Företagskonto", null, 10000, null, 2],
      ["1930", "Företagskonto", null, null, null, 3],
    ]);
    const listed = await templates.list(false);
    expect(listed.total).toBe(1);
    expect(listed.rows[0]!.rows).toHaveLength(4);
  });

  it("refuses a second template with the same name (409)", async () => {
    const { user, series } = await setup();
    await templates.create({ name: "Hyra", seriesId: series.id, description: "x", rows: [] }, user.id);
    await expect(templates.create({ name: "Hyra", seriesId: series.id, description: "y", rows: [] }, user.id)).rejects.toThrow(
      VerificationTemplateNameTakenError
    );
  });

  it("refuses rows on accounts the chart lacks, listing them", async () => {
    const { user, series } = await setup();
    await expect(
      templates.create(
        { name: "X", seriesId: series.id, description: "x", rows: [{ accountNumber: "9999", debit: 1 }, { accountNumber: "8888", credit: 1 }] },
        user.id
      )
    ).rejects.toMatchObject({ name: "VerificationTemplateAccountMissingError", accounts: ["9999", "8888"] });
    expect((await templates.list(true)).total).toBe(0);
    await expect(templates.create({ name: "X", seriesId: crypto.randomUUID(), description: "x", rows: [] }, user.id)).rejects.toThrow(
      VerificationSeriesNotFoundError
    );
  });

  it("patches the header, replaces the rows and hides an inactive template from the default list", async () => {
    const { user, series } = await setup();
    const created = await templates.create({ name: "Hyra", seriesId: series.id, description: "x", rows: [{ accountNumber: "1930", debit: 1 }] }, user.id);
    const updated = await templates.update(
      created.id,
      { name: "Hyra Q1", active: false, rows: [{ accountNumber: "5010", debit: 2 }, { accountNumber: "1930", credit: 2 }] },
      user.id
    );
    expect(updated.name).toBe("Hyra Q1");
    expect(updated.active).toBe(false);
    expect(updated.rows.map((r) => r.accountNumber)).toEqual(["5010", "1930"]);
    expect((await templates.list(false)).total).toBe(0);
    expect((await templates.list(true)).total).toBe(1);
    await expect(templates.update(crypto.randomUUID(), { name: "x" }, user.id)).rejects.toThrow(VerificationTemplateNotFoundError);
  });

  it("deletes a template, but not one a recurring post uses", async () => {
    const { user, series } = await setup();
    const free = await templates.create({ name: "Fri", seriesId: series.id, description: "x", rows: [] }, user.id);
    const used = await templates.create({ name: "Använd", seriesId: series.id, description: "x", rows: [] }, user.id);
    await recurringRepo.create(
      { templateId: used.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "draft", scheduleAmounts: null, allocation: null },
      user.id
    );
    await templates.delete(free.id, user.id);
    await expect(templates.findById(free.id)).rejects.toThrow(VerificationTemplateNotFoundError);
    await expect(templates.delete(used.id, user.id)).rejects.toThrow(VerificationTemplateInUseError);
    expect(await templates.findById(used.id)).toBeTruthy();
  });

  it("Spara som mall takes a verification's series, description and rows", async () => {
    const { user, series } = await setup();
    const bank = await economyRepo.findAccountByNumber("1930");
    const rent = await economyRepo.findAccountByNumber("5010");
    const verification = await economy.createVerification(
      {
        seriesId: series.id,
        date: `${YEAR}-02-01`,
        description: "Hyra februari",
        rows: [
          { accountId: rent!.id, debit: 8000, credit: 0, description: "Hyra" },
          { accountId: bank!.id, debit: 0, credit: 8000 },
        ],
        book: true,
      },
      user.id
    );
    const template = await templates.saveFromVerification(verification.id, "Månadshyra", user.id);
    expect(template).toMatchObject({ name: "Månadshyra", seriesId: series.id, description: "Hyra februari" });
    expect(template.rows.map((r) => [r.accountNumber, r.debit, r.credit, r.description])).toEqual([
      ["5010", 8000, null, "Hyra"],
      ["1930", null, 8000, null],
    ]);
    await expect(templates.saveFromVerification(verification.id, "Månadshyra", user.id)).rejects.toThrow(VerificationTemplateNameTakenError);
  });
});
