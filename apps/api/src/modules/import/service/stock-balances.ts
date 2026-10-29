// Lagersaldon (#3; spec 2026-10-29-lagersaldoimport-design.md). Sibling of
// article-units.ts: the planner lives here, all database work in
// import.repository.ts.
//
// One row per (article, location). Antal is the balance on the location
// AFTER the import, like a stock count: the difference to today's balance is
// what gets booked, as an inventory_adjustment, so the same file twice
// changes nothing and a corrected file corrects the balance. An increase is
// valued at the row's À-pris (else the article's standard cost, the rule of
// a manual positive adjustment); a decrease is an outflow without a price.
//
// The location: Lager + Lagerplats name one (missing ones are created), a
// Lagerplats alone must be unambiguous, and neither means the article's own
// location or "***" — what resolveStockLocation does for every writer.
import type { ImportCommitInput } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
import type { ExistingArticle } from "./articles.js";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const STOCK_BALANCE_IMPORT_FIELDS = ["articleNumber", "warehouseName", "locationName", "quantity", "unitCost"] as const;
export type StockBalanceImportField = (typeof STOCK_BALANCE_IMPORT_FIELDS)[number];

const REQUIRED_FIELDS: StockBalanceImportField[] = ["articleNumber", "quantity"];

// Normalized header -> target field. The template's own headings plus the
// usual names in a stock list (Lagerställe, Saldo, Lagersaldo, Inpris).
export const STOCK_BALANCE_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  lager: "warehouseName",
  lagerstalle: "warehouseName",
  lagernamn: "warehouseName",
  lagerplats: "locationName",
  plats: "locationName",
  hyllplats: "locationName",
  antal: "quantity",
  saldo: "quantity",
  lagersaldo: "quantity",
  isaldo: "quantity",
  apris: "unitCost",
  pris: "unitCost",
  inpris: "unitCost",
  styckpris: "unitCost",
  lagerpris: "unitCost",
};

export function suggestStockBalanceMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, STOCK_BALANCE_HEADER_ALIASES);
}

export interface ImportStockLocation {
  id: string;
  warehouseId: string;
  name: string;
}

export interface ImportWarehouse {
  id: string;
  name: string;
  active: boolean;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface StockBalanceImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  stockPlaces(): Promise<{ warehouses: ImportWarehouse[]; locations: ImportStockLocation[] }>;
  /** articleId -> its own active default location, when it has one. */
  articleDefaultLocations(articleIds: string[]): Promise<Map<string, string>>;
  /** The "***" location, when it exists yet. */
  fallbackLocationId(): Promise<string | null>;
  /** "<articleId>|<locationId>" -> today's balance. */
  stockBalances(articleIds: string[]): Promise<Map<string, number>>;
  /** Locations under an open stock count that blocks transactions (frysvakten). */
  locationsUnderCount(): Promise<Set<string>>;
}

// Where the row's balance lives, resolved inside the commit transaction:
// an existing location, one the import creates, or the article's own
// location / "***" (resolveStockLocation with no location).
export type StockBalanceTarget =
  | { kind: "location"; locationId: string }
  | { kind: "new"; warehouseName: string; locationName: string }
  | { kind: "default" };

export interface StockBalanceRowPlan {
  rowNumber: number;
  articleId: string;
  target: StockBalanceTarget;
  quantity: number;
  /** The row's À-pris, else the article's standard cost; null = unknown. */
  unitCost: number | null;
}

export interface StockBalanceImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Warehouses by name, locations as "Lager / Plats" — the preview's
  // "Skapas automatiskt". The other register keys stay empty (shared shape).
  willCreate: { units: string[]; articleGroups: string[]; warehouses: string[]; stockLocations: string[] };
  balances: StockBalanceRowPlan[];
  hasErrors: boolean;
}

export const STOCK_IMPORT_NOTE = "Import av lagersaldo";

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

function formatQuantity(value: number): string {
  return value.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch (and the repository reads the
// balance once more inside its transaction).
export async function planStockBalanceImport(
  input: ImportCommitInput,
  deps: StockBalanceImportDeps
): Promise<StockBalanceImportPlan> {
  const columns = resolveColumns(input.mapping, [...STOCK_BALANCE_IMPORT_FIELDS], REQUIRED_FIELDS);
  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const emptyCreate = { units: [], articleGroups: [], warehouses: [], stockLocations: [] };
  if (records.length === 0) {
    return { rows: [], summary: summarize([]), willCreate: emptyCreate, balances: [], hasErrors: false };
  }

  const numbers = records.map((r) => r["articleNumber"] ?? "").filter((n) => n !== "");
  const articlesByNumber = await deps.articlesByNumber(numbers);
  const articleIds = [...articlesByNumber.values()].map((a) => a.id);
  const [places, defaults, fallbackId, balances, underCount] = await Promise.all([
    deps.stockPlaces(),
    deps.articleDefaultLocations(articleIds),
    deps.fallbackLocationId(),
    deps.stockBalances(articleIds),
    deps.locationsUnderCount(),
  ]);

  const warehousesByName = new Map<string, ImportWarehouse[]>();
  for (const w of places.warehouses) {
    const key = w.name.toLowerCase();
    warehousesByName.set(key, [...(warehousesByName.get(key) ?? []), w]);
  }
  const warehouseNameById = new Map(places.warehouses.map((w) => [w.id, w.name]));
  const locationsByName = new Map<string, ImportStockLocation[]>();
  for (const l of places.locations) {
    const key = l.name.toLowerCase();
    locationsByName.set(key, [...(locationsByName.get(key) ?? []), l]);
  }

  const rows: ImportRowResult[] = [];
  const planned: StockBalanceRowPlan[] = [];
  const newWarehouses = new Map<string, string>();
  const newLocations = new Map<string, { warehouseName: string; locationName: string }>();
  // "<articleId>|<location key>" — the same article and place twice is an error.
  const seen = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = { ...record };

    const articleNumber = record["articleNumber"] ?? "";
    const article = articlesByNumber.get(articleNumber);
    if (articleNumber === "") errors.push("Artikelnummer saknas");
    else if (!article) errors.push(`Artikeln ${articleNumber} finns inte i artikelregistret`);
    else if (article.type === "service") errors.push(`Artikeln ${articleNumber} är en tjänst — tjänster lagerhålls inte`);
    else if (article.isPhantom) errors.push(`Artikeln ${articleNumber} är en fantomartikel — den lagerhålls aldrig`);

    const rawQuantity = record["quantity"] ?? "";
    let quantity: number | null = null;
    if (rawQuantity === "") errors.push("Antal saknas");
    else {
      quantity = normalizeDecimal(rawQuantity);
      if (quantity === null) errors.push(`Ogiltigt antal: "${rawQuantity}"`);
      else if (quantity < 0) {
        errors.push("Antal kan inte vara negativt — det är saldot efter importen");
        quantity = null;
      } else quantity = round4(quantity);
    }

    const rawCost = record["unitCost"] ?? "";
    let unitCost: number | null = null;
    if (rawCost !== "") {
      unitCost = normalizeDecimal(rawCost);
      if (unitCost === null) errors.push(`Ogiltigt à-pris: "${rawCost}"`);
      else if (unitCost < 0) {
        errors.push("À-priset kan inte vara negativt");
        unitCost = null;
      } else unitCost = round4(unitCost);
    }

    // The place.
    const warehouseName = record["warehouseName"] ?? "";
    const locationName = record["locationName"] ?? "";
    let target: StockBalanceTarget | null = null;
    let locationKey = "";
    if (warehouseName !== "" && locationName === "") {
      errors.push("Lagerplats saknas — ange lagerplatsen i lagret, eller lämna båda tomma för artikelns lagerplats");
    } else if (warehouseName !== "") {
      if (warehouseName.length > 100 || locationName.length > 100) errors.push("Lager och lagerplats får vara högst 100 tecken");
      const matches = warehousesByName.get(warehouseName.toLowerCase()) ?? [];
      if (matches.length > 1) {
        errors.push(`Det finns flera lager som heter ${warehouseName} — byt namn på ett av dem först`);
      } else if (matches.length === 1) {
        const warehouse = matches[0]!;
        if (!warehouse.active) warnings.push(`Lagret ${warehouse.name} är inaktivt`);
        const location = (locationsByName.get(locationName.toLowerCase()) ?? []).find((l) => l.warehouseId === warehouse.id);
        if (location) target = { kind: "location", locationId: location.id };
        else target = { kind: "new", warehouseName: warehouse.name, locationName };
      } else {
        const name = newWarehouses.get(warehouseName.toLowerCase()) ?? warehouseName;
        newWarehouses.set(warehouseName.toLowerCase(), name);
        target = { kind: "new", warehouseName: name, locationName };
      }
      if (target?.kind === "new") {
        const key = `${target.warehouseName.toLowerCase()}/${locationName.toLowerCase()}`;
        if (!newLocations.has(key)) newLocations.set(key, { warehouseName: target.warehouseName, locationName });
        target = { kind: "new", ...newLocations.get(key)! };
        locationKey = `new:${key}`;
      } else if (target) locationKey = target.locationId;
    } else if (locationName !== "") {
      const matches = locationsByName.get(locationName.toLowerCase()) ?? [];
      if (matches.length === 0) {
        errors.push(`Lagerplatsen ${locationName} finns inte — ange lager så skapas den`);
      } else if (matches.length > 1) {
        const where = matches.map((l) => warehouseNameById.get(l.warehouseId) ?? "?").join(", ");
        errors.push(`Lagerplatsen ${locationName} finns i flera lager (${where}) — ange lager`);
      } else {
        target = { kind: "location", locationId: matches[0]!.id };
        locationKey = matches[0]!.id;
      }
    } else if (article) {
      target = { kind: "default" };
      // Where resolveStockLocation will put it: the article's own location,
      // else "***" (created on first use — then there is no balance yet).
      locationKey = defaults.get(article.id) ?? fallbackId ?? "new:***";
    }

    if (article && locationKey !== "") {
      const key = `${article.id}|${locationKey}`;
      if (seen.has(key)) errors.push(`Artikel ${articleNumber} förekommer flera gånger på samma lagerplats i filen`);
      seen.add(key);
      if (!locationKey.startsWith("new:") && underCount.has(locationKey)) {
        errors.push("Lagerplatsen inventeras just nu och är spärrad för lagerhändelser");
      }
    }

    if (errors.length > 0 || !article || quantity === null || target === null) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    const current = locationKey.startsWith("new:") ? 0 : (balances.get(`${article.id}|${locationKey}`) ?? 0);
    const delta = round4(quantity - current);
    values["currentQuantity"] = current;
    values["change"] = delta;

    if (input.skipExisting && current !== 0) {
      rows.push(skippedRow(rowNumber, `Platsen har redan saldo ${formatQuantity(current)}`, values));
      return;
    }
    if (delta === 0) {
      rows.push(skippedRow(rowNumber, `Saldot är redan ${formatQuantity(current)}`, values));
      return;
    }

    let cost: number | null = null;
    if (delta > 0) {
      cost = unitCost ?? (article.standardCost === null ? null : Number(article.standardCost));
      if (cost === null) warnings.push("Varken à-pris eller standardkostnad — lagervärdet för ökningen blir okänt");
    } else {
      warnings.push(`Saldot minskar med ${formatQuantity(-delta)}`);
      if (unitCost !== null) warnings.push("À-priset används inte när saldot minskar");
    }

    rows.push({ rowNumber, action: current === 0 ? "create" : "update", errors, warnings, values });
    planned.push({ rowNumber, articleId: article.id, target, quantity, unitCost: cost });
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: {
      units: [],
      articleGroups: [],
      warehouses: [...newWarehouses.values()],
      stockLocations: [...newLocations.values()].map((l) => `${l.warehouseName} / ${l.locationName}`),
    },
    balances: planned,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
