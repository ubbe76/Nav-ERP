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
// Lagerplats alone must be unambiguous, and neither means the article's
// huvudplats, else its first usable alternative place, else "***" — what
// resolveStockLocation does for every writer.
//
// Batch (#8): for a batchstyrd article the row may name a CELL — Batch is
// the batch number (created when missing), or "Okänd" for the stock without
// a batch — and Antal is then that cell's balance after the import. Without
// Batch the row is the whole place as before (an increase lands in Okänd).
// One (article, place) is written either per cell or as a whole, never both
// in one file. Batch on an article that is not batchstyrd is a row error
// (beslut 15). The batches one import creates all get the same age, so the
// batch number decides which is drawn first (compareBatches, beslut 16).
//
// Etapp 2: Batchdatum (the batch's age, so an older batch is drawn first)
// and Utgångsdatum, only on a row with a named Batch. They are set when the
// import creates the batch or the batch lacks the date; a batch that already
// has ANOTHER date keeps it and the row gets a warning — the import is not
// the way to correct a date (PATCH /stock/batches/:id is). A row whose
// balance is unchanged but whose dates fill in a batch is not skipped.
import { UNKNOWN_BATCH_LABEL, type ImportCommitInput } from "@navet/shared";
import { normalizeDay, normalizeDecimal } from "./csv.js";
import type { ExistingArticle } from "./articles.js";
import { FALLBACK_LOCATION_NAME } from "../../stock/service/outflow-allocation.js";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";
import { round4 } from "@navet/shared";

// Mappable target fields, in the order the wizard lists them.
export const STOCK_BALANCE_IMPORT_FIELDS = ["articleNumber", "warehouseName", "locationName", "quantity", "unitCost", "batchNumber", "batchDate", "expiresOn"] as const;
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
  // Deliberately narrow: only the template's own heading and its long forms.
  batch: "batchNumber",
  batchnummer: "batchNumber",
  batchnr: "batchNumber",
  // Etapp 2 — as narrow: the template's headings and their plain variants.
  batchdatum: "batchDate",
  utgangsdatum: "expiresOn",
  bastfore: "expiresOn",
  bastforedatum: "expiresOn",
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
  /** articleId -> where an inflow without a place lands (usableArticleLocations), when not "***". */
  usableArticleLocations(articleIds: string[]): Promise<Map<string, string>>;
  /** The "***" location, when it exists yet. */
  fallbackLocationId(): Promise<string | null>;
  /** "<articleId>|<locationId>" -> today's balance. */
  stockBalances(articleIds: string[]): Promise<Map<string, number>>;
  /** Locations under an open stock count that blocks transactions (frysvakten). */
  locationsUnderCount(): Promise<Set<string>>;
  /** stockBatchCellKey(articleId, locationId, batch) -> today's balance of the cell. */
  stockBatchBalances(articleIds: string[]): Promise<Map<string, number>>;
  /** stockBatchKey(articleId, batchNumber) -> the dates the batch has today (only existing batches). */
  stockBatchDates(articleIds: string[]): Promise<Map<string, { expiresOn: string | null; batchDate: string | null }>>;
}

// One spelling of a batch (article, number) for the planner's maps.
export function stockBatchKey(articleId: string, batchNumber: string): string {
  return `${articleId}|${batchNumber.toLocaleLowerCase("sv")}`;
}

// The row's batch: a named one, or the Okänd cell ("Okänd" in the file).
export type StockBalanceBatch = { kind: "named"; batchNumber: string } | { kind: "unknown" };

const UNKNOWN_BATCH_KEY = UNKNOWN_BATCH_LABEL.toLocaleLowerCase("sv");

// One spelling of a cell for the planner's maps (the commit matches batches
// in SQL, getOrCreateBatch). `batchNumber` null = the Okänd cell.
export function stockBatchCellKey(articleId: string, locationId: string, batchNumber: string | null): string {
  return `${articleId}|${locationId}|${batchNumber === null ? "" : `#${batchNumber.toLocaleLowerCase("sv")}`}`;
}

// Where the row's balance lives, resolved inside the commit transaction:
// an existing location, one the import creates, or the article's own
// location / "***" (resolveStockLocation with no location), or the
// reservplats "***" itself (getOrCreateFallbackLocation).
export type StockBalanceTarget =
  | { kind: "location"; locationId: string }
  | { kind: "new"; warehouseName: string; locationName: string }
  | { kind: "fallback" }
  | { kind: "default" };

export interface StockBalanceRowPlan {
  rowNumber: number;
  articleId: string;
  target: StockBalanceTarget;
  quantity: number;
  /** The row's À-pris, else the article's standard cost; null = unknown. */
  unitCost: number | null;
  /** Batch (#8): null = the whole place (as always); else the cell Antal is the balance of. */
  batch: StockBalanceBatch | null;
  /** Etapp 2, a named batch only: the dates to set when the batch is created or lacks them. */
  batchDate?: string | null;
  expiresOn?: string | null;
  /** The balance is unchanged — the row is only there to fill in the batch's dates. */
  datesOnly?: boolean;
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
  // Only the batchstyrda articles the file names a batch for have cells to read.
  const cellArticleIds = [
    ...new Set(
      records.flatMap((r) => {
        const article = articlesByNumber.get(r["articleNumber"] ?? "");
        return article && (article.tracking ?? "none") !== "none" && (r["batchNumber"] ?? "") !== "" ? [article.id] : [];
      })
    ),
  ];
  const [places, defaults, fallbackId, balances, underCount, cellBalances, batchDates] = await Promise.all([
    deps.stockPlaces(),
    deps.usableArticleLocations(articleIds),
    deps.fallbackLocationId(),
    deps.stockBalances(articleIds),
    deps.locationsUnderCount(),
    cellArticleIds.length > 0 ? deps.stockBatchBalances(cellArticleIds) : Promise.resolve(new Map<string, number>()),
    cellArticleIds.length > 0
      ? deps.stockBatchDates(cellArticleIds)
      : Promise.resolve(new Map<string, { expiresOn: string | null; batchDate: string | null }>()),
  ]);
  // The dates the file gives a batch — the same batch on several places must
  // say the same thing.
  const fileBatchDates = new Map<string, { batchDate: string | null; expiresOn: string | null }>();

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
  // First-seen spelling of a warehouse / place the file names that does not
  // exist — so every row of one new place carries the same names. What is
  // actually created is collected from the BOOKED rows (willCreate below).
  const newWarehouses = new Map<string, string>();
  const newLocations = new Map<string, { warehouseName: string; locationName: string }>();
  // "<articleId>|<location key>|<batch>" — the same article and place (and
  // batch) twice is an error.
  const seen = new Set<string>();
  // "<articleId>|<location key>" -> written per cell (Batch filled) or as a
  // whole place (Batch empty); both in one file is ambiguous.
  const placeModes = new Map<string, "cell" | "place">();

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

    // The batch (#8).
    const rawBatch = record["batchNumber"] ?? "";
    let batch: StockBalanceBatch | null = null;
    if (rawBatch !== "") {
      if (article && (article.tracking ?? "none") === "none") {
        errors.push(`Artikeln ${articleNumber} är inte batchstyrd — ta bort Batch eller gör artikeln batchstyrd först`);
      } else if (rawBatch.toLocaleLowerCase("sv") === UNKNOWN_BATCH_KEY) {
        batch = { kind: "unknown" };
      } else if (rawBatch.length > 50) {
        errors.push("Batch får vara högst 50 tecken");
      } else {
        batch = { kind: "named", batchNumber: rawBatch };
      }
    }

    // Batchdatum and Utgångsdatum (etapp 2) — a named batch's.
    const rowDates: { batchDate: string | null; expiresOn: string | null } = { batchDate: null, expiresOn: null };
    for (const [field, label] of [
      ["batchDate", "Batchdatum"],
      ["expiresOn", "Utgångsdatum"],
    ] as const) {
      const raw = record[field] ?? "";
      if (raw === "") continue;
      const day = normalizeDay(raw);
      if (day === null) errors.push(`Ogiltigt ${label.toLowerCase()}: "${raw}" (ÅÅÅÅ-MM-DD)`);
      else if (rawBatch === "" || batch?.kind === "unknown") errors.push(`${label} kräver ett batchnummer i kolumnen Batch`);
      else {
        rowDates[field] = day;
        values[field] = day;
      }
    }
    if (article && batch?.kind === "named") {
      const batchKey = stockBatchKey(article.id, batch.batchNumber);
      const inFile = fileBatchDates.get(batchKey) ?? { batchDate: null, expiresOn: null };
      for (const [field, label] of [
        ["batchDate", "Batchdatum"],
        ["expiresOn", "Utgångsdatum"],
      ] as const) {
        const day = rowDates[field];
        if (day === null) continue;
        if (inFile[field] !== null && inFile[field] !== day) {
          errors.push(`Batch ${batch.batchNumber} har olika ${label.toLowerCase()} i filen (${inFile[field]} och ${day})`);
        } else inFile[field] = day;
      }
      fileBatchDates.set(batchKey, inFile);
    }

    // The place.
    const warehouseName = record["warehouseName"] ?? "";
    const locationName = record["locationName"] ?? "";
    let target: StockBalanceTarget | null = null;
    let locationKey = "";
    if (locationName === FALLBACK_LOCATION_NAME) {
      // "***" is the ONE reservplats, whatever Lager the row names (the name
      // is reserved, stock.md) — the commit books it on
      // getOrCreateFallbackLocation. Planned as that place, never as a new
      // place in the named warehouse: today's balance, skipExisting, the
      // duplicate check and the frysvakt all read the real place, and
      // neither a warehouse nor a place is created for it.
      target = { kind: "fallback" };
      locationKey = fallbackId ?? "new:***";
    } else if (warehouseName !== "" && locationName === "") {
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
      // Where resolveStockLocation will put it: the article's huvudplats or
      // first usable alternative place, else "***" (created on first use —
      // then there is no balance yet).
      locationKey = defaults.get(article.id) ?? fallbackId ?? "new:***";
    }

    if (article && locationKey !== "") {
      const placeKey = `${article.id}|${locationKey}`;
      const key = batch === null ? placeKey : stockBatchCellKey(article.id, locationKey, batch.kind === "named" ? batch.batchNumber : null);
      if (seen.has(key)) {
        errors.push(
          batch === null
            ? `Artikel ${articleNumber} förekommer flera gånger på samma lagerplats i filen`
            : `Artikel ${articleNumber} förekommer flera gånger med samma batch på samma lagerplats i filen`
        );
      }
      seen.add(key);
      // Only a row whose Batch was understood takes a side.
      if (rawBatch === "" || batch !== null) {
        const mode = batch === null ? "place" : "cell";
        const earlier = placeModes.get(placeKey);
        if (earlier !== undefined && earlier !== mode) {
          errors.push(
            `Artikel ${articleNumber} har rader både med och utan Batch på samma lagerplats i filen — ange Batch på alla (Okänd för saldot utan batch) eller på ingen`
          );
        } else placeModes.set(placeKey, mode);
      }
      if (!locationKey.startsWith("new:") && underCount.has(locationKey)) {
        errors.push("Lagerplatsen inventeras just nu och är spärrad för lagerhändelser");
      }
    }

    if (errors.length > 0 || !article || quantity === null || target === null) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    // Today's balance: the place's, or — with Batch — the cell's.
    const current = locationKey.startsWith("new:")
      ? 0
      : batch === null
        ? (balances.get(`${article.id}|${locationKey}`) ?? 0)
        : (cellBalances.get(stockBatchCellKey(article.id, locationKey, batch.kind === "named" ? batch.batchNumber : null)) ?? 0);
    const delta = round4(quantity - current);
    values["currentQuantity"] = current;
    values["change"] = delta;

    // The dates against the batch as it is: missing ⇒ filled in, another
    // date ⇒ kept, with a warning. A batch the import creates gets both.
    const existingDates = batch?.kind === "named" ? batchDates.get(stockBatchKey(article.id, batch.batchNumber)) : undefined;
    let fillsDates = false;
    for (const [field, label] of [
      ["batchDate", "Batchdatum"],
      ["expiresOn", "Utgångsdatum"],
    ] as const) {
      const day = rowDates[field];
      if (day === null || batch?.kind !== "named") continue;
      const has = existingDates?.[field] ?? null;
      if (has !== null && has !== day) {
        warnings.push(`Batch ${batch.batchNumber} har redan ${label.toLowerCase()} ${has} — det står kvar (ändra det under Lager → Spårbarhet)`);
      } else if (has === null && existingDates !== undefined) fillsDates = true;
    }
    const dateFields = { ...(rowDates.batchDate !== null ? { batchDate: rowDates.batchDate } : {}), ...(rowDates.expiresOn !== null ? { expiresOn: rowDates.expiresOn } : {}) };

    if (input.skipExisting && current !== 0) {
      rows.push(skippedRow(rowNumber, `${batch === null ? "Platsen" : "Batchen"} har redan saldo ${formatQuantity(current)}`, values));
      return;
    }
    if (delta === 0) {
      if (fillsDates) {
        // Only the batch's missing dates are set — nothing is booked.
        rows.push({ rowNumber, action: "update", errors, warnings, values });
        planned.push({ rowNumber, articleId: article.id, target, quantity, unitCost: null, batch, ...dateFields, datesOnly: true });
        return;
      }
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
    planned.push({ rowNumber, articleId: article.id, target, quantity, unitCost: cost, batch, ...dateFields });
  });

  // Only what a booked row needs is created: a row that is skipped (antal 0
  // on a new place, skipExisting) or fails never gets a transaction, and the
  // commit creates places per booked row — a warehouse or place queued for
  // such a row would be promised in the preview and (the warehouse) created
  // empty.
  const createWarehouses = new Map<string, string>();
  const createLocations = new Map<string, string>();
  for (const row of planned) {
    if (row.target.kind !== "new") continue;
    const warehouseKey = row.target.warehouseName.toLowerCase();
    if (newWarehouses.has(warehouseKey)) createWarehouses.set(warehouseKey, row.target.warehouseName);
    createLocations.set(
      `${warehouseKey}/${row.target.locationName.toLowerCase()}`,
      `${row.target.warehouseName} / ${row.target.locationName}`
    );
  }

  return {
    rows,
    summary: summarize(rows),
    willCreate: {
      units: [],
      articleGroups: [],
      warehouses: [...createWarehouses.values()],
      stockLocations: [...createLocations.values()],
    },
    balances: planned,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
