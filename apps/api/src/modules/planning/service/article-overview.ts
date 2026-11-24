// Artikelöversikt — Monitor G5's "planeringsbild" for ONE article: every
// open demand and supply as its own row, in date order, with a running
// projected balance. Pure like requirements-calc.ts: the repository loads
// flat rows, this module owns the rules. It deliberately shares the status
// sets and the phantom-dissolving explosion with the behovsberäkning so the
// two can never disagree about what counts — closingBalance equals the MRP
// row's projected PLUS demandDerived (projected subtracts the derived demand,
// which comes from order PROPOSALS — not orders yet, so no row here), minus
// the difference between this overview's forecast and the calc's
// demandForecast (the calc lets derived demand consume the forecast too).
//
// The PLANNED view (`input.planned`, GET /articles/:id/overview?planned=true,
// user's goal 2026-11-24: "en bättre överblick på behovet man beställer eller
// skapar tillverkning mot") adds what the behovsberäkning plans on top: its
// derived demand per proposal it comes from (`derived_demand`) and the
// article's own proposals as supply (`proposal`). The derived demand then
// consumes the forecast as in the calc, so closingBalance === projected +
// proposalQuantity — Disponibelt ends where the behovsberäkning's proposals
// leave the article. Neither kind is firm (isFirmOverviewRow).
import {
  DEMAND_SALES_STATUSES,
  MATERIAL_MO_STATUSES,
  SUPPLY_MO_STATUSES,
  SUPPLY_PO_STATUSES,
  buildBomIndex,
  explodeFromIndex,
  type BomEdge,
  type ManufacturingOrderStatus,
  type PlannedDerivedDemand,
  type ProposalReason,
  type PurchaseOrderStatus,
  type RequirementProposal,
  type SalesOrderStatus,
} from "./requirements-calc.js";
import { isoWeekOf } from "../../timereport/service/schedule.service.js";
import type { PartnerDeliveryFields } from "../../system/service/delivery-days.js";
import { forecastWeeklyDemands, type ArticleForecastInput, type DatedDemand, type ForecastCalendar } from "./forecast.js";
import { round4 } from "@navet/shared";

export interface OverviewArticle {
  articleId: string;
  articleNumber: string;
  name: string;
  type: "manufactured" | "purchased" | "service";
  isPhantom: boolean;
  active: boolean;
  unitCode: string | null;
  reorderPoint: number | null;
  // Säkerhetslager — shown in the header; the overview itself nets nothing
  // against it (the behovsberäkning's proposals do). Optional for the fixtures.
  safetyStock?: number | null;
  orderQuantity: number | null;
  // Same article shape as RequirementsArticle so the two readers never drift;
  // the overview itself rounds nothing.
  rounding: number | null;
  // Prognosstyrd (#10) — passed through; the service decides whether to
  // build `ArticleOverviewInput.forecast` from it. Optional for the fixtures.
  forecastControlled?: boolean;
  configuratorMode?: "variants" | "to_order" | null;
}

export interface OverviewSalesRow {
  rowId: string;
  salesOrderId: string;
  orderNumber: string;
  orderStatus: SalesOrderStatus;
  customerName: string;
  // The date the row is planned by. The repository loads the order's
  // delivery date (the day the customer gets the goods); the planning
  // service moves it to the ship date (fasta leveransdagar) before the
  // builder runs. The builder itself never looks at customerDelivery.
  expectedDeliveryDate: string | null;
  customerDelivery?: PartnerDeliveryFields;
  quantityOrdered: number;
  quantityDelivered: number;
}

// Only rows without mo_operation_id — lego rows are operation demand, never
// article supply (see loadRequirementsInput).
export interface OverviewPurchaseRow {
  rowId: string;
  purchaseOrderId: string;
  orderNumber: string;
  orderStatus: PurchaseOrderStatus;
  supplierName: string;
  expectedDeliveryDate: string | null;
  quantityOrdered: number;
  quantityReceived: number;
}

// MOs FOR the article (supply).
export interface OverviewManufacturingOrder {
  moId: string;
  orderNumber: string;
  status: ManufacturingOrderStatus;
  dueDate: string | null;
  quantity: number;
}

// Material snapshot rows where the article is the component. The row is
// DATED by needDate — the parent TO's start (moStartDate: its earliest
// planned week, else due date minus lead time; tidsfasade förslag #13) —
// which the planning service computes from the repository's dueDate and
// parentArticleId. The TO's own due date is kept for the readers that show it.
export interface OverviewMaterialRow {
  rowId: string;
  moId: string;
  orderNumber: string;
  orderStatus: ManufacturingOrderStatus;
  dueDate: string | null;
  needDate: string | null;
  parentArticleId: string;
  parentArticleNumber: string;
  parentArticleName: string;
  quantityPlanned: number;
  quantityConsumed: number;
}

// Every status = planned MO, regardless of article — a planned MO has no
// snapshot yet, so which ones need this article is decided by exploding
// the parent's BOM (one level, phantoms dissolved), exactly as the MRP does.
// Dated by needDate like the material rows.
export interface OverviewPlannedMo {
  moId: string;
  orderNumber: string;
  dueDate: string | null;
  needDate: string | null;
  parentArticleId: string;
  parentArticleNumber: string;
  parentArticleName: string;
  quantity: number;
}

export interface ArticleOverviewInput {
  article: OverviewArticle;
  // Användbart saldo (onHandByArticle): what a Spärrad lagerplats holds is
  // left out — the rows and closingBalance start from this.
  onHand: number;
  // The balance on blocked places — passed through for display, never part
  // of the calculation. Omitted = 0.
  blockedOnHand?: number;
  salesRows: OverviewSalesRow[];
  purchaseRows: OverviewPurchaseRow[];
  manufacturingOrders: OverviewManufacturingOrder[];
  materialRows: OverviewMaterialRow[];
  plannedMos: OverviewPlannedMo[];
  bomEdges: BomEdge[];
  phantomIds: string[];
  primarySupplier: { supplierId: string; supplierName: string; leadTimeDays: number | null } | null;
  // Prognos (#10): present only for a prognosstyrd article — the builder adds
  // the weekly forecast demands (forecast.ts) consumed by the demand rows
  // above, the same way the behovsberäkning does. Absent = no forecast rows.
  forecast?: { input: ArticleForecastInput; calendar: ForecastCalendar };
  // The planned view (see the header): from ONE behovsberäkning run (the
  // service's cached result). Absent = the firm overview, as every other
  // reader (pegging, Leveranstidskontroll, Skapa saknade) builds it.
  planned?: OverviewPlannedInput;
}

export interface OverviewPlannedInput {
  // When the behovsberäkning run was computed (its computedAt).
  computedAt: string;
  // computeRequirementsDetailed's derivedByArticle for this article.
  derived: PlannedDerivedDemand[];
  // The article row's proposals (none for an article without a row).
  proposals: RequirementProposal[];
  // The proposals' supplier (purchase) — the row's primary supplier.
  supplierName: string | null;
}

// What the repository loads: the input without the TO start dates, which the
// planning service adds (it needs the holiday register and the TOs'
// operations — requirements-dating.ts) before the builder runs.
export interface ArticleOverviewLoad extends Omit<ArticleOverviewInput, "materialRows" | "plannedMos"> {
  materialRows: Omit<OverviewMaterialRow, "needDate">[];
  plannedMos: Omit<OverviewPlannedMo, "needDate">[];
}

export type OverviewRowKind =
  | "sales_order"
  | "mo_material"
  | "mo_planned_material"
  | "manufacturing_order"
  | "purchase_order"
  // Prognos (#10): one week's forecast demand — no document behind it.
  | "forecast"
  // The planned view only: a behovsberäkning proposal's material (one row
  // per proposal it comes from) and the article's own proposals.
  | "derived_demand"
  | "proposal";

export interface ArticleOverviewRow {
  // Kind-prefixed source id — unique across kinds, stable between reloads.
  id: string;
  kind: OverviewRowKind;
  direction: "demand" | "supply";
  date: string | null; // YYYY-MM-DD; null = the order has no date yet
  // null only on `forecast` rows (documentNumber then reads "Prognos 2026-11 · v.47").
  documentType: "sales_order" | "purchase_order" | "manufacturing_order" | null;
  documentId: string | null;
  documentNumber: string;
  status: string;
  // Customer / supplier name; for MO material the parent article.
  partner: string | null;
  quantity: number; // SIGNED: demand < 0, supply > 0
  balance: number; // onHand + Σ quantity up to and including this row
  isDraft: boolean; // draft IO — counted (like supplyPoDraft), but marked
  // The article the demand is material for (mo_material, mo_planned_material,
  // derived_demand) — the web re-targets the overview to it, so the demand
  // can be followed up to the customer order.
  parentArticleId?: string;
  // `proposal` rows: the proposal (its key is the behovsberäkning's).
  proposal?: { key: string; reason: ProposalReason; latestDate: string | null; late: boolean };
  // `derived_demand` rows: the proposal it is material for and that
  // proposal's quantity — the web rescales the row (explosion is linear)
  // when another quantity is typed into it. Absent for the undated cascade.
  sourceProposal?: { key: string; quantity: number };
}

export interface ArticleOverview {
  article: OverviewArticle;
  primarySupplier: ArticleOverviewInput["primarySupplier"];
  // Usable — the physical Lagersaldo is onHand + blockedOnHand.
  onHand: number;
  blockedOnHand: number;
  rows: ArticleOverviewRow[];
  closingBalance: number;
  // Only the planned view: the behovsberäkning run its rows come from.
  planned?: { computedAt: string };
}

// Same day: receipts before withdrawals, then a fixed kind order, then the
// document number — so two loads of the same data render identically.
const KIND_ORDER: Record<OverviewRowKind, number> = {
  purchase_order: 0,
  manufacturing_order: 1,
  proposal: 2,
  sales_order: 3,
  mo_material: 4,
  mo_planned_material: 5,
  derived_demand: 6,
  forecast: 7,
};

// Inte ett skarpt behov (#10): a forecast row is planned for by the
// behovsberäkning but never moves a färdigdatum suggestion, a pegging
// allocation or a promised delivery date — pegOverview (and findFirmDemand
// on top of it) and Leveranstidskontrollen's pools skip the rows this says
// no to. ONE filter for all three. The planned view's rows (proposals and
// their derived demand) are not orders either — those readers never ask for
// them, and the filter would keep them out if one did.
export function isFirmOverviewRow(row: Pick<ArticleOverviewRow, "kind">): boolean {
  return row.kind !== "forecast" && row.kind !== "derived_demand" && row.kind !== "proposal";
}

// The Order column of a planned row: "Förslag v.49" (the proposal's need
// week), "Förslag" when undated.
export function proposalLabel(needWeek: string | null): string {
  return needWeek === null ? "Förslag" : `Förslag v.${isoWeekOf(needWeek).isoWeek}`;
}

// The firm demand rows as the forecast rule reads them (forecast.ts): the
// dated quantities that consume a month's forecast. Shared by the builder
// and GET /articles/:id/forecast so both see the same real demand.
export function firmDemandsOf(rows: readonly ArticleOverviewRow[]): DatedDemand[] {
  return rows.filter((r) => r.direction === "demand" && isFirmOverviewRow(r)).map((r) => ({ date: r.date, quantity: -r.quantity }));
}

// The closing balance without the forecast rows — stock plus every open
// supply minus every FIRM demand, summed in the same order and 4-decimal
// steps as closingBalance. What Skapa saknade halvfabrikat nets its new
// demands against below level 1 (level 1 goes through pegOverview, which
// skips the same rows): a forecast is planned for by the behovsberäkning,
// never a reason to make a TO for a parent's shortage.
export function firmClosingBalance(overview: Pick<ArticleOverview, "onHand" | "rows">): number {
  let balance = overview.onHand;
  for (const row of overview.rows) if (isFirmOverviewRow(row)) balance = round4(balance + row.quantity);
  return balance;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareOverviewRows(a: ArticleOverviewRow, b: ArticleOverviewRow): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return compareStrings(a.date, b.date);
  }
  if (a.direction !== b.direction) return a.direction === "supply" ? -1 : 1;
  if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (a.documentNumber !== b.documentNumber) return compareStrings(a.documentNumber, b.documentNumber);
  return compareStrings(a.id, b.id);
}

// One BOM index per edge list. A batch of overviews (pegParents behind the
// TO list and Beläggning, Leveranstidskontrollen, Skapa saknade halvfabrikat)
// shares ONE bomEdges array across every article's input; building the
// index per article made a batch O(articles × BOM edges) — Beläggning took
// ~1.7 s at 25 000 articles and 23 500 edges (perf run 2026-11-09). Keyed on
// the array itself, so a new load gets a new index and nothing outlives it.
const bomIndexByEdges = new WeakMap<BomEdge[], Map<string, BomEdge[]>>();
function bomIndexFor(edges: BomEdge[]): Map<string, BomEdge[]> {
  let index = bomIndexByEdges.get(edges);
  if (!index) {
    index = buildBomIndex(edges);
    bomIndexByEdges.set(edges, index);
  }
  return index;
}

export function buildArticleOverview(input: ArticleOverviewInput): ArticleOverview {
  const articleId = input.article.articleId;
  const rows: ArticleOverviewRow[] = [];

  for (const row of input.salesRows) {
    if (!DEMAND_SALES_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityOrdered - row.quantityDelivered, 0);
    if (rest <= 0) continue;
    rows.push({
      id: `so:${row.rowId}`,
      kind: "sales_order",
      direction: "demand",
      date: row.expectedDeliveryDate,
      documentType: "sales_order",
      documentId: row.salesOrderId,
      documentNumber: row.orderNumber,
      status: row.orderStatus,
      partner: row.customerName,
      quantity: -rest,
      balance: 0,
      isDraft: false,
    });
  }

  for (const row of input.purchaseRows) {
    const isDraft = row.orderStatus === "draft";
    if (!isDraft && !SUPPLY_PO_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityOrdered - row.quantityReceived, 0);
    if (rest <= 0) continue;
    rows.push({
      id: `po:${row.rowId}`,
      kind: "purchase_order",
      direction: "supply",
      date: row.expectedDeliveryDate,
      documentType: "purchase_order",
      documentId: row.purchaseOrderId,
      documentNumber: row.orderNumber,
      status: row.orderStatus,
      partner: row.supplierName,
      quantity: rest,
      balance: 0,
      isDraft,
    });
  }

  for (const order of input.manufacturingOrders) {
    if (!SUPPLY_MO_STATUSES.has(order.status)) continue;
    if (order.quantity <= 0) continue;
    rows.push({
      id: `mo:${order.moId}`,
      kind: "manufacturing_order",
      direction: "supply",
      date: order.dueDate,
      documentType: "manufacturing_order",
      documentId: order.moId,
      documentNumber: order.orderNumber,
      status: order.status,
      partner: null,
      quantity: order.quantity,
      balance: 0,
      isDraft: false,
    });
  }

  for (const row of input.materialRows) {
    if (!MATERIAL_MO_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityPlanned - row.quantityConsumed, 0);
    if (rest <= 0) continue;
    rows.push({
      id: `mat:${row.rowId}`,
      kind: "mo_material",
      direction: "demand",
      date: row.needDate,
      documentType: "manufacturing_order",
      documentId: row.moId,
      documentNumber: row.orderNumber,
      status: row.orderStatus,
      partner: `${row.parentArticleNumber} — ${row.parentArticleName}`,
      quantity: -rest,
      balance: 0,
      isDraft: false,
      parentArticleId: row.parentArticleId,
    });
  }

  // Exploding per MO (rather than the MRP's summed-per-parent shortcut)
  // gives one row per order; explosion is linear, so the totals agree.
  // The BOM index is built once per edge list, not once per article or
  // planned MO (bomIndexFor).
  const phantomIds = new Set(input.phantomIds);
  const bomIndex = bomIndexFor(input.bomEdges);
  for (const mo of input.plannedMos) {
    const need = explodeFromIndex(bomIndex, phantomIds, mo.parentArticleId, mo.quantity).get(articleId) ?? 0;
    if (need <= 0) continue;
    rows.push({
      id: `pmat:${mo.moId}`,
      kind: "mo_planned_material",
      direction: "demand",
      date: mo.needDate,
      documentType: "manufacturing_order",
      documentId: mo.moId,
      documentNumber: mo.orderNumber,
      status: "planned",
      partner: `${mo.parentArticleNumber} — ${mo.parentArticleName}`,
      quantity: -need,
      balance: 0,
      isDraft: false,
      parentArticleId: mo.parentArticleId,
    });
  }

  const planned = input.planned;
  if (planned) {
    for (const p of planned.proposals) {
      rows.push({
        id: `prop:${p.key}`,
        kind: "proposal",
        direction: "supply",
        // The need date: the proposal is there for its first uncovered
        // demand (supply before demand on the same day).
        date: p.needDate,
        documentType: null,
        documentId: null,
        documentNumber: proposalLabel(p.needWeek),
        status: "proposal",
        partner: planned.supplierName,
        quantity: p.quantity,
        balance: 0,
        isDraft: false,
        proposal: { key: p.key, reason: p.reason, latestDate: p.latestDate, late: p.late },
      });
    }
    // One row per proposal the material is for (a configured row's material
    // can list the component twice — summed, same date).
    const bySource = new Map<string, ArticleOverviewRow>();
    for (const d of planned.derived) {
      const sourceKey = d.source?.proposalKey ?? "cascade";
      const existing = bySource.get(sourceKey);
      if (existing) {
        existing.quantity = round4(existing.quantity - d.quantity);
        continue;
      }
      const s = d.source;
      const row: ArticleOverviewRow = {
        id: `drv:${sourceKey}`,
        kind: "derived_demand",
        direction: "demand",
        date: d.date,
        // A configured row's material is for the KO row's TO-to-be: the KO
        // is the document. A parent's proposal has none yet.
        documentType: s?.salesOrderId ? "sales_order" : null,
        documentId: s?.salesOrderId ?? null,
        documentNumber: s?.salesOrderNumber ?? proposalLabel(s?.needWeek ?? null),
        status: "proposal",
        partner: s ? `${s.articleNumber} — ${s.articleName}` : null,
        quantity: round4(-d.quantity),
        balance: 0,
        isDraft: false,
        ...(s ? { parentArticleId: s.articleId, sourceProposal: { key: s.proposalKey, quantity: s.proposalQuantity } } : {}),
      };
      bySource.set(sourceKey, row);
      rows.push(row);
    }
  }

  // Prognos (#10): the weekly forecast demands, consumed by the demand rows
  // above — the same rule and the same dated rows as the behovsberäkning's
  // consumed by the firm rows only (the calc also lets derived demand consume
  // it), so the invariant is closingBalance === projected + demandDerived −
  // (this forecast − the calc's demandForecast). The planned view lets its
  // derived demand consume it too, exactly as the calc does.
  if (input.forecast) {
    const consuming = planned
      ? [...firmDemandsOf(rows), ...planned.derived.map((d) => ({ date: d.date, quantity: d.quantity }))]
      : firmDemandsOf(rows);
    const pieces = forecastWeeklyDemands(input.forecast.input, consuming, input.forecast.calendar);
    for (const piece of pieces) {
      rows.push({
        id: `fc:${piece.month}:${piece.date}`,
        kind: "forecast",
        direction: "demand",
        date: piece.date,
        documentType: null,
        documentId: null,
        documentNumber: piece.label,
        status: "forecast",
        partner: null,
        quantity: -piece.quantity,
        balance: 0,
        isDraft: false,
      });
    }
  }

  rows.sort(compareOverviewRows);

  let balance = input.onHand;
  for (const row of rows) {
    balance = round4(balance + row.quantity);
    row.balance = balance;
  }

  return {
    article: input.article,
    primarySupplier: input.primarySupplier,
    onHand: input.onHand,
    blockedOnHand: input.blockedOnHand ?? 0,
    rows,
    closingBalance: balance,
    ...(planned ? { planned: { computedAt: planned.computedAt } } : {}),
  };
}
