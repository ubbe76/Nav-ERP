import { describe, expect, it } from "vitest";
import {
  bucketMovements,
  findRoleBoxMismatches,
  findUnassignedAccounts,
} from "../src/modules/economy/service/vat-report.service.js";
import type { VatAccountMovement } from "../src/modules/economy/service/vat-account-movements.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";

function movement(accountNumber: string, vatBox: VatAccountMovement["vatBox"], debit: number, credit: number): VatAccountMovement {
  return { accountId: `id-${accountNumber}`, accountNumber, accountName: `Konto ${accountNumber}`, vatBox, debit, credit };
}

describe("bucketMovements — ruta per konto", () => {
  it("routes each account's credit-net to its box and box 48 debit-positive", () => {
    const boxes = bucketMovements([
      movement("3001", "05", 0, 1000),
      movement("3010", "05", 0, 200),
      movement("3004", "42", 0, 300),
      movement("3108", "35", 0, 400),
      movement("3105", "36", 0, 500),
      movement("2610", "10", 0, 300),
      movement("2620", "11", 0, 24),
      movement("2630", "12", 0, 6),
      movement("2640", "48", 80, 0),
    ]);
    expect(boxes).toEqual({
      sales05: 1200,
      salesExempt42: 300,
      salesEu35: 400,
      salesExport36: 500,
      vatOut25_10: 300,
      vatOut12_11: 24,
      vatOut6_12: 6,
      vatIn48: 80,
      vatToPay49: 250,
    });
  });

  it("ignores accounts with no box or 'none', whatever their number", () => {
    const boxes = bucketMovements([movement("3540", "none", 0, 60), movement("3999", null, 0, 75), movement("1510", null, 135, 0)]);
    expect(boxes.sales05).toBe(0);
    expect(boxes.vatToPay49).toBe(0);
  });

  it("a second account tagged 10 counts in ruta 10 too (box follows the account, not the setting)", () => {
    const boxes = bucketMovements([movement("2610", "10", 0, 100), movement("2611", "10", 0, 25)]);
    expect(boxes.vatOut25_10).toBe(125);
  });
});

describe("findUnassignedAccounts", () => {
  it("lists class-3 and 26xx accounts without a box that moved, credit-net, and nothing else", () => {
    const warnings = findUnassignedAccounts([
      movement("3010", null, 0, 200),
      movement("2611", null, 0, 50),
      movement("3540", "none", 0, 60),
      movement("1510", null, 250, 0),
      movement("3020", null, 100, 100),
    ]);
    expect(warnings).toEqual([
      { accountNumber: "3010", accountName: "Konto 3010", net: 200 },
      { accountNumber: "2611", accountName: "Konto 2611", net: 50 },
    ]);
  });
});

// The BAS-seeded accounts behind every posting role that feeds a box.
const BAS_ROLE_ACCOUNTS = [
  { number: "2610", vatBox: "10" },
  { number: "2620", vatBox: "11" },
  { number: "2630", vatBox: "12" },
  { number: "2640", vatBox: "48" },
  { number: "3001", vatBox: "05" },
  { number: "3002", vatBox: "05" },
  { number: "3003", vatBox: "05" },
  { number: "3004", vatBox: "42" },
];

describe("findRoleBoxMismatches", () => {
  it("flags a configured VAT account whose momsruta is not its role's box", () => {
    const settings = { ...DEFAULT_POSTING_SETTINGS, postingVatOut25: "2611" };
    const mismatches = findRoleBoxMismatches(settings, [
      ...BAS_ROLE_ACCOUNTS.filter((account) => account.number !== "2640"),
      { number: "2611", vatBox: null },
      { number: "2640", vatBox: "05" },
    ]);
    expect(mismatches).toEqual([
      { role: "vatOut25", accountNumber: "2611", expectedBox: "10", actualBox: null },
      { role: "vatIn", accountNumber: "2640", expectedBox: "48", actualBox: "05" },
    ]);
  });

  it("flags a revenue role whose account carries another box (momsfri moved onto a 05 account)", () => {
    const settings = { ...DEFAULT_POSTING_SETTINGS, postingRevenue0: "3011", postingRevenue25: "3540" };
    const mismatches = findRoleBoxMismatches(settings, [
      ...BAS_ROLE_ACCOUNTS,
      { number: "3011", vatBox: "05" },
      { number: "3540", vatBox: "none" },
    ]);
    expect(mismatches).toEqual([
      { role: "revenue25", accountNumber: "3540", expectedBox: "05", actualBox: "none" },
      { role: "revenue0", accountNumber: "3011", expectedBox: "42", actualBox: "05" },
    ]);
  });

  it("is empty for the BAS defaults", () => {
    expect(
      findRoleBoxMismatches(DEFAULT_POSTING_SETTINGS, BAS_ROLE_ACCOUNTS)
    ).toEqual([]);
  });
});
