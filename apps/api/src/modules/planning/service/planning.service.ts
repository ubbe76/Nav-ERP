import type {
  CapacityQuery,
  ConfiguratorSelection,
  CreatePlanningOrdersInput,
  ListRequirementsQuery,
  Paged,
} from "@navet/shared";
import { roundUpToMultiple } from "@navet/shared";
import type { PlanningRepository } from "../repository/planning.repository.js";
import {
  DEMAND_SALES_STATUSES,
  computeLowLevelCodes,
  computeRequirements,
  type ConfiguredRowNeed,
  type RequirementRow,
  type RequirementsInput,
} from "./requirements-calc.js";
import { capacityHorizon, computeCapacity, type CapacityResult } from "./capacity-calc.js";
import { buildArticleOverview, type ArticleOverview } from "./article-overview.js";
import {
  findFirmDemand,
  holidayLookbackStart,
  suggestDueDate,
  type DueDateSuggestion,
  type FirmDemand,
} from "./due-date-suggestion.js";
import { uncoveredConfiguredQuantity } from "./configured-coverage.js";
import { resolveSupplierPrice } from "../../purchase/service/supplier-price.js";
import { configurationLines } from "../../configurator/service/configuration-lines.js";
import { selectionFromEntries } from "../../configurator/service/variant-identity.js";
import type { ConfiguredStructureReader } from "../../configurator/service/configurator.service.js";

// Own copy rather than importing the article module's class — planning
// stays a leaf that only knows its repository (same as costing.service.ts).
export class ArticleNotFoundError extends Error {
  constructor(id: string) {
    super(`Article ${id} not found`);
    this.name = "ArticleNotFoundError";
  }
}

// Narrow creator interfaces declared consumer-side (the StockBalanceReader
// pattern): satisfied structurally by purchaseService/manufacturingService.
// Order creation goes through the existing services' own creation paths so
// number series, validation and transactions stay in one place.
export interface PurchaseOrderCreator {
  createPurchaseOrder(
    input: { supplierId: string; exchangeRate: number; expectedDeliveryDate?: string },
    createdBy: string
  ): Promise<{ id: string; orderNumber: string }>;
  addRow(
    purchaseOrderId: string,
    input: {
      articleId: string;
      quantity: number;
      unitPrice: number;
      // Lego rows: the MO operation the row buys + the one-off ställpris.
      moOperationId?: string;
      setupPrice?: number;
      // Önskat leveransdatum when it differs from the order's.
      expectedDeliveryDate?: string;
    }
  ): Promise<unknown>;
  cancel(purchaseOrderId: string): Promise<unknown>;
}

export interface ManufacturingOrderCreator {
  createManufacturingOrder(
    input: { articleId: string; quantity: number; note?: string; dueDate?: string },
    createdBy: string | null
  ): Promise<{ id: string; orderNumber: string }>;
  // Konfigurator 4c: a configured proposal's TO is made FROM its KO row — the
  // row owns the choices (and the manufacturing service derives the
  // structure, re-checking the row's key under the row lock).
  createFromSalesOrderRow(
    rowId: string,
    input: { quantity?: number; dueDate?: string | null },
    createdBy: string | null
  ): Promise<{ id: string; orderNumber: string }>;
}

// Anchored in Europe/Stockholm — a UTC date would be yesterday's for the
// first hours after midnight (summer time). sv-SE formats as YYYY-MM-DD.
const stockholmToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

export interface CreatedOrdersResult {
  // supplierId travels with the order so the caller can look the supplier's
  // email up — the behovsberäkning offers to mail the draft straight away.
  purchaseOrders: { id: string; orderNumber: string; supplierId: string; supplierName: string; rowCount: number }[];
  manufacturingOrders: { id: string; orderNumber: string; articleNumber: string }[];
  errors: { articleId: string; articleNumber: string; message: string }[];
}

// Domain errors carry user-readable messages and pass through; anything that
// smells like an internal error (Drizzle's "Failed query: <full SQL>", or
// oversized technical dumps) is replaced — SQL must never reach the client.
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message && !err.message.includes("Failed query") && err.message.length <= 200) {
    return err.message;
  }
  return "Kunde inte skapa order";
}

// How long one behovsberäkning result is reused. The netting covers the
// whole dataset (the cascade needs every article) while the list pages,
// searches and filters the RESULT — so without the cache every page change
// re-ran everything. A minute of staleness is the accepted price; Uppdatera
// (refresh) and Skapa ordrar recompute at once.
export const REQUIREMENTS_CACHE_MS = 60_000;

export function createPlanningService(
  repo: PlanningRepository,
  deps: {
    purchase: PurchaseOrderCreator;
    manufacturing: ManufacturingOrderCreator;
    // Konfigurator 4c: derives a configured KO row's material for the
    // cascade (bound late in app.ts). Optional so the unit tests' fakes need
    // not wire it; a configured row without a reader gets an error row.
    configuredStructure?: ConfiguredStructureReader;
    // 0 = no caching (the integration tests change data between calls).
    requirementsCacheMs?: number;
    now?: () => number;
  }
) {
  const cacheMs = deps.requirementsCacheMs ?? REQUIREMENTS_CACHE_MS;
  const now = deps.now ?? Date.now;
  // Shared by every user — the result doesn't depend on who asks. The
  // PROMISE is cached so concurrent requests share one computation; a failed
  // one is dropped so the next request retries.
  let cache: { at: number; rows: Promise<RequirementRow[]> } | null = null;

  // Konfigurator 4c: the configured rows and their cascade are derived here,
  // once per distinct (template, configuration) per run, so the pure calc
  // never calls the configurator. An invalid configuration keeps its row
  // (with the engine's message) but cascades nothing.
  async function loadInputWithConfigured(): Promise<RequirementsInput> {
    const [input, configured] = await Promise.all([repo.loadRequirementsInput(), repo.loadConfiguredSalesRows()]);
    const roundingOf = new Map(input.articles.map((a) => [a.articleId, a.rounding]));
    const needs: ConfiguredRowNeed[] = configured.map((r) => ({
      salesOrderRowId: r.rowId,
      salesOrderId: r.salesOrderId,
      orderNumber: r.orderNumber,
      customerName: r.customerName,
      templateArticleId: r.articleId,
      expectedDeliveryDate: r.expectedDeliveryDate,
      summary: configurationLines(r.configuration.selection).join(" · "),
      // Avrundning: the TO Skapa ordrar makes is rounded up to the template's
      // step (createManufacturingOrder) — the proposal, and so the summed
      // derivation the cascade is built from, use the same rounded quantity.
      uncoveredQuantity: roundUpToMultiple(
        uncoveredConfiguredQuantity({
          quantityOrdered: r.quantityOrdered,
          quantityDelivered: r.quantityDelivered,
          linkedOrders: r.linkedOrders,
        }),
        roundingOf.get(r.articleId) ?? null
      ),
      error: null,
    }));
    // Group the uncovered rows per (template, key): the derivation is linear
    // in quantity, so one call at the summed quantity equals the sum of the
    // per-row calls.
    const groups = new Map<
      string,
      { templateId: string; selection: ConfiguratorSelection; quantity: number; needs: ConfiguredRowNeed[] }
    >();
    configured.forEach((r, i) => {
      const need = needs[i]!;
      if (need.uncoveredQuantity <= 0) return;
      const key = `${r.articleId}:${r.configuration.key}`;
      const g = groups.get(key) ?? {
        templateId: r.articleId,
        selection: selectionFromEntries(r.configuration.selection),
        quantity: 0,
        needs: [],
      };
      g.quantity += need.uncoveredQuantity;
      g.needs.push(need);
      groups.set(key, g);
    });
    const cascade = new Map<string, number>();
    for (const g of groups.values()) {
      try {
        if (!deps.configuredStructure) throw new Error("ConfiguredStructureReader not wired");
        // Avvikelse 5: material only — the förkalkyl is not needed here.
        const s = await deps.configuredStructure(g.templateId, g.selection, g.quantity, { withCost: false });
        if (!s.valid) {
          for (const n of g.needs) n.error = s.errors[0] ?? "Konfigurationen är inte giltig";
          continue;
        }
        for (const m of s.materials) {
          cascade.set(m.componentArticleId, (cascade.get(m.componentArticleId) ?? 0) + m.totalQuantity);
        }
      } catch (err) {
        for (const n of g.needs) n.error = errorMessage(err);
      }
    }
    return { ...input, configuredRows: needs, configuredCascade: cascade };
  }

  // The firm demand a new TO is dated from. Konfigurator 4c: a CONFIGURED
  // (beställningsvara) KO row is its own firm demand — the template's stock
  // and other rows' TOs are other configurations' units, so the pooled
  // coverage in findFirmDemand must not cover it (row B would otherwise be
  // dated from row A's TO, or left undated by a free unit in stock). No date
  // on the row ⇒ nothing to plan by. Ordinary rows and calls without a row
  // keep the pooled rule.
  async function firmDemandFor(articleId: string, today: string, salesOrderRowId: string | undefined) {
    if (salesOrderRowId) {
      const row = await repo.salesOrderRowForDueDate(salesOrderRowId);
      if (row?.configured && row.articleId === articleId) {
        if (!DEMAND_SALES_STATUSES.has(row.orderStatus) || !row.expectedDeliveryDate) return null;
        const demand: FirmDemand = {
          date: row.expectedDeliveryDate,
          source: "sales_order_row",
          documentType: "sales_order",
          documentId: row.salesOrderId,
          documentNumber: row.orderNumber,
        };
        return demand;
      }
    }
    const input = await repo.loadArticleOverviewInput(articleId);
    if (!input) throw new ArticleNotFoundError(articleId);
    return findFirmDemand(buildArticleOverview(input), { today, salesOrderRowId });
  }

  function computedRequirements(refresh: boolean): { at: number; rows: Promise<RequirementRow[]> } {
    const t = now();
    if (refresh || !cache || t - cache.at >= cacheMs) {
      const rows = loadInputWithConfigured().then(computeRequirements);
      const entry = { at: t, rows };
      cache = entry;
      rows.catch(() => {
        if (cache === entry) cache = null;
      });
    }
    return cache!;
  }

  return {
    // Derived at read time, cached briefly (see REQUIREMENTS_CACHE_MS);
    // filters/paging apply to the cached result and never mutate it.
    async listRequirements(
      query: ListRequirementsQuery
    ): Promise<Paged<RequirementRow> & { computedAt: string }> {
      const entry = computedRequirements(query.refresh);
      let rows = await entry.rows;

      if (!query.showAll) rows = rows.filter((r) => r.proposalQuantity > 0);
      // Configured rows are typed "manufactured" by the calc, so the type
      // filter treats them as such without a special case.
      if (query.type) rows = rows.filter((r) => r.type === query.type);
      if (query.groupId) rows = rows.filter((r) => r.groupId === query.groupId);
      if (query.search) {
        const term = query.search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.articleNumber.toLowerCase().includes(term) ||
            r.articleName.toLowerCase().includes(term) ||
            // Konfigurator 4c: a configured row is also found by its KO
            // number and its choices ("Lås B").
            (r.salesOrderNumber?.toLowerCase().includes(term) ?? false) ||
            (r.configurationSummary?.toLowerCase().includes(term) ?? false)
        );
      }

      return {
        rows: rows.slice(query.offset, query.offset + query.limit),
        total: rows.length,
        computedAt: new Date(entry.at).toISOString(),
      };
    },

    // Artikelöversikt (planeringsbild) — one article's open rows in date
    // order with a running balance. Derived at read time like the MRP.
    async getArticleOverview(articleId: string): Promise<ArticleOverview> {
      const input = await repo.loadArticleOverviewInput(articleId);
      if (!input) throw new ArticleNotFoundError(articleId);
      return buildArticleOverview(input);
    },

    // Färdigdatumsförslag for a new TO on the article — one working day
    // before its first firm demand not already covered by stock or open
    // IO/TO (or before the linked KO row's delivery date, if that row is
    // uncovered), today at the earliest. null = no uncovered dated demand.
    async suggestManufacturingDueDate(
      articleId: string,
      opts: { salesOrderRowId?: string } = {}
    ): Promise<DueDateSuggestion | null> {
      const today = stockholmToday();
      const demand = await firmDemandFor(articleId, today, opts.salesOrderRowId);
      if (!demand) return null;
      const offDays = new Set(await repo.fullDayHolidaysBetween(holidayLookbackStart(demand.date), demand.date));
      return suggestDueDate(demand, { today, offDays });
    },

    // Beläggning (E2) — fully derived at read time, like listRequirements.
    async getCapacity(query: CapacityQuery): Promise<CapacityResult> {
      // Anchor "today" in Europe/Stockholm — a UTC date would flip the week
      // column on Sunday evenings (winter time). sv-SE formats as YYYY-MM-DD.
      const today = stockholmToday();
      // Same horizon authority as the calc itself — the holiday query bounds
      // can never drift from the week columns.
      const { firstMonday, horizonSunday } = capacityHorizon(today, query.weeks);
      const input = await repo.loadCapacityInput(firstMonday, horizonSunday);
      const result = computeCapacity(input, { today, weeks: query.weeks });
      if (query.productionGroupId) {
        result.groups = result.groups.filter((g) => g.productionGroupId === query.productionGroupId);
      }
      return result;
    },

    // One draft IO per primary supplier (Monitor-style grouping) plus one
    // planned TO per manufactured article. No batch transaction on purpose:
    // each order is created through its own service's transaction, partial
    // success keeps the created orders and reports the failures per article.
    async createOrdersFromProposals(
      input: CreatePlanningOrdersInput,
      createdBy: string
    ): Promise<CreatedOrdersResult> {
      const result: CreatedOrdersResult = { purchaseOrders: [], manufacturingOrders: [], errors: [] };

      const articleNumbers = new Map(
        (await repo.articleInfoForIds(input.proposals.map((p) => p.articleId))).map((a) => [
          a.articleId,
          a.articleNumber,
        ])
      );
      const numberFor = (articleId: string) => articleNumbers.get(articleId) ?? "";
      const pushError = (articleId: string, message: string) =>
        result.errors.push({ articleId, articleNumber: numberFor(articleId), message });

      const purchaseProposals = input.proposals.filter((p) => p.kind === "purchase");
      const manufactureProposals = input.proposals.filter((p) => p.kind === "manufacture");
      const subcontractProposals = input.proposals.filter((p) => p.kind === "subcontract");
      const configuredProposals = input.proposals.filter((p) => p.kind === "configured");

      // Konfigurator 4c: configured rows first — they are parents (their TO's
      // material is what the component proposals below were netted against).
      // The manufacturing service derives the structure from the row's own
      // choices and refuses a row whose configuration is no longer valid.
      for (const proposal of configuredProposals) {
        try {
          const suggestion = await this.suggestManufacturingDueDate(proposal.articleId, {
            salesOrderRowId: proposal.salesOrderRowId,
          });
          const mo = await deps.manufacturing.createFromSalesOrderRow(
            proposal.salesOrderRowId!,
            { quantity: proposal.quantity, ...(suggestion ? { dueDate: suggestion.dueDate } : {}) },
            createdBy
          );
          result.manufacturingOrders.push({
            id: mo.id,
            orderNumber: mo.orderNumber,
            articleNumber: numberFor(proposal.articleId),
          });
        } catch (err) {
          pushError(proposal.articleId, errorMessage(err));
        }
      }

      // TOs FIRST, parents before components (low-level code order, like the
      // MRP's own netting): a new planned TO is material demand in its
      // components' overview, so both a component TO's färdigdatum and a
      // purchased component's önskade leveransdatum (below) land before it.
      if (manufactureProposals.length > 1) {
        const levels = computeLowLevelCodes(await repo.loadBomEdges());
        manufactureProposals.sort((a, b) => (levels.get(a.articleId) ?? 0) - (levels.get(b.articleId) ?? 0));
      }

      for (const proposal of manufactureProposals) {
        try {
          const suggestion = await this.suggestManufacturingDueDate(proposal.articleId);
          const mo = await deps.manufacturing.createManufacturingOrder(
            {
              articleId: proposal.articleId,
              quantity: proposal.quantity,
              note: "Skapad från behovsberäkning",
              ...(suggestion ? { dueDate: suggestion.dueDate } : {}),
            },
            createdBy
          );
          result.manufacturingOrders.push({
            id: mo.id,
            orderNumber: mo.orderNumber,
            articleNumber: numberFor(proposal.articleId),
          });
        } catch (err) {
          pushError(proposal.articleId, errorMessage(err));
        }
      }

      const supplierByArticle = new Map(
        (await repo.primarySuppliersForArticles(purchaseProposals.map((p) => p.articleId))).map((s) => [
          s.articleId,
          s,
        ])
      );

      const bySupplier = new Map<
        string,
        { supplierName: string; rows: { articleId: string; quantity: number; unitPrice: number }[] }
      >();
      for (const proposal of purchaseProposals) {
        const supplier = supplierByArticle.get(proposal.articleId);
        if (!supplier) {
          pushError(proposal.articleId, "Artikeln saknar huvudleverantör");
          continue;
        }
        const group = bySupplier.get(supplier.supplierId) ?? { supplierName: supplier.supplierName, rows: [] };
        group.rows.push({
          articleId: proposal.articleId,
          quantity: proposal.quantity,
          // Stafflat: the break for the proposal quantity, else grundpriset.
          unitPrice: resolveSupplierPrice(supplier, proposal.quantity).price ?? 0,
        });
        bySupplier.set(supplier.supplierId, group);
      }

      for (const [supplierId, group] of bySupplier) {
        // Önskat leveransdatum, same rule as a TO's färdigdatum: the working
        // day before each article's first uncovered firm demand. The order
        // gets the earliest; a row whose own date is later keeps it on the
        // row (null = follows the order). A failed suggestion is just no
        // date — it must not stop the order (a real problem fails addRow).
        const dates = new Map<string, string | null>();
        for (const row of group.rows) {
          const suggestion = await this.suggestManufacturingDueDate(row.articleId).catch(() => null);
          dates.set(row.articleId, suggestion?.dueDate ?? null);
        }
        const orderDate = [...dates.values()].filter((d): d is string => d !== null).sort()[0];

        let order: { id: string; orderNumber: string };
        try {
          order = await deps.purchase.createPurchaseOrder(
            { supplierId, exchangeRate: 1, ...(orderDate ? { expectedDeliveryDate: orderDate } : {}) },
            createdBy
          );
        } catch (err) {
          for (const row of group.rows) pushError(row.articleId, errorMessage(err));
          continue;
        }
        let rowCount = 0;
        for (const row of group.rows) {
          const rowDate = dates.get(row.articleId) ?? null;
          try {
            await deps.purchase.addRow(order.id, {
              ...row,
              ...(rowDate && rowDate !== orderDate ? { expectedDeliveryDate: rowDate } : {}),
            });
            rowCount += 1;
          } catch (err) {
            pushError(row.articleId, errorMessage(err));
          }
        }
        if (rowCount === 0) {
          // Every row failed — don't leave a rowless draft IO in the register
          // and don't report it as created. Best-effort cancel; the row
          // failures above are already reported per article.
          try {
            await deps.purchase.cancel(order.id);
          } catch {
            // The empty draft survives as junk, but the user already gets one
            // error per row; a cancel failure has nothing actionable to add.
          }
          continue;
        }
        result.purchaseOrders.push({
          id: order.id,
          orderNumber: order.orderNumber,
          supplierId,
          supplierName: group.supplierName,
          rowCount,
        });
      }

      // --- Subcontract (lego) proposals: grouped per supplier into draft
      // IOs like the purchase proposals, but keyed per MO OPERATION.
      // Supplier and prices are reloaded server-side from the operation
      // snapshot — the client only carries ids and quantities. A PO holds at
      // most one row per article (unique constraint), so a second lego row
      // on the same article for the same supplier opens a new draft IO.
      if (subcontractProposals.length > 0) {
        const operationById = new Map(
          (await repo.legoOperationsForIds(subcontractProposals.map((p) => p.moOperationId!))).map((op) => [
            op.moOperationId,
            op,
          ])
        );

        type LegoRow = {
          articleId: string;
          quantity: number;
          unitPrice: number;
          setupPrice?: number;
          moOperationId: string;
        };
        const bucketsBySupplier = new Map<string, { supplierName: string; buckets: LegoRow[][] }>();

        for (const proposal of subcontractProposals) {
          const operation = operationById.get(proposal.moOperationId!);
          if (!operation) {
            pushError(proposal.articleId, "Legooperationen finns inte längre eller är redan klar");
            continue;
          }
          if (!operation.supplierId) {
            pushError(
              proposal.articleId,
              `Legooperationen saknar leverantör (${operation.orderNumber} · Op ${operation.sequenceNo})`
            );
            continue;
          }
          const group = bucketsBySupplier.get(operation.supplierId) ?? {
            supplierName: operation.supplierName ?? operation.supplierId,
            buckets: [],
          };
          const row: LegoRow = {
            articleId: operation.articleId,
            quantity: proposal.quantity,
            unitPrice: operation.unitPrice ?? 0,
            setupPrice: operation.setupPrice ?? undefined,
            moOperationId: operation.moOperationId,
          };
          const bucket = group.buckets.find((rows) => !rows.some((r) => r.articleId === row.articleId));
          if (bucket) bucket.push(row);
          else group.buckets.push([row]);
          bucketsBySupplier.set(operation.supplierId, group);
        }

        for (const [supplierId, group] of bucketsBySupplier) {
          for (const bucket of group.buckets) {
            let order: { id: string; orderNumber: string };
            try {
              order = await deps.purchase.createPurchaseOrder({ supplierId, exchangeRate: 1 }, createdBy);
            } catch (err) {
              for (const row of bucket) pushError(row.articleId, errorMessage(err));
              continue;
            }
            let rowCount = 0;
            for (const row of bucket) {
              try {
                await deps.purchase.addRow(order.id, row);
                rowCount += 1;
              } catch (err) {
                pushError(row.articleId, errorMessage(err));
              }
            }
            if (rowCount === 0) {
              // Same best-effort cleanup as the purchase branch above.
              try {
                await deps.purchase.cancel(order.id);
              } catch {
                // The empty draft survives as junk; each row already
                // reported its own error.
              }
              continue;
            }
            result.purchaseOrders.push({
              id: order.id,
              orderNumber: order.orderNumber,
              supplierId,
              supplierName: group.supplierName,
              rowCount,
            });
          }
        }
      }

      // The new orders cover the proposals — drop the cached result AFTER
      // they exist, so a read racing the creation can't re-cache the old one.
      cache = null;
      return result;
    },
  };
}

export type PlanningService = ReturnType<typeof createPlanningService>;
