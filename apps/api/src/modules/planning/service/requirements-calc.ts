// MRP light — pure net-requirements calculation (behovsberäkning).
// No database imports: the repository loads flat row-level data once and this
// module owns ALL the business rules — which statuses count as demand/supply,
// netting, reorder-point triggering and the multi-level proposal cascade —
// fully unit-testable without a database (same pure-function pattern as
// bucketMovements and computeOpenAmounts).

// Local literal unions rather than imports keep this leaf dependency-free;
// they mirror the pgEnums in packages/db exactly. The one import is the pure
// rounding helper — deliberately the SAME function the order services apply
// to row quantities, so a proposal and the order it becomes agree.
import { roundUpToMultiple } from "@navet/shared";
import type { PartnerDeliveryFields } from "../../system/service/delivery-days.js";

// "lost" (Förlorad) is closed like cancelled — never demand.
export type SalesOrderStatus =
  | "quote"
  | "confirmed"
  | "in_production"
  | "delivered"
  | "invoiced"
  | "cancelled"
  | "lost";
export type PurchaseOrderStatus =
  | "draft"
  | "confirmed"
  | "partially_received"
  | "received"
  | "closed"
  | "cancelled";
export type ManufacturingOrderStatus =
  | "planned"
  | "released"
  | "in_progress"
  | "done"
  | "closed"
  | "cancelled";

export interface RequirementsArticle {
  articleId: string;
  articleNumber: string;
  name: string;
  type: "manufactured" | "purchased" | "service";
  isPhantom: boolean;
  active: boolean;
  unitCode: string | null;
  groupId: string | null;
  reorderPoint: number | null;
  // Säkerhetslager — optional so fixtures without it plan as before.
  safetyStock?: number | null;
  orderQuantity: number | null;
  // Avrundning — applied to the proposal after the order-quantity multiple.
  rounding: number | null;
  // Konfigurator: the article's configurator template mode, if any. A
  // to_order template (beställningsvara) never gets a proposal of its own —
  // its configured KO rows do (ConfiguredRowNeed).
  configuratorMode: "variants" | "to_order" | null;
}

export interface SalesDemandRow {
  articleId: string;
  orderStatus: SalesOrderStatus;
  quantityOrdered: number;
  quantityDelivered: number;
}

export interface PurchaseSupplyRow {
  articleId: string;
  orderStatus: PurchaseOrderStatus;
  quantityOrdered: number;
  quantityReceived: number;
}

export interface ManufacturingOrderRow {
  articleId: string;
  status: ManufacturingOrderStatus;
  quantity: number;
  // Konfigurator 4c: a beställningsvara's TO carries its own material rows
  // from creation, so a planned configured TO is never exploded through the
  // template's BOM (that would double its component demand).
  configured: boolean;
}

export interface MoMaterialRow {
  componentArticleId: string;
  orderStatus: ManufacturingOrderStatus;
  quantityPlanned: number;
  quantityConsumed: number;
}

export interface BomEdge {
  parentArticleId: string;
  componentArticleId: string;
  quantity: number;
}

export interface PrimarySupplierInfo {
  articleId: string;
  supplierId: string;
  supplierName: string;
  // Grundpriset (quantity 1). The staffel is only loaded for order creation.
  price: number | null;
  currency: string;
  leadTimeDays: number | null;
}

// Order creation (createOrdersFromProposals) resolves the à-pris for the
// proposal quantity from the staffel — see purchase/service/supplier-price.ts.
export interface PrimarySupplierWithBreaks extends PrimarySupplierInfo {
  priceBreaks: { fromQuantity: number; price: number }[];
  // Fasta leveransdagar: the supplier's own fields (absent = follows the
  // system defaults) — Skapa ordrar's IO dates.
  supplierDelivery?: PartnerDeliveryFields;
}

// Lego (subcontract) operation on a released/in_progress MO — an OPERATION
// need, not an article need: it is never netted against stock, and what is
// already bought is the sum of quantity_ordered on non-cancelled IO rows
// with mo_operation_id = this operation (summed by the repository).
export interface LegoOperationRow {
  moOperationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  articleType: "manufactured" | "purchased";
  unitCode: string | null;
  groupId: string | null;
  sequenceNo: number;
  operationDescription: string | null;
  workCenterName: string;
  orderQuantity: number;
  orderedQuantity: number;
  supplierId: string | null;
  supplierName: string | null;
  setupPrice: number | null;
  unitPrice: number | null;
  // Open förfrågningar (draft/sent/answered) raised against this operation —
  // shown as "Förfrågan FO-1024 (Skickad)" under the row. Purely
  // informational: never nets against orderQuantity/orderedQuantity, so an
  // RFQ can never shrink the proposal (it is not a commitment yet).
  openInquiries: { id: string; inquiryNumber: string; status: "draft" | "sent" | "answered" }[];
}

// Konfigurator 4c: one configured (beställningsvara) sales order row on an
// open order and how much of it still needs a TO (uncoveredConfiguredQuantity
// in configured-coverage.ts). The planning service builds these — and the
// configuredCascade below — so this calc never calls the configurator.
// `error` is the engine's message when the stored configuration is no longer
// valid: the row is still shown, but nothing is cascaded for it.
export interface ConfiguredRowNeed {
  salesOrderRowId: string;
  salesOrderId: string;
  orderNumber: string;
  customerName: string;
  templateArticleId: string;
  expectedDeliveryDate: string | null;
  summary: string;
  uncoveredQuantity: number;
  error: string | null;
}

export interface RequirementsInput {
  articles: RequirementsArticle[];
  salesRows: SalesDemandRow[];
  purchaseRows: PurchaseSupplyRow[];
  manufacturingOrders: ManufacturingOrderRow[];
  moMaterialRows: MoMaterialRow[];
  stock: { articleId: string; quantity: number }[]; // on-hand per article (can be negative)
  bomEdges: BomEdge[];
  primarySuppliers: PrimarySupplierInfo[];
  legoOperationRows: LegoOperationRow[];
  configuredRows: ConfiguredRowNeed[];
  // Component article id → summed derived material of every uncovered
  // configured row (derived once per distinct configuration by the service).
  configuredCascade: Map<string, number>;
}

export interface RequirementRow {
  articleId: string;
  articleNumber: string;
  articleName: string;
  type: "manufactured" | "purchased";
  unitCode: string | null;
  groupId: string | null;
  active: boolean;
  onHand: number;
  demandSales: number;
  demandMo: number;
  demandDerived: number;
  supplyPo: number;
  // Draft IOs in their own bucket: a draft is this system's counterpart of a
  // released orderförslag — excluding it would re-propose already-ordered
  // material on every run (and planned TOs, the same commitment level,
  // already count). Shown separately in the UI.
  supplyPoDraft: number;
  supplyMo: number;
  projected: number;
  reorderPoint: number | null;
  safetyStock: number | null;
  orderQuantity: number | null;
  rounding: number | null;
  proposalQuantity: number;
  // "configured" = a configured KO row (beställningsvara) needing its own TO;
  // keyed per SALES ORDER ROW, never netted against stock.
  proposalKind: "purchase" | "manufacture" | "subcontract" | "configured" | null;
  primarySupplier: Omit<PrimarySupplierInfo, "articleId"> | null;
  // Subcontract rows only (proposalKind "subcontract"): which MO operation
  // the proposal buys. These rows are keyed per OPERATION — the same article
  // can appear on several lego rows — and are never netted against stock.
  moOperationId?: string;
  moOrderNumber?: string;
  moOperationLabel?: string;
  openInquiries?: { id: string; inquiryNumber: string; status: "draft" | "sent" | "answered" }[];
  // Konfigurator 4c. On the template's own article row: it is a to_order
  // template and therefore never proposed (the UI says why). On a
  // "configured" row: the KO row the proposal makes a TO for.
  configuredTemplate?: boolean;
  salesOrderRowId?: string;
  salesOrderId?: string;
  salesOrderNumber?: string;
  customerName?: string;
  configurationSummary?: string;
  expectedDeliveryDate?: string | null;
  configurationError?: string | null;
}

// Statuses that still commit/deliver quantity. Quote and draft are deliberate
// exclusions — they are not commitments yet. A planned MO supplies its full
// quantity (complete() books the whole receipt at once; partial receipt does
// not exist) but has no material rows yet, so its component demand comes from
// an in-memory BOM explosion instead (see below).
export const DEMAND_SALES_STATUSES: ReadonlySet<SalesOrderStatus> = new Set(["confirmed", "in_production"]);
export const SUPPLY_PO_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set([
  "confirmed",
  "partially_received",
]);
export const SUPPLY_MO_STATUSES: ReadonlySet<ManufacturingOrderStatus> = new Set([
  "planned",
  "released",
  "in_progress",
]);
export const MATERIAL_MO_STATUSES: ReadonlySet<ManufacturingOrderStatus> = new Set([
  // planned: only a beställningsvara's TO has material rows before release
  // (written at creation, konfigurator 4c) — an ordinary planned TO has none,
  // so this changes nothing for it.
  "planned",
  "released",
  "in_progress",
]);

// Low-level code = the longest path from any BOM root down to the article
// (0 for articles that are never components). Processing articles in this
// order guarantees every parent's proposal is known before its components
// are netted, so derived demand always arrives before it is consumed.
export function computeLowLevelCodes(bomEdges: BomEdge[]): Map<string, number> {
  const parentsOf = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const edge of bomEdges) {
    seen.add(edge.parentArticleId);
    seen.add(edge.componentArticleId);
    const list = parentsOf.get(edge.componentArticleId);
    if (list) list.push(edge.parentArticleId);
    else parentsOf.set(edge.componentArticleId, [edge.parentArticleId]);
  }

  const codes = new Map<string, number>();
  function codeFor(articleId: string, path: Set<string>): number {
    const known = codes.get(articleId);
    if (known !== undefined) return known;
    if (path.has(articleId)) {
      // Guarded at BOM edit time by isDescendant — mirror explodeBom and
      // throw rather than recurse forever if that invariant is ever broken.
      throw new Error(`Cyclic BOM detected at article ${articleId} — this should be impossible`);
    }
    path.add(articleId);
    let code = 0;
    for (const parentId of parentsOf.get(articleId) ?? []) {
      code = Math.max(code, codeFor(parentId, path) + 1);
    }
    path.delete(articleId);
    codes.set(articleId, code);
    return code;
  }
  for (const articleId of seen) codeFor(articleId, new Set());
  return codes;
}

export function buildBomIndex(bomEdges: BomEdge[]): Map<string, BomEdge[]> {
  const childrenOf = new Map<string, BomEdge[]>();
  for (const edge of bomEdges) {
    const list = childrenOf.get(edge.parentArticleId);
    if (list) list.push(edge);
    else childrenOf.set(edge.parentArticleId, [edge]);
  }
  return childrenOf;
}

// One BOM level with phantoms dissolved — the in-memory mirror of what
// explodeBom does per recursion step: a phantom is never emitted, its own
// components are pulled up (multiplying quantities) as if they sat directly
// on the parent. Non-phantom components are emitted and NOT descended into.
// The public wrapper builds the index itself (convenient for tests);
// computeRequirements builds it once per run and calls explodeFromIndex —
// the index is invariant across a run and rebuilding it per exploding
// article would be O(P × E).
export function explodeOneLevel(
  bomEdges: BomEdge[],
  phantomIds: Set<string>,
  articleId: string,
  quantity: number
): Map<string, number> {
  return explodeFromIndex(buildBomIndex(bomEdges), phantomIds, articleId, quantity);
}

export function explodeFromIndex(
  childrenOf: Map<string, BomEdge[]>,
  phantomIds: Set<string>,
  articleId: string,
  quantity: number
): Map<string, number> {
  const result = new Map<string, number>();
  function walk(parentId: string, multiplier: number, path: Set<string>) {
    if (path.has(parentId)) {
      throw new Error(`Cyclic BOM detected at article ${parentId} — this should be impossible`);
    }
    const nextPath = new Set(path).add(parentId);
    for (const edge of childrenOf.get(parentId) ?? []) {
      const componentQuantity = multiplier * edge.quantity;
      if (phantomIds.has(edge.componentArticleId)) {
        walk(edge.componentArticleId, componentQuantity, nextPath);
      } else {
        result.set(
          edge.componentArticleId,
          (result.get(edge.componentArticleId) ?? 0) + componentQuantity
        );
      }
    }
  }
  walk(articleId, quantity, new Set());
  return result;
}

function addTo(map: Map<string, number>, articleId: string, quantity: number) {
  map.set(articleId, (map.get(articleId) ?? 0) + quantity);
}

export function computeRequirements(input: RequirementsInput): RequirementRow[] {
  const phantomIds = new Set(input.articles.filter((a) => a.isPhantom).map((a) => a.articleId));
  const bomIndex = buildBomIndex(input.bomEdges);

  const demandSales = new Map<string, number>();
  for (const row of input.salesRows) {
    if (!DEMAND_SALES_STATUSES.has(row.orderStatus)) continue;
    addTo(demandSales, row.articleId, Math.max(row.quantityOrdered - row.quantityDelivered, 0));
  }

  const supplyPo = new Map<string, number>();
  const supplyPoDraft = new Map<string, number>();
  for (const row of input.purchaseRows) {
    const rest = Math.max(row.quantityOrdered - row.quantityReceived, 0);
    if (row.orderStatus === "draft") addTo(supplyPoDraft, row.articleId, rest);
    else if (SUPPLY_PO_STATUSES.has(row.orderStatus)) addTo(supplyPo, row.articleId, rest);
  }

  const supplyMo = new Map<string, number>();
  const plannedMo = new Map<string, number>();
  for (const order of input.manufacturingOrders) {
    if (!SUPPLY_MO_STATUSES.has(order.status)) continue;
    addTo(supplyMo, order.articleId, order.quantity);
    // A configured planned TO already has its material rows (counted below
    // via MATERIAL_MO_STATUSES) — exploding it too would double the demand.
    if (order.status === "planned" && !order.configured) addTo(plannedMo, order.articleId, order.quantity);
  }

  const demandMo = new Map<string, number>();
  for (const row of input.moMaterialRows) {
    if (!MATERIAL_MO_STATUSES.has(row.orderStatus)) continue;
    addTo(demandMo, row.componentArticleId, Math.max(row.quantityPlanned - row.quantityConsumed, 0));
  }
  // Planned MOs have no snapshot yet — explode their summed quantity one
  // level (explosion is linear, so summing first is equivalent and cheaper).
  for (const [articleId, quantity] of plannedMo) {
    for (const [componentId, componentQuantity] of explodeFromIndex(
      bomIndex,
      phantomIds,
      articleId,
      quantity
    )) {
      addTo(demandMo, componentId, componentQuantity);
    }
  }

  const onHand = new Map<string, number>();
  for (const row of input.stock) addTo(onHand, row.articleId, row.quantity);

  const suppliers = new Map(input.primarySuppliers.map((s) => [s.articleId, s]));

  // Net level by level, finished goods first, so a parent's proposal has
  // already contributed derived demand by the time its components are netted.
  const levels = computeLowLevelCodes(input.bomEdges);
  const ordered = [...input.articles].sort(
    (a, b) => (levels.get(a.articleId) ?? 0) - (levels.get(b.articleId) ?? 0)
  );

  const demandDerived = new Map<string, number>();
  // Konfigurator 4c: the configured rows' derived material (one derivation
  // per configuration, done by the planning service) is demand from TOs that
  // do not exist yet — like a proposal's cascade, derived demand, so the
  // article overview (which shows no proposals) and this calc stay in step.
  for (const [componentId, quantity] of input.configuredCascade) addTo(demandDerived, componentId, quantity);

  const rows: RequirementRow[] = [];
  for (const article of ordered) {
    if (article.isPhantom || article.type === "service") continue;
    // A to_order template is never proposed itself: its stock is shared by
    // every configuration, and the TOs are made per configured KO row below.
    const isConfiguredTemplate = article.configuratorMode === "to_order";

    const id = article.articleId;
    const stockQty = onHand.get(id) ?? 0;
    const dSales = demandSales.get(id) ?? 0;
    const dMo = demandMo.get(id) ?? 0;
    const dDerived = demandDerived.get(id) ?? 0;
    const sPo = supplyPo.get(id) ?? 0;
    const sPoDraft = supplyPoDraft.get(id) ?? 0;
    const sMo = supplyMo.get(id) ?? 0;
    const projected = stockQty - (dSales + dMo + dDerived) + (sPo + sPoDraft + sMo);

    // Reorder point compares against the projected balance (inventory
    // position), not raw on-hand — classic ROP, spelled out in the manual.
    // Säkerhetslager is the same kind of floor: below it a proposal fills the
    // balance back up to it, so the threshold is the larger of the two.
    const target = Math.max(article.reorderPoint ?? 0, article.safetyStock ?? 0);
    const rawQuantity = Math.max(0, target - projected);
    let proposalQuantity = 0;
    if (rawQuantity > 0 && article.active && !isConfiguredTemplate) {
      if (article.orderQuantity != null && article.orderQuantity > 0) {
        // toFixed(6) guards float noise (0.30000000000000004 / 0.3) from
        // ceiling into an extra whole multiple.
        const multiples = Math.ceil(Number((rawQuantity / article.orderQuantity).toFixed(6)));
        proposalQuantity = multiples * article.orderQuantity;
      } else {
        proposalQuantity = rawQuantity;
      }
      // Avrundning LAST, on top of the order-quantity multiple: 100 kg in
      // 7.38 kg bars is 103.32 kg (14 bars). Shared with the order services
      // so a proposal and the IO/TO it becomes can never disagree.
      proposalQuantity = roundUpToMultiple(proposalQuantity, article.rounding);
    }

    const proposalKind =
      proposalQuantity > 0 ? (article.type === "manufactured" ? "manufacture" : "purchase") : null;

    // Cascade with the ROUNDED proposal — that is the quantity the TO will
    // actually be created for, so the components must plan for it.
    if (proposalKind === "manufacture") {
      for (const [componentId, componentQuantity] of explodeFromIndex(
        bomIndex,
        phantomIds,
        id,
        proposalQuantity
      )) {
        addTo(demandDerived, componentId, componentQuantity);
      }
    }

    const isRelevant =
      dSales > 0 ||
      dMo > 0 ||
      dDerived > 0 ||
      sPo > 0 ||
      sPoDraft > 0 ||
      sMo > 0 ||
      stockQty !== 0 ||
      article.reorderPoint != null ||
      article.safetyStock != null ||
      proposalQuantity > 0;
    if (!isRelevant) continue;

    const supplier = suppliers.get(id);
    rows.push({
      articleId: id,
      articleNumber: article.articleNumber,
      articleName: article.name,
      type: article.type,
      unitCode: article.unitCode,
      groupId: article.groupId,
      active: article.active,
      onHand: stockQty,
      demandSales: dSales,
      demandMo: dMo,
      demandDerived: dDerived,
      supplyPo: sPo,
      supplyPoDraft: sPoDraft,
      supplyMo: sMo,
      projected,
      reorderPoint: article.reorderPoint,
      safetyStock: article.safetyStock ?? null,
      orderQuantity: article.orderQuantity,
      rounding: article.rounding,
      proposalQuantity,
      proposalKind,
      primarySupplier: supplier
        ? {
            supplierId: supplier.supplierId,
            supplierName: supplier.supplierName,
            price: supplier.price,
            currency: supplier.currency,
            leadTimeDays: supplier.leadTimeDays,
          }
        : null,
      ...(isConfiguredTemplate ? { configuredTemplate: true } : {}),
    });
  }

  rows.sort((a, b) => (a.articleNumber < b.articleNumber ? -1 : a.articleNumber > b.articleNumber ? 1 : 0));

  // Konfigurator 4c: one proposal row per configured sales order row still
  // needing a TO — "Skapa ordrar" makes the TO from the row (its own choices).
  // Sorted by order number, then row id, after the article rows. Nothing is
  // netted here: the row's material already arrived via configuredCascade.
  const articleById = new Map(input.articles.map((a) => [a.articleId, a]));
  const configuredRows = input.configuredRows
    .filter((c) => c.uncoveredQuantity > 0)
    .sort((a, b) =>
      a.orderNumber !== b.orderNumber
        ? a.orderNumber < b.orderNumber
          ? -1
          : 1
        : a.salesOrderRowId < b.salesOrderRowId
          ? -1
          : 1
    )
    .map((c): RequirementRow => {
      const t = articleById.get(c.templateArticleId);
      return {
        articleId: c.templateArticleId,
        articleNumber: t?.articleNumber ?? "",
        articleName: t?.name ?? "",
        type: "manufactured",
        unitCode: t?.unitCode ?? null,
        groupId: t?.groupId ?? null,
        active: t?.active ?? true,
        onHand: 0,
        demandSales: 0,
        demandMo: 0,
        demandDerived: 0,
        supplyPo: 0,
        supplyPoDraft: 0,
        supplyMo: 0,
        projected: 0,
        reorderPoint: null,
        safetyStock: null,
        orderQuantity: null,
        rounding: null,
        proposalQuantity: c.uncoveredQuantity,
        proposalKind: "configured",
        primarySupplier: null,
        salesOrderRowId: c.salesOrderRowId,
        salesOrderId: c.salesOrderId,
        salesOrderNumber: c.orderNumber,
        customerName: c.customerName,
        configurationSummary: c.summary,
        expectedDeliveryDate: c.expectedDeliveryDate,
        configurationError: c.error,
      };
    });

  // Lego rows last, grouped by TO — they are operation needs, not article
  // needs: nothing is netted against stock or cascaded, only the already
  // bought quantity is deducted. A fully covered operation produces no row.
  const legoRows = input.legoOperationRows
    .map((op): RequirementRow | null => {
      const remaining = op.orderQuantity - op.orderedQuantity;
      if (remaining <= 0) return null;
      return {
        articleId: op.articleId,
        articleNumber: op.articleNumber,
        articleName: op.articleName,
        type: op.articleType,
        unitCode: op.unitCode,
        groupId: op.groupId,
        active: true,
        onHand: 0,
        demandSales: 0,
        demandMo: 0,
        demandDerived: 0,
        supplyPo: 0,
        supplyPoDraft: 0,
        supplyMo: 0,
        projected: 0,
        reorderPoint: null,
        safetyStock: null,
        orderQuantity: null,
        rounding: null,
        proposalQuantity: remaining,
        proposalKind: "subcontract",
        primarySupplier: op.supplierId
          ? {
              supplierId: op.supplierId,
              supplierName: op.supplierName ?? op.supplierId,
              price: op.unitPrice,
              currency: "SEK",
              leadTimeDays: null,
            }
          : null,
        moOperationId: op.moOperationId,
        moOrderNumber: op.orderNumber,
        moOperationLabel: `Op ${op.sequenceNo} · ${op.operationDescription ?? op.workCenterName}`,
        openInquiries: op.openInquiries,
      };
    })
    .filter((row): row is RequirementRow => row !== null)
    .sort((a, b) =>
      a.moOrderNumber !== b.moOrderNumber
        ? (a.moOrderNumber ?? "") < (b.moOrderNumber ?? "")
          ? -1
          : 1
        : (a.moOperationLabel ?? "") < (b.moOperationLabel ?? "")
          ? -1
          : 1
    );

  return [...rows, ...configuredRows, ...legoRows];
}
