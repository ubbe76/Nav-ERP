import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companyInfo, db } from "@navet/db";
import { createBankSettingsRepository } from "../src/modules/banking/repository/bank-settings.repository.js";
import { bankSettingsRoutes } from "../src/modules/banking/routes/bank-settings.routes.js";
import { BankSettingsIncompleteError, InvalidBankSettingError } from "../src/modules/banking/service/banking.errors.js";
import { bankSettingsProblems, createBankSettingsService } from "../src/modules/banking/service/bank-settings.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { failure, waitForLockWaiter } from "./helpers/year-end.js";
import { buildRouteApp, configureSwedbank, resetBanking, resetBankSettings, setupBanking, snapshotCompany } from "./helpers/banking.js";

const service = createBankSettingsService({ repo: createBankSettingsRepository(db), audit: createAuditRepository(db) });

let restoreCompany: () => Promise<void>;
let userId: string;
beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  userId = (await setupBanking()).user.id;
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
});

const COMPANY = { name: "Exempel Verkstad AB", orgNumber: "556677-8899", postalCode: "802 22", city: "Gävle", iban: null, bic: null, bankgiro: "551-2348", plusgiro: null };

describe("bankSettingsProblems", () => {
  it("lists what is missing, in Swedish, profile by profile", () => {
    const none = { profile: null, initiatingPartyId: null, debtorAgreementId: null, debitAccountKind: null };
    expect(bankSettingsProblems(none, COMPANY)).toEqual(["Bank är inte vald"]);
    expect(bankSettingsProblems({ ...none, profile: "swedbank" }, { ...COMPANY, city: null })).toEqual([
      "Avtals-ID för betalfil (t.ex. 123456789123B001) saknas",
      "Debiteringskonto är inte valt",
      "Ort saknas i Företagsinformation",
    ]);
    expect(
      bankSettingsProblems({ ...none, profile: "handelsbanken", debitAccountKind: "iban" }, COMPANY)
    ).toEqual(["IBAN saknas i Företagsinformation"]);
    // Handelsbanken falls back to the org number for the initiating party.
    expect(
      bankSettingsProblems({ ...none, profile: "handelsbanken", debitAccountKind: "iban" }, { ...COMPANY, iban: "SE45 5000 0000 0583 9825 7466" })
    ).toEqual([]);
  });
});

// Final review: a city nothing of which survives the bank's character set is
// written as no TwnNm at all, so readiness must call it missing — the same
// townName(...) === "" test checkPain001 applies.
describe("bankSettingsProblems — town that sanitizes to nothing", () => {
  it("reports Ort saknas for a blank or emoji-only city, as the file check would", () => {
    const swedbank = { profile: "swedbank" as const, initiatingPartyId: "123456789123B001", debtorAgreementId: null, debitAccountKind: "bankgiro" as const };
    expect(bankSettingsProblems(swedbank, COMPANY)).toEqual([]);
    expect(bankSettingsProblems(swedbank, { ...COMPANY, city: "   " })).toEqual(["Ort saknas i Företagsinformation"]);
    expect(bankSettingsProblems(swedbank, { ...COMPANY, city: "🏭" })).toEqual(["Ort saknas i Företagsinformation"]);
  });
});

// Task 7 carry: the same 35-character InitgPty limit checkPain001 applies
// (Max35Text) — SEB and Handelsbanken take free text, so the pattern alone
// does not catch it.
describe("bankSettingsProblems — initiating party length", () => {
  it("refuses an id longer than 35 characters for the free-text banks, as the file check does", () => {
    const base = { debtorAgreementId: null };
    const seb = { ...base, profile: "seb" as const, debitAccountKind: "bankgiro" as const };
    const hb = { ...base, profile: "handelsbanken" as const, debitAccountKind: "iban" as const };
    const company = { ...COMPANY, iban: "SE45 5000 0000 0583 9825 7466" };
    expect(bankSettingsProblems({ ...seb, initiatingPartyId: "A".repeat(35) }, company)).toEqual([]);
    expect(bankSettingsProblems({ ...seb, initiatingPartyId: "A".repeat(36) }, company)).toEqual(["Kund-ID enligt avtalet med SEB (vanligen 14 eller 10 tecken) har fel format"]);
    expect(bankSettingsProblems({ ...hb, initiatingPartyId: "1".repeat(36) }, company)).toEqual([
      "Organisationsnummer eller Handelsbankens kundnummer har fel format",
    ]);
  });
});

describe("bankinställningarna", () => {
  it("reads defaults, saves, and normalizes the company's bankgiro", async () => {
    expect((await service.read()).missing).toEqual(["Bank är inte vald"]);
    await configureSwedbank();
    const view = await service.read();
    expect(view).toMatchObject({ profile: "swedbank", initiatingPartyId: "123456789123B001", debitAccountKind: "bankgiro", missing: [] });
    const ready = await service.assertReady();
    expect(ready.debitAccount).toEqual({ kind: "bankgiro", value: "5512348" });
    expect(ready.profile.id).toBe("swedbank");
  });

  it("refuses a debit account the bank does not take and a malformed agreement id", async () => {
    await configureSwedbank();
    expect(await failure(service.update({ debitAccountKind: "iban" }, userId))).toBeInstanceOf(InvalidBankSettingError);
    expect(await failure(service.update({ initiatingPartyId: "12345" }, userId))).toBeInstanceOf(InvalidBankSettingError);
  });

  // Read, merge and write happen in one transaction under the settings
  // lock: a PATCH queues behind a holder and writes nothing until it has it.
  it("writes the settings in one transaction under the settings lock", async () => {
    await configureSwedbank();
    let update: Promise<unknown> | undefined;
    await db.transaction(async (holder) => {
      await holder.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bank_settings'))`);
      update = service.update({ profile: "handelsbanken", initiatingPartyId: "556677-8899" }, userId);
      await waitForLockWaiter();
      expect((await service.read()).profile).toBe("swedbank");
    });
    await update!;
    const view = await service.read();
    expect(view.profile).toBe("handelsbanken");
    expect(view.initiatingPartyId).toBe("5566778899");
  });

  it("normalizes hyphens/spaces in the agreement id and in the company's own giro numbers", async () => {
    await configureSwedbank();
    // Spaces/hyphens are stripped before validating and storing.
    const view = await service.update({ initiatingPartyId: " 1234 5678-9123 b001 " }, userId);
    expect(view.initiatingPartyId).toBe("123456789123B001");
    // Handelsbanken's customer id is typed like an org number: 556677-8899.
    const hb = await service.update({ profile: "handelsbanken", initiatingPartyId: "556677-8899" }, userId);
    expect(hb.initiatingPartyId).toBe("5566778899");
    // A hyphenated company bankgiro reaches the file digits-only.
    await db.update(companyInfo).set({ bankgiro: "551-2348", iban: "SE45 5000 0000 0583 9825 7466" });
    await service.update({ profile: "swedbank", initiatingPartyId: "123456789123B001", debitAccountKind: "bankgiro" }, userId);
    expect((await service.assertReady()).debitAccount).toEqual({ kind: "bankgiro", value: "5512348" });
    // Handelsbanken without an own id falls back to the org number, digits only.
    await service.update({ profile: "handelsbanken", initiatingPartyId: null }, userId);
    const ready = await service.assertReady();
    expect(ready.debitAccount).toEqual({ kind: "iban", value: "SE4550000000058398257466" });
    expect(ready.initiatingPartyId).toBe("5566778899");
  });

  it("never calls a company ready whose debit account the pain.001 check would reject", () => {
    const base = { initiatingPartyId: null, debtorAgreementId: null };
    const sw = { ...base, profile: "swedbank" as const, initiatingPartyId: "123456789123B001", debitAccountKind: "bankgiro" as const };
    const hb = { ...base, profile: "handelsbanken" as const, debitAccountKind: "iban" as const };
    const nd = { ...base, profile: "nordea" as const, initiatingPartyId: "123", debitAccountKind: "plusgiro" as const };
    // bankgiro: wrong length and bad Luhn
    expect(bankSettingsProblems(sw, { ...COMPANY, bankgiro: "55-12" })).toEqual(["Bankgiro är ogiltigt i Företagsinformation"]);
    expect(bankSettingsProblems(sw, { ...COMPANY, bankgiro: "551-2349" })).toEqual(["Bankgiro är ogiltigt i Företagsinformation"]);
    // plusgiro: bad Luhn
    expect(bankSettingsProblems(nd, { ...COMPANY, plusgiro: "1234567" })).toEqual(["Plusgiro är ogiltigt i Företagsinformation"]);
    expect(bankSettingsProblems(nd, { ...COMPANY, plusgiro: "1-8" })).toEqual([]);
    // IBAN: malformed, and a valid foreign one
    expect(bankSettingsProblems(hb, { ...COMPANY, iban: "SE45 5000 0000 0583 9825 7467" })).toEqual(["IBAN är ogiltigt i Företagsinformation"]);
    expect(bankSettingsProblems(hb, { ...COMPANY, iban: "DE89 3704 0044 0532 0130 00" })).toEqual(["Bara svenskt IBAN (SE…) stöds som debiteringskonto i Företagsinformation"]);
  });

  it("falls back to the org number digits only", async () => {
    await db.update(companyInfo).set({ orgNumber: "SE 556677-8899 01", iban: "SE45 5000 0000 0583 9825 7466" });
    await service.update({ profile: "handelsbanken", initiatingPartyId: null }, userId);
    expect((await service.assertReady()).initiatingPartyId).toBe("556677889901");
  });

  it("moves the debit account to the new bank's first kind when the bank changes", async () => {
    await configureSwedbank();
    const view = await service.update({ profile: "handelsbanken" }, userId);
    expect(view.debitAccountKind).toBe("iban");
  });

  it("assertReady names every missing piece", async () => {
    const error = await failure(service.assertReady());
    expect(error).toBeInstanceOf(BankSettingsIncompleteError);
    expect((error as BankSettingsIncompleteError).missing).toEqual(["Bank är inte vald"]);
  });

  it("PATCH is admin-only; GET is open to inkop/forsaljning/ekonomi", async () => {
    const asInkop = buildRouteApp(bankSettingsRoutes, { service }, { id: userId, role: "user", permissions: ["inkop"] });
    expect((await asInkop.inject({ method: "GET", url: "/bank-settings" })).statusCode).toBe(200);
    expect((await asInkop.inject({ method: "PATCH", url: "/bank-settings", payload: { profile: "seb" } })).statusCode).toBe(403);
    const asLager = buildRouteApp(bankSettingsRoutes, { service }, { id: userId, role: "user", permissions: ["lager"] });
    expect((await asLager.inject({ method: "GET", url: "/bank-settings" })).statusCode).toBe(403);
    const asAdmin = buildRouteApp(bankSettingsRoutes, { service }, { id: userId });
    const res = await asAdmin.inject({ method: "PATCH", url: "/bank-settings", payload: { profile: "seb", debitAccountKind: "bankgiro" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ profile: "seb", debitAccountKind: "bankgiro" });
    expect((await asAdmin.inject({ method: "PATCH", url: "/bank-settings", payload: { profile: "danskebank" } })).statusCode).toBe(400);
  });
});

// Valuta steg 2: what payments abroad are drawn from — the profile's
// foreign.debitAccountKinds — is reported apart from `missing` (a company
// that never pays abroad is ready without it).
describe("debiteringskonto för utlandsbetalningar", () => {
  it("Swedbank pays abroad from the IBAN: foreignProblem until the company has one; assertReady resolves it", async () => {
    await configureSwedbank();
    const view = await service.read();
    expect(view.missing).toEqual([]);
    expect(view.foreignProblem).toBe("Swedbank kräver IBAN i Företagsinformation för utlandsbetalningar");
    expect(view.profiles.find((p) => p.id === "swedbank")).toMatchObject({ debitAccountKinds: ["bankgiro"], foreignDebitAccountKinds: ["iban"] });
    expect((await service.assertReady()).foreignDebitAccount).toBeNull();
    await db.update(companyInfo).set({ iban: "se45 5000 0000 0583 9825 7466" });
    expect((await service.read()).foreignProblem).toBeNull();
    const ready = await service.assertReady();
    expect(ready.debitAccount).toEqual({ kind: "bankgiro", value: "5512348" });
    expect(ready.foreignDebitAccount).toEqual({ kind: "iban", value: "SE4550000000058398257466" });
  });

  it("a bank that draws abroad from the settings' own IBAN uses it for both", async () => {
    await db.update(companyInfo).set({ ...COMPANY, iban: "SE4550000000058398257466" });
    await service.update({ profile: "handelsbanken", debitAccountKind: "iban" }, userId);
    const ready = await service.assertReady();
    expect(ready.foreignDebitAccount).toEqual(ready.debitAccount);
  });
});
