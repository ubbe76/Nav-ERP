import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, units } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";

const articleService = testArticleService;
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

const TABLES = sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, stock_transactions, stock_locations, warehouses, bom_components, article_units, articles, units, users CASCADE`;

let kgId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  const [kg] = await db.insert(units).values({ code: "kg", name: "Kilogram" }).returning();
  kgId = kg!.id;
});

afterAll(async () => {
  await db.execute(TABLES);
});

describe("manufacturing — material unit snapshot at release", () => {
  it("copies the BOM row's display unit to the MO material row, planned quantity stays in base units", async () => {
    const user = await authRepo.create({
      email: `mfg-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      name: "Producer",
      role: "admin",
    });

    const parent = await articleService.createArticle({
      articleNumber: "MO-P",
      name: "MO-P",
      type: "manufactured",
      isPhantom: false,
      active: true,
    });
    // Component stocked in st, 5 kg apiece; the BOM row is entered as
    // 2 kg per manufactured unit (= 0.4 st).
    const component = await articleService.createArticle({
      articleNumber: "MO-C",
      name: "MO-C",
      type: "purchased",
      isPhantom: false,
      active: true,
    });
    await articleService.addArticleUnit(component.id, { unitId: kgId, quantityPerBase: 5 });
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, unitId: kgId });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 10 }, user.id);

    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials).toHaveLength(1);
    // 0.4 st per unit × 10 units = 4 st planned, displayed as 20 kg.
    expect(materials[0]?.quantityPlanned).toBe("4.0000");
    expect(materials[0]?.unitId).toBe(kgId);
    expect(Number(materials[0]?.unitFactor)).toBe(5);
    expect(materials[0]?.unitCode).toBe("kg");
  });
});
