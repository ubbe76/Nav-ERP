import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import {
  createRegisterService,
  DuplicateRegisterEntryError,
  RegisterEntryNotFoundError,
} from "../src/modules/register/service/register.service.js";

const service = createRegisterService(createRegisterRepository(db));

beforeEach(async () => {
  await db.execute(sql`TRUNCATE delivery_terms, payment_terms, carriers, units CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE delivery_terms, payment_terms, carriers, units CASCADE`);
});

describe("register service — base-data registers", () => {
  it("creates and lists entries sorted by code, per register", async () => {
    await service.deliveryTerms.create({ code: "EXW", name: "Ex Works" });
    await service.deliveryTerms.create({ code: "DAP", name: "Delivered at Place" });
    await service.paymentTerms.create({ code: "30", name: "30 dagar netto" });

    const terms = await service.deliveryTerms.list();
    expect(terms.map((t) => t.code)).toEqual(["DAP", "EXW"]);
    // Registers are independent tables — payment terms don't leak in.
    expect(await service.carriers.list()).toEqual([]);
    expect((await service.paymentTerms.list())).toHaveLength(1);
  });

  it("renames an entry and keeps its own code without conflict", async () => {
    const dhl = await service.carriers.create({ code: "DHL", name: "DHL Freight" });
    const renamed = await service.carriers.update(dhl.id, { code: "DHL", name: "DHL Freight Sweden" });
    expect(renamed.name).toBe("DHL Freight Sweden");
  });

  it("rejects duplicate code and duplicate name", async () => {
    await service.deliveryTerms.create({ code: "DAP", name: "Delivered at Place" });
    await expect(service.deliveryTerms.create({ code: "DAP", name: "Annat" })).rejects.toThrow(
      DuplicateRegisterEntryError
    );
    await expect(service.deliveryTerms.create({ code: "DDP", name: "Delivered at Place" })).rejects.toThrow(
      DuplicateRegisterEntryError
    );
    // The same code may exist in another register.
    await expect(service.paymentTerms.create({ code: "DAP", name: "Delivered at Place" })).resolves.toBeTruthy();
  });

  it("rejects a code change that collides with another entry", async () => {
    await service.carriers.create({ code: "DHL", name: "DHL Freight" });
    const other = await service.carriers.create({ code: "PN", name: "PostNord" });
    await expect(service.carriers.update(other.id, { code: "DHL", name: "PostNord" })).rejects.toThrow(
      DuplicateRegisterEntryError
    );
  });

  it("throws RegisterEntryNotFoundError for an unknown id", async () => {
    await expect(
      service.carriers.update("00000000-0000-0000-0000-000000000000", { code: "X", name: "X" })
    ).rejects.toThrow(RegisterEntryNotFoundError);
  });

  // The description column exists on every register (shared generic shape),
  // so one roundtrip through the generic path covers them all.
  it("stores, defaults and updates the optional description", async () => {
    const withDescription = await service.deliveryTerms.create({
      code: "EXW",
      name: "Ex Works",
      description: "Köparen hämtar godset hos säljaren.",
    });
    expect(withDescription.description).toBe("Köparen hämtar godset hos säljaren.");

    const without = await service.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    expect(without.description).toBeNull();

    const updated = await service.deliveryTerms.update(withDescription.id, {
      code: "EXW",
      name: "Ex Works",
      description: "Egen formulering.",
    });
    expect(updated.description).toBe("Egen formulering.");
  });
});

describe("register service — units register", () => {
  it("creates, lists and rejects duplicate units like the other registers", async () => {
    await service.units.create({ code: "st", name: "Styck" });
    await service.units.create({ code: "kg", name: "Kilogram" });
    expect((await service.units.list()).map((u) => u.code)).toEqual(["kg", "st"]);
    await expect(service.units.create({ code: "st", name: "Annat" })).rejects.toThrow(
      DuplicateRegisterEntryError
    );
  });

  it("seeds the standard units and is idempotent", async () => {
    const first = await service.seedStandardUnits();
    expect(first.created).toBeGreaterThanOrEqual(9);
    expect(first.skipped).toBe(0);
    const codes = (await service.units.list()).map((u) => u.code);
    for (const code of ["st", "kg", "g", "m", "m2", "m3", "l", "tim", "förp"]) {
      expect(codes).toContain(code);
    }

    const second = await service.seedStandardUnits();
    expect(second.created).toBe(0);
  });
});

describe("register service — Combiterms seeding", () => {
  it("seeds all eleven Combiterms into an empty register", async () => {
    const result = await service.seedCombiterms();
    expect(result).toEqual({ created: 11, skipped: 0 });

    const terms = await service.deliveryTerms.list();
    expect(terms).toHaveLength(11);
    expect(terms.map((t) => t.code)).toContain("EXW");
    expect(terms.find((t) => t.code === "DDP")?.name).toBe("Levererat förtullat");
    expect(terms.find((t) => t.code === "DDP")?.description).toBe(
      "Säljaren står för hela transporten inklusive importklarering och tull; köparen tar bara emot på angiven plats."
    );
    // Every seeded term carries an explanation, not just the spot-checked one.
    expect(terms.every((t) => t.description && t.description.length > 0)).toBe(true);
  });

  it("is idempotent and preserves customized entries", async () => {
    await service.seedCombiterms();
    const dap = (await service.deliveryTerms.list()).find((t) => t.code === "DAP")!;
    await service.deliveryTerms.update(dap.id, {
      code: "DAP",
      name: "Levererat Kiruna",
      description: "Vår egen tolkning av DAP.",
    });

    const second = await service.seedCombiterms();
    expect(second).toEqual({ created: 0, skipped: 11 });
    const dapAfter = (await service.deliveryTerms.list()).find((t) => t.code === "DAP");
    expect(dapAfter?.name).toBe("Levererat Kiruna");
    // The customized explanation survives a re-seed, same as the name.
    expect(dapAfter?.description).toBe("Vår egen tolkning av DAP.");
    expect(await service.deliveryTerms.list()).toHaveLength(11);
  });
});
