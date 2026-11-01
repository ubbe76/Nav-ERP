// MRP light — pure net-requirements calculation (behovsberäkning).
// No database imports: the repository loads flat row-level data once and this
// module owns ALL the business rules — which statuses count as demand/supply,
// netting, reorder-point triggering and the multi-level proposal cascade —
// fully unit-testable without a database (same pure-function pattern as
// bucketMovements and computeOpenAmounts).
//
// Netting is time-phased on the DEMAND side (#13): the uncovered demands are
// grouped per need week and every week becomes a proposal with its own need
// date and latest order/start date. The SUPPLY side is still quantity only —
// stock plus every open IO/TO (dated, late or undated) is in the pool from
// the start: a demand an existing order covers is that order's business, the
// same philosophy as findFirmDemand. No rescheduling messages.

// Local literal unions rather than imports keep this leaf dependency-free;
// they mirror the pgEnums in packages/db exactly. The imports are pure: the
// rounding helper — deliberately the SAME function the order services apply
// to row quantities, so a proposal and the order it becomes agree — and the
// calendar rules in the delivery-days leaf (one implementation).
import { roundUpToMultiple } from "@navet/shared";
import {
  decodeDeliveryDefaults,
  effectiveDeliverySettings,
  latestPurchaseOrderDate,
  previousWorkingDay,
  stockholmToday,
  subtractWorkingDays,
  type DeliveryDefaults,
  type PartnerDeliveryFields,
} from "../../system/service/delivery-days.js";
import { mondayOf } from "./capacity-calc.js";

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
  // The need date — the SHIP date: the service's toShipDates has already
  // moved the customer's delivery date back (the same field name as the
  // article overview's sales rows, so the same helper shifts both). Absent
  // or null = undated demand.
  expectedDeliveryDate?: string | null;
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
  // The TO's start date (moStartDate in manufacturing-lead-time.ts) — the
  // need date of a planned TO's exploded components. Absent/null = undated.
  startDate?: string | null;
}

export interface MoMaterialRow {
  componentArticleId: string;
  orderStatus: ManufacturingOrderStatus;
  quantityPlanned: number;
  quantityConsumed: number;
  // The TO's start date (moStartDate) — when the material is needed.
  needDate?: string | null;
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
  // Fasta leveransdagar: the supplier's own fields (absent = follows the
  // system defaults) — the proposals' latest order date and Skapa ordrar's
  // IO dates.
  supplierDelivery?: PartnerDeliveryFields;
}

// Order creation (createOrdersFromProposals) resolves the à-pris for the
// proposal quantity from the staffel — see purchase/service/supplier-price.ts.
export interface PrimarySupplierWithBreaks extends PrimarySupplierInfo {
  priceBreaks: { fromQuantity: number; price: number }[];
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
  // When the operation must be at the supplier: its planned start week
  // (Monday) or the TO's start date. Absent/null = undated.
  needDate?: string | null;
  // The resource's Ledtid beställning (work_centers.order_lead_time_days):
  // working days before the need the order must be placed. null = 0.
  orderLeadTimeDays?: number | null;
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
  // false = the template article is inactive: the row is listed but, like
  // an inactive ordinary article, proposed nothing (the service cascades
  // nothing for it either).
  templateActive: boolean;
  // The row's SHIP date (toShipDates) — the configured TO's need date.
  expectedDeliveryDate: string | null;
  summary: string;
  uncoveredQuantity: number;
  error: string | null;
  // The configured TO's lead time in working days (the template's field,
  // else the derived structure's operations for the quantity). Absent = 0.
  leadDays?: number | null;
}

// Derived demand from outside the cascade: the material of TOs that do not
// exist yet (a configured row's derivation), dated with that TO's latest
// start. The undated configuredCascade map is the older form of the same
// thing; both are honoured so the service can move over.
export interface DerivedDemand {
  articleId: string;
  quantity: number;
  needDate: string | null;
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
  // Undated; see derivedDemands for the dated form.
  configuredCascade: Map<string, number>;
  derivedDemands?: DerivedDemand[];
  // The time-phasing's calendar. All optional with safe defaults so a caller
  // without them gets undated proposals dated from the real today: `today`
  // (Stockholm day) decides the current week, "late" and the reorder-point
  // proposal's date; `offDays` are the full-day holidays; `deliveryDefaults`
  // the system's supplier delivery-day defaults (latest order date).
  today?: string;
  offDays?: ReadonlySet<string>;
  deliveryDefaults?: DeliveryDefaults;
  // Tillverkningsledtid in working days for a manufactured article and a
  // proposal quantity (manufacturingLeadDays: the article's field, else its
  // routing for the quantity). Absent = 0 for every article.
  leadDaysFor?: (articleId: string, quantity: number) => number;
}

export type ProposalReason = "demand" | "reorder_point" | "undated";

// One proposal of an article row: a need week's uncovered demand (demand),
// the reorder-point top-up dated today (reorder_point) or the undated
// demands (undated, sorted last — "Saknar datum"). `key` is stable per
// article and week so the web can keep selections across refreshes.
export interface RequirementProposal {
  key: string;
  needDate: string | null; // the group's first uncovered demand day
  needWeek: string | null; // the ISO week's Monday the proposal is grouped in
  // Purchase: the latest order day (latestPurchaseOrderDate); manufacture:
  // the latest start (the working day before the need minus the lead time);
  // lego: the need minus Ledtid beställning; null when undated.
  latestDate: string | null;
  late: boolean; // latestDate < today
  quantity: number;
  reason: ProposalReason;
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
  // The sum of `proposals` (backwards compatible).
  proposalQuantity: number;
  proposals: RequirementProposal[];
  // Manufactured articles: the lead time the proposals were dated with (for
  // the summed quantity; quantity 1 when nothing is proposed). null for
  // purchased articles and the configured/lego rows.
  leadDays: number | null;
  // For sorting and the horizon filter: the earliest latestDate among the
  // proposals (null = none dated) and whether any proposal is late.
  earliestLatestDate: string | null;
  anyLate: boolean;
  // "configured" = a configured KO row (beställningsvara) needing its own TO;
  // keyed per SALES ORDER ROW, never netted against stock.
  proposalKind: "purchase" | "manufacture" | "subcontract" | "configured" | null;
  primarySupplier: Omit<PrimarySupplierInfo, "articleId" | "supplierDelivery"> | null;
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

// A dated demand on one article (null = undated, sorted last).
interface Demand {
  date: string | null;
  quantity: number;
}

function pushDemand(map: Map<string, Demand[]>, articleId: string, demand: Demand) {
  if (demand.quantity <= 0) return;
  const list = map.get(articleId);
  if (list) list.push(demand);
  else map.set(articleId, [demand]);
}

// Same scale as the stored quantities (numeric(14,4)) — keeps float noise
// from turning an exactly covered demand into a 1e-15 proposal.
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

// The proposal quantity for an uncovered quantity: whole order-quantity
// multiples first, Avrundning LAST on top (100 kg in 7.38 kg bars is 103.32
// kg, 14 bars). Shared with the order services so a proposal and the IO/TO
// it becomes can never disagree.
function orderQuantityFor(rawQuantity: number, article: RequirementsArticle): number {
  let quantity = rawQuantity;
  if (article.orderQuantity != null && article.orderQuantity > 0) {
    // toFixed(6) guards float noise (0.30000000000000004 / 0.3) from
    // ceiling into an extra whole multiple.
    const multiples = Math.ceil(Number((rawQuantity / article.orderQuantity).toFixed(6)));
    quantity = multiples * article.orderQuantity;
  }
  return roundUpToMultiple(quantity, article.rounding);
}

// The week a need is grouped in: its ISO week's Monday, but a need before
// the current week is planned in the current week — the past cannot be
// ordered for, and one late proposal is clearer than one per past week.
function needWeekOf(date: string, thisMonday: string): string {
  const monday = mondayOf(date);
  return monday < thisMonday ? thisMonday : monday;
}

// The latest start for a manufactured need: the working day before the need
// (the färdigdatum rule) minus the lead time in working days. Exported for
// the service, which dates a configured row's derived material with it.
export function latestStartFor(needDate: string, leadDays: number, offDays: ReadonlySet<string>): string {
  return subtractWorkingDays(previousWorkingDay(needDate, offDays), Math.max(0, leadDays), offDays);
}

const NO_PARTNER_SETTINGS: PartnerDeliveryFields = { deliveryWeekdays: [], deliveryDayMode: null, transitDays: null };

export function computeRequirements(input: RequirementsInput): RequirementRow[] {
  const today = input.today ?? stockholmToday();
  const thisMonday = mondayOf(today);
  const offDays = input.offDays ?? new Set<string>();
  const deliveryDefaults = input.deliveryDefaults ?? decodeDeliveryDefaults(() => null);
  const leadDaysFor = input.leadDaysFor ?? (() => 0);

  const phantomIds = new Set(input.articles.filter((a) => a.isPhantom).map((a) => a.articleId));
  const bomIndex = buildBomIndex(input.bomEdges);

  // Every demand per article with its date — the time-phased side. The
  // summed maps stay for the row's figures (demandSales/demandMo/…).
  const demands = new Map<string, Demand[]>();

  const demandSales = new Map<string, number>();
  for (const row of input.salesRows) {
    if (!DEMAND_SALES_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityOrdered - row.quantityDelivered, 0);
    addTo(demandSales, row.articleId, rest);
    pushDemand(demands, row.articleId, { date: row.expectedDeliveryDate ?? null, quantity: rest });
  }

  const supplyPo = new Map<string, number>();
  const supplyPoDraft = new Map<string, number>();
  for (const row of input.purchaseRows) {
    const rest = Math.max(row.quantityOrdered - row.quantityReceived, 0);
    if (row.orderStatus === "draft") addTo(supplyPoDraft, row.articleId, rest);
    else if (SUPPLY_PO_STATUSES.has(row.orderStatus)) addTo(supplyPo, row.articleId, rest);
  }

  const supplyMo = new Map<string, number>();
  const plannedMo: ManufacturingOrderRow[] = [];
  for (const order of input.manufacturingOrders) {
    if (!SUPPLY_MO_STATUSES.has(order.status)) continue;
    addTo(supplyMo, order.articleId, order.quantity);
    // A configured planned TO already has its material rows (counted below
    // via MATERIAL_MO_STATUSES) — exploding it too would double the demand.
    if (order.status === "planned" && !order.configured) plannedMo.push(order);
  }

  const demandMo = new Map<string, number>();
  for (const row of input.moMaterialRows) {
    if (!MATERIAL_MO_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityPlanned - row.quantityConsumed, 0);
    addTo(demandMo, row.componentArticleId, rest);
    pushDemand(demands, row.componentArticleId, { date: row.needDate ?? null, quantity: rest });
  }
  // Planned MOs have no snapshot yet — explode each one level, dated with
  // the TO's start date (explosion is linear, so per order equals the sum).
  for (const order of plannedMo) {
    for (const [componentId, componentQuantity] of explodeFromIndex(
      bomIndex,
      phantomIds,
      order.articleId,
      order.quantity
    )) {
      addTo(demandMo, componentId, componentQuantity);
      pushDemand(demands, componentId, { date: order.startDate ?? null, quantity: componentQuantity });
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
  for (const [componentId, quantity] of input.configuredCascade) {
    addTo(demandDerived, componentId, quantity);
    pushDemand(demands, componentId, { date: null, quantity });
  }
  for (const d of input.derivedDemands ?? []) {
    addTo(demandDerived, d.articleId, d.quantity);
    pushDemand(demands, d.articleId, { date: d.needDate, quantity: d.quantity });
  }

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

    const kind = article.type === "manufactured" ? "manufacture" : "purchase";
    const proposals: RequirementProposal[] = [];
    if (article.active && !isConfiguredTemplate) {
      // Säkerhetslager is the floor of the pool: stock plus all open supply
      // minus the safety stock is what the demands may draw on. Negative
      // stock and a pool already below the floor are a shortage today.
      const safety = article.safetyStock ?? 0;
      let pool = round4(Math.max(stockQty, 0) + sPo + sPoDraft + sMo - safety);
      const own: Demand[] = [...(demands.get(id) ?? [])];
      if (stockQty < 0) own.push({ date: today, quantity: -stockQty });
      if (pool < 0) {
        own.push({ date: today, quantity: -pool });
        pool = 0;
      }
      // Date order, undated last; a stable sort keeps same-day demands in
      // input order (irrelevant for the grouping, kept for determinism).
      own.sort((a, b) =>
        a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1
      );

      // Walk the demands drawing on the pool; what is not covered is
      // grouped per need week (undated in its own group, last).
      const groups = new Map<string | null, { needDate: string | null; uncovered: number }>();
      for (const demand of own) {
        const covered = Math.min(pool, demand.quantity);
        pool = round4(pool - covered);
        const uncovered = round4(demand.quantity - covered);
        if (uncovered <= 0) continue;
        const week = demand.date === null ? null : needWeekOf(demand.date, thisMonday);
        const group = groups.get(week);
        if (group) group.uncovered = round4(group.uncovered + uncovered);
        else groups.set(week, { needDate: demand.date, uncovered });
      }

      // One proposal per group in week order: the uncovered quantity less
      // the surplus the earlier proposals' order quantity/rounding left
      // over, which is carried forward (a surplus bought for week 45 is on
      // the shelf for week 47).
      let carry = 0;
      for (const [week, group] of groups) {
        const net = round4(group.uncovered - carry);
        if (net <= 0) {
          carry = round4(carry - group.uncovered);
          continue;
        }
        const quantity = orderQuantityFor(net, article);
        carry = round4(quantity - net);
        const needDate = group.needDate;
        let latestDate: string | null = null;
        if (needDate !== null) {
          if (kind === "manufacture") {
            latestDate = latestStartFor(needDate, leadDaysFor(id, quantity), offDays);
          } else {
            const supplier = suppliers.get(id);
            latestDate = latestPurchaseOrderDate({
              demandDate: needDate,
              leadTimeDays: supplier?.leadTimeDays ?? 0,
              settings: effectiveDeliverySettings(
                supplier?.supplierDelivery ?? NO_PARTNER_SETTINGS,
                "supplier",
                deliveryDefaults
              ),
              offDays,
            });
          }
        }
        proposals.push({
          key: `${kind}:${id}:${week ?? "undated"}`,
          needDate,
          needWeek: week,
          latestDate,
          late: latestDate !== null && latestDate < today,
          quantity,
          reason: needDate === null ? "undated" : "demand",
        });
      }

      // Beställningspunkten: is the inventory position after every demand
      // and proposal still below the reorder point, the difference is a
      // proposal dated today (classic ROP against the projected balance,
      // spelled out in the manual). Never late: it is not for a demand.
      const position = round4(projected + proposals.reduce((sum, p) => sum + p.quantity, 0));
      const reorderPoint = article.reorderPoint ?? 0;
      if (position < reorderPoint) {
        proposals.push({
          key: `${kind}:${id}:rop`,
          needDate: today,
          needWeek: thisMonday,
          latestDate: today,
          late: false,
          quantity: orderQuantityFor(round4(reorderPoint - position), article),
          reason: "reorder_point",
        });
      }
    }

    const proposalQuantity = round4(proposals.reduce((sum, p) => sum + p.quantity, 0));
    const proposalKind = proposalQuantity > 0 ? kind : null;

    // Cascade every manufacturing proposal with its ROUNDED quantity — that
    // is the quantity the TO will actually be created for — dated with the
    // proposal's latest start: that is when the components must be there.
    if (proposalKind === "manufacture") {
      for (const proposal of proposals) {
        for (const [componentId, componentQuantity] of explodeFromIndex(
          bomIndex,
          phantomIds,
          id,
          proposal.quantity
        )) {
          addTo(demandDerived, componentId, componentQuantity);
          pushDemand(demands, componentId, { date: proposal.latestDate, quantity: componentQuantity });
        }
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
      proposals,
      leadDays: article.type === "manufactured" ? leadDaysFor(id, proposalQuantity > 0 ? proposalQuantity : 1) : null,
      ...proposalSummary(proposals),
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
  // The proposal is dated like a manufacturing proposal: need = the row's
  // ship date, latest start = the working day before minus the lead time.
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
      const quantity = c.templateActive ? c.uncoveredQuantity : 0;
      const proposals: RequirementProposal[] = [];
      if (quantity > 0) {
        const needDate = c.expectedDeliveryDate;
        const latestDate = needDate === null ? null : latestStartFor(needDate, c.leadDays ?? 0, offDays);
        proposals.push({
          key: `configured:${c.salesOrderRowId}`,
          needDate,
          needWeek: needDate === null ? null : needWeekOf(needDate, thisMonday),
          latestDate,
          late: latestDate !== null && latestDate < today,
          quantity,
          reason: needDate === null ? "undated" : "demand",
        });
      }
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
        proposalQuantity: quantity,
        proposals,
        leadDays: null,
        ...proposalSummary(proposals),
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
  // Dated with the operation's need (planned week or TO start) and the
  // resource's Ledtid beställning before it.
  const legoRows = input.legoOperationRows
    .map((op): RequirementRow | null => {
      const remaining = op.orderQuantity - op.orderedQuantity;
      if (remaining <= 0) return null;
      const needDate = op.needDate ?? null;
      const latestDate =
        needDate === null ? null : subtractWorkingDays(needDate, Math.max(0, op.orderLeadTimeDays ?? 0), offDays);
      const proposals: RequirementProposal[] = [
        {
          key: `subcontract:${op.moOperationId}`,
          needDate,
          needWeek: needDate === null ? null : needWeekOf(needDate, thisMonday),
          latestDate,
          late: latestDate !== null && latestDate < today,
          quantity: remaining,
          reason: needDate === null ? "undated" : "demand",
        },
      ];
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
        proposals,
        leadDays: null,
        ...proposalSummary(proposals),
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

// The row-level sort/filter fields derived from the proposals. Exported for
// the service's horizon filter, which recomputes them on the trimmed list.
export function proposalSummary(proposals: RequirementProposal[]): Pick<RequirementRow, "earliestLatestDate" | "anyLate"> {
  let earliest: string | null = null;
  for (const p of proposals) {
    if (p.latestDate !== null && (earliest === null || p.latestDate < earliest)) earliest = p.latestDate;
  }
  return { earliestLatestDate: earliest, anyLate: proposals.some((p) => p.late) };
}
