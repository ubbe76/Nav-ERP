import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { customerContacts, customerDeliveryAddresses, customers, db } from "@navet/db";
import { importBatchPreviewSchema } from "@navet/shared";
import { createImportRepository, runImportDryRun } from "../src/modules/import/repository/import.repository.js";
import { createImportService, type ImportService } from "../src/modules/import/service/import.service.js";
import { importRoutes } from "../src/modules/import/routes/import.routes.js";

// POST /imports/batch-preview (the multi-file wizard's "Förhandsgranska
// alla"): every file is planned AND executed in order inside one
// rolled-back transaction, so a later file is previewed against what the
// earlier ones leave behind — and nothing is kept.

const TRUNCATE = sql`TRUNCATE customer_contacts, customer_delivery_addresses, customers CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const service = createImportService(createImportRepository(db), {
  dryRun: (fn) => runImportDryRun(db, fn),
});

// Monitor-like files: Lista creates the customers, Postadress renames them,
// Referenser and Leveransadress hang on them.
const LISTA = {
  entity: "customers" as const,
  mapping: { Kund: "customerNumber", Namn: "name" },
  rows: [
    ["5001", "Kortnamn Ett"],
    ["5002", "Kortnamn Två"],
  ],
};
const POSTADRESS = {
  entity: "customers" as const,
  mapping: {
    Kund: "customerNumber",
    "Postadress – Namn": "name",
    "Postadress – Adressrad 1": "address",
    "Postadress – Postnummer": "postalCode",
    "Postadress – Stad": "city",
  },
  rows: [
    ["5001", "Ett Juridiskt AB", "Industrigatan 1", "41101", "GÖTEBORG"],
    ["5002", "Två Juridiskt AB", "Verkstadsvägen 2", "41102", "GÖTEBORG"],
  ],
};
const REFERENSER = {
  entity: "customerContacts" as const,
  mapping: { Kund: "customerNumber", "Referens – Namn": "name", "E-post": "email" },
  rows: [
    ["5001", "Anna Exempel", "anna@example.com"],
    ["5002", "Bo Exempel", "bo@example.com"],
  ],
};
const LEVERANSADRESS = {
  entity: "customerDeliveryAddresses" as const,
  mapping: {
    Kund: "customerNumber",
    "Leveransadress – Namn": "label",
    "Leveransadress – Adressrad 1": "address",
    "Leveransadress – Postnummer": "postalCode",
    "Leveransadress – Stad": "city",
  },
  rows: [
    // Same as the customer's own (Postadress) address — skipped, which the
    // preview can only know because Postadress ran before it.
    ["5001", "Ett Juridiskt AB", "Industrigatan 1", "41101", "GÖTEBORG"],
    ["5002", "Lagret", "Lagervägen 9", "41109", "GÖTEBORG"],
  ],
};

async function countRows() {
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(customers);
  const [k] = await db.select({ n: sql<number>`count(*)::int` }).from(customerContacts);
  const [d] = await db.select({ n: sql<number>`count(*)::int` }).from(customerDeliveryAddresses);
  return { customers: c!.n, contacts: k!.n, addresses: d!.n };
}

describe("ImportService.previewBatch", () => {
  it("previews each file against the earlier files' result and keeps nothing", async () => {
    const { files } = await service.previewBatch([LISTA, POSTADRESS, REFERENSER, LEVERANSADRESS]);

    expect(files.map((f) => f.status)).toEqual(["previewed", "previewed", "previewed", "previewed"]);
    const [lista, postadress, referenser, leveransadress] = files as Extract<
      (typeof files)[number],
      { status: "previewed" }
    >[];
    expect(lista!.summary).toMatchObject({ create: 2, update: 0, error: 0 });
    // The customers Lista creates already exist for the later files.
    expect(postadress!.summary).toMatchObject({ create: 0, update: 2, error: 0 });
    expect(referenser!.summary).toMatchObject({ create: 2, error: 0 });
    expect(leveransadress!.summary).toMatchObject({ create: 1, skip: 1, error: 0 });

    expect(await countRows()).toEqual({ customers: 0, contacts: 0, addresses: 0 });
  });

  it("shows the follow-on errors a single-file preview would give without the batch", async () => {
    const alone = await service.preview("customerContacts", REFERENSER);
    expect(alone.summary.error).toBe(2);
    expect(alone.rows[0]!.errors).toEqual(["Kunden 5001 finns inte — importera kunderna först"]);
  });

  it("stops at a file with row errors: it is reported with its rows, the rest are blocked", async () => {
    const badLista = { ...LISTA, rows: [["5001", "Kortnamn Ett"], ["", "Utan nummer"]] };
    const { files } = await service.previewBatch([badLista, REFERENSER, LEVERANSADRESS]);

    expect(files.map((f) => f.status)).toEqual(["failed", "blocked", "blocked"]);
    const failed = files[0] as Extract<(typeof files)[number], { status: "failed" }>;
    expect(failed.error).toBe("Filen har fel på 1 rad — rätta filen eller hoppa över den");
    expect(failed.summary).toMatchObject({ create: 1, error: 1 });
    expect(failed.rows![1]!.errors).toEqual(["Kundnummer saknas"]);

    expect(await countRows()).toEqual({ customers: 0, contacts: 0, addresses: 0 });
  });

  it("reports a mapping error on its own file and blocks the rest", async () => {
    const unmappedKey = { ...REFERENSER, mapping: { Kund: null, "Referens – Namn": "name", "E-post": "email" } };
    const { files } = await service.previewBatch([LISTA, unmappedKey, LEVERANSADRESS]);

    expect(files.map((f) => f.status)).toEqual(["previewed", "failed", "blocked"]);
    expect(files[1]).toEqual({ status: "failed", error: "En kolumn måste mappas mot customerNumber" });
    expect(await countRows()).toEqual({ customers: 0, contacts: 0, addresses: 0 });
  });

  it("matches what the per-file commits then do", async () => {
    const { files } = await service.previewBatch([LISTA, POSTADRESS, REFERENSER, LEVERANSADRESS]);
    const previewed = files as Extract<(typeof files)[number], { status: "previewed" }>[];

    for (const [i, file] of [LISTA, POSTADRESS, REFERENSER, LEVERANSADRESS].entries()) {
      const { entity, ...input } = file;
      const result = await service.commit(entity, input);
      expect({ created: result.created, updated: result.updated, skipped: result.skipped }).toEqual({
        created: previewed[i]!.summary.create,
        updated: previewed[i]!.summary.update,
        skipped: previewed[i]!.summary.skip,
      });
    }
    expect(await countRows()).toEqual({ customers: 2, contacts: 2, addresses: 1 });
    const names = (await db.select({ name: customers.name }).from(customers)).map((r) => r.name).sort();
    expect(names).toEqual(["Ett Juridiskt AB", "Två Juridiskt AB"]);
  });

  it("refuses to run without the dry-run hook", async () => {
    const bare = createImportService(createImportRepository(db));
    await expect(bare.previewBatch([LISTA])).rejects.toThrow("previewBatch needs the dryRun option");
  });
});

describe("POST /imports/batch-preview", () => {
  function appWith(role: "admin" | "user", svc: Partial<ImportService>) {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      req.user = { id: crypto.randomUUID(), role } as never;
    });
    app.register(importRoutes, { service: svc as ImportService });
    return app;
  }

  it("hands the files to the service in order and answers its result", async () => {
    let received: unknown = null;
    const app = appWith("admin", {
      async previewBatch(files) {
        received = files.map((f) => f.entity);
        return { files: files.map(() => ({ status: "blocked" as const })) };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/imports/batch-preview",
      payload: { files: [LISTA, REFERENSER] },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toEqual(["customers", "customerContacts"]);
    expect(res.json()).toEqual({ files: [{ status: "blocked" }, { status: "blocked" }] });
    await app.close();
  });

  it("403s for a non-admin", async () => {
    const app = appWith("user", {});
    const res = await app.inject({ method: "POST", url: "/imports/batch-preview", payload: { files: [LISTA] } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("caps the number of files", () => {
    const tooMany = Array.from({ length: 31 }, () => LISTA);
    expect(importBatchPreviewSchema.safeParse({ files: tooMany }).success).toBe(false);
    expect(importBatchPreviewSchema.safeParse({ files: [] }).success).toBe(false);
  });
});
