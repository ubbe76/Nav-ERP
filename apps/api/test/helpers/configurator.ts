// apps/api/test/helpers/configurator.ts
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { insertArticle } from "../../src/modules/article/repository/article.repository.js";
import { insertBomRows } from "../../src/modules/article/repository/bom-write.js";
import {
  createConfiguratorService, type PriceReader, type VariantStockReader, type VariantWriters,
} from "../../src/modules/configurator/service/configurator.service.js";
import { createCostingRepository } from "../../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../../src/modules/costing/service/costing.service.js";
import { insertRoutingOperations } from "../../src/modules/manufacturing/repository/routing-write.js";
import { testArticleService } from "./services.js";

// Mutable System → Kalkyler settings for the configurator tests' costing service (all zero: no markups).
export const testCostingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier" | "actual",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
export const testCostingService = createCostingService(createCostingRepository(db), { getSettings: async () => testCostingSettings });

// The owning modules' real Tx writers, as app.ts wires them. Tests that need
// a failing writer spread these and override one.
export const variantWriters: VariantWriters = { insertArticle, insertBomRows, insertRoutingOperations };
// No stock in the configurator tests: every variant shows 0 on hand.
export const emptyStockReader: VariantStockReader = { balancesForArticles: async () => [] };
// Spread into createConfiguratorService({...}) by the suites that build the service themselves.
export const variantTestDeps = { writers: variantWriters, stock: emptyStockReader };

// A configurator service with the real article/structure readers and writers,
// the shared costing service and, unless overridden, no customer price chain.
export function makeVariantService(overrides: { writers?: VariantWriters; stock?: VariantStockReader; prices?: PriceReader } = {}) {
  return createConfiguratorService({
    db,
    prices: overrides.prices ?? (async () => ({ articleNumber: "X", price: null })),
    customerExists: async () => true,
    articles: {
      exists: async (id) => (await testArticleService.getArticle(id)) != null,
      isDescendant: (articleId, ancestorId) => testArticleService.isDescendant(articleId, ancestorId),
      find: (id) => testArticleService.getArticle(id),
    },
    costing: testCostingService,
    writers: overrides.writers ?? variantWriters,
    stock: overrides.stock ?? emptyStockReader,
  });
}

export const CONFIGURATOR_TRUNCATE = sql`TRUNCATE configurator_variants, configurator_rules, configurator_values, configurator_groups, configurator_templates, article_units, bom_components, stock_transactions, articles CASCADE`;

export async function resetConfigurator() {
  await db.execute(CONFIGURATOR_TRUNCATE);
}

export async function makeArticle(overrides: { type?: "manufactured" | "purchased" | "service"; isPhantom?: boolean; salesPrice?: number } = {}) {
  return testArticleService.createArticle({
    articleNumber: `KONF-${crypto.randomUUID().slice(0, 8)}`,
    name: "Papperskorg 50 l",
    type: overrides.type ?? "manufactured",
    isPhantom: overrides.isPhantom ?? false,
    salesPrice: overrides.salesPrice,
  } as never);
}
