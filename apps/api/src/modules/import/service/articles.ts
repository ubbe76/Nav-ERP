import { isValidGtin, normalizeScanCode } from "@navet/shared";
// Article import (Monitor G5 CSV): builds an execution plan from mapped
// rows. The SAME builder runs for preview and commit — commit never trusts
// the preview round-trip and re-plans from scratch. The customer/supplier
// plans add sibling files customers.ts/suppliers.ts with
// planCustomerImport/planSupplierImport following the same shape: a
// plan<Entity>Import(input, deps) returning rows/summary/willCreate plus the
// entity-specific create/update lists that the repository's
// execute<Entity>Plan consumes in one transaction.
import type { ArticleType, ImportCommitInput } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const ARTICLE_IMPORT_FIELDS = [
  "articleNumber",
  "name",
  "type",
  "unitCode",
  "groupCode",
  "articleCode",
  "standardCost",
  "weight",
  "surfaceTreatment",
  "colour",
  // Monitor's "Extra benämning" (Artikellista, Extra fält) — multi-line.
  "extraDescription",
  // Streckkod (EAN/GTIN, #4).
  "barcode",
  "active",
  // Planning fields — Monitor's "Artikellista, Planering" export. 0 means
  // "none" there and clears the field here; lotSizingRule gates
  // orderQuantity (see planArticleImport).
  "reorderPoint",
  "orderQuantity",
  "rounding",
  "lotSizingRule",
  // Säkerhetslager (0 = none) and Styrning (Lagerstyrd/Orderstyrd).
  "safetyStock",
  "stockControlled",
  // Revisionsregistren on the card's Revisioner tab — the cell names the
  // revision (or drawing number) that should be there and active; see
  // planArticleImport.
  "articleRevision",
  "drawingNumber",
  "drawingRevision",
  // Monitor's Inköp tab: Antal/kolli and the article's Leverantörsnr — the
  // supplier becomes the article's primary supplier (Inköp tab), without a
  // price; prices come from the Prislista Inköp import.
  "quantityPerPackage",
  "primarySupplierNumber",
] as const;

// Normalized header -> target field (see normalizeHeader: "Benämning" ->
// "benamning", "Art.nr" -> "artnr"). Monitor's Varugrupp is the varugrupp
// (groupCode, the old "Artikelgrupp" headings still map) and its Artikelkod
// the artikelkod; Artikelkategori and the stock columns (Totalt saldo,
// Lagerplatsurval) are deliberately absent — they have no target field here
// and must be mapped by hand if a site wants them. The planning
// export's Min. kvantitet, Säkerhetslager, Ledtid etc. are likewise absent:
// order_quantity already acts as the minimum, and the rest have no field.
export const ARTICLE_HEADER_ALIASES: Record<string, string> = {
  bestallningspunkt: "reorderPoint",
  bestpunkt: "reorderPoint",
  bp: "reorderPoint",
  orderkvantitet: "orderQuantity",
  orderkvant: "orderQuantity",
  avrundning: "rounding",
  avrundningsantal: "rounding",
  partiformningsregel: "lotSizingRule",
  sakerhetslager: "safetyStock",
  styrning: "stockControlled",
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  benamning: "name",
  artikelbenamning: "name", // the real Monitor G5 export's header
  namn: "name",
  artikeltyp: "type",
  typ: "type",
  enhet: "unitCode",
  varugrupp: "groupCode",
  varugruppkod: "groupCode",
  artikelgrupp: "groupCode",
  artikelgruppkod: "groupCode",
  artikelkod: "articleCode",
  standardpris: "standardCost",
  standardkostnad: "standardCost",
  kostnad: "standardCost",
  vikt: "weight",
  // The template's heading "Vikt (kg)" normalizes to "viktkg".
  viktkg: "weight",
  nettovikt: "weight",
  ytbehandling: "surfaceTreatment",
  farg: "colour",
  kulor: "colour",
  extrabenamning: "extraDescription",
  ean: "barcode",
  eankod: "barcode",
  ean13: "barcode",
  gtin: "barcode",
  streckkod: "barcode",
  streckkodean: "barcode",
  aktiv: "active",
  status: "active",
  artikelrevision: "articleRevision",
  revision: "articleRevision",
  rev: "articleRevision",
  ritningsnummer: "drawingNumber",
  ritningsnr: "drawingNumber",
  ritnnr: "drawingNumber",
  ritning: "drawingNumber",
  ritningsrevision: "drawingRevision",
  ritningsrev: "drawingRevision",
  ritnrev: "drawingRevision",
  // "Antal/kolli (Inköp)" in Monitor's export.
  antalkolli: "quantityPerPackage",
  antalkolliinkop: "quantityPerPackage",
  antalperforpackning: "quantityPerPackage",
  forpackningsantal: "quantityPerPackage",
  leverantorsnr: "primarySupplierNumber",
  leverantorsnummer: "primarySupplierNumber",
  leverantor: "primarySupplierNumber",
  primarleverantor: "primarySupplierNumber",
};

export function suggestArticleMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, ARTICLE_HEADER_ALIASES);
}

// What the plan builder needs to know about an article that already exists —
// loaded once for every number in the file by the repository.
export interface ExistingArticle {
  id: string;
  articleNumber: string;
  name: string;
  type: ArticleType;
  unitCode: string;
  // The BOM import resolves a row's unit against the COMPONENT's own units,
  // so it needs the base unit's id — unitCode above is for display/compare.
  unitId: string;
  isPhantom: boolean;
  groupCode: string | null;
  // Optional: only the article import reads it.
  articleCode?: string | null;
  standardCost: string | null;
  // Optional: only the article import reads it (Streckkod, #4).
  barcode?: string | null;
  weight: string | null;
  surfaceTreatment: string | null;
  colour: string | null;
  active: boolean;
  // The article's active revision (article_revisions), null when none is
  // active. Optional: only the article import reads it.
  activeRevision?: string | null;
}

// Narrow lookups the builder runs against — implemented by
// createImportRepository, stubbed with Maps in tests.
export interface ArticleImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  // Streckkod (#4): barcode -> the article number that already has it. Only
  // asked when the file carries barcodes.
  articlesByBarcode(codes: string[]): Promise<Map<string, string>>;
  // Keyed by LOWERCASED code so "ST" in the CSV finds the "st" unit instead
  // of creating a case-variant duplicate.
  unitsByCode(): Promise<Map<string, { id: string; code: string }>>;
  groupsByCode(): Promise<Map<string, string>>;
  // Artikelkoder keyed by their exact code.
  articleCodesByCode(): Promise<Map<string, string>>;
  // Leverantörsnr -> supplier, for the primary-supplier column.
  suppliersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  // The same fallbacks createArticle uses ("st" + the "***" location),
  // resolved ONCE before rows are built.
  resolveDefaults(): Promise<{ unitId: string; locationId: string }>;
}

// The Revisioner tab's registers, set by one row: the article's active
// revision, and a drawing number with (optionally) its active revision.
// Absent = the row touches no register. executeArticlePlan applies it
// idempotently: a missing revision or drawing is added, an inactive revision
// is activated, and nothing is ever removed.
export interface ArticleRevisionPlan {
  articleRevision: string | null;
  drawingNumber: string | null;
  drawingRevision: string | null;
}

export interface ArticleCreatePlan {
  articleNumber: string;
  name: string;
  type: ArticleType;
  /** Monitor's FIKTIV — set together with type by parseArticleType. */
  isPhantom: boolean;
  unitCode: string | null; // null = the fallback "st" unit
  groupCode: string | null;
  // Optional: the bom import's article creates carry none.
  articleCode?: string | null;
  standardCost: number | null;
  weight: number | null;
  surfaceTreatment: string | null;
  colour: string | null;
  // Optional: the bom import's article creates carry none.
  extraDescription?: string | null;
  barcode?: string | null;
  active: boolean;
  reorderPoint: number | null;
  orderQuantity: number | null;
  rounding: number | null;
  revisions?: ArticleRevisionPlan;
  // Optional: the bom import's article creates carry none of these.
  safetyStock?: number | null;
  stockControlled?: boolean;
  quantityPerPackage?: number | null;
  primarySupplierId?: string | null;
}

export interface ArticleUpdatePlan {
  id: string;
  // Empty CSV cell = key absent = leave the stored value untouched. The
  // three planning fields are also patched to NULL by an explicit 0 —
  // Monitor's "none".
  patch: {
    name?: string;
    groupCode?: string; // resolved to groupId inside the commit transaction
    articleCode?: string; // resolved to articleCodeId the same way
    standardCost?: number;
    weight?: number;
    surfaceTreatment?: string | null;
    colour?: string | null;
    extraDescription?: string;
    barcode?: string;
    active?: boolean;
    reorderPoint?: number | null;
    orderQuantity?: number | null;
    rounding?: number | null;
    quantityPerPackage?: number | null;
    safetyStock?: number | null;
    stockControlled?: boolean;
  };
  revisions?: ArticleRevisionPlan;
  // Becomes the article's primary supplier (article_suppliers), added
  // without a price when the article has no row for it yet.
  primarySupplierId?: string;
}

export interface ArticleImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  willCreate: { units: string[]; articleGroups: string[]; articleCodes: string[] };
  creates: ArticleCreatePlan[];
  updates: ArticleUpdatePlan[];
  fallbackUnitId: string;
  fallbackLocationId: string;
  hasErrors: boolean;
}

// Varugruppskod: 1–4 digits (Monitor's Varugrupp is a single digit).
const GROUP_CODE_PATTERN = /^[0-9]{1,4}$/;
// Artikelkod: the register's code column (article_codes.code varchar(20)).
const ARTICLE_CODE_MAX = 20;

// The registers' own limits (article_revisions/article_drawing_revisions.revision
// varchar(20), article_drawings.drawing_number varchar(50)).
const REVISION_MAX = 20;
const DRAWING_NUMBER_MAX = 50;

// Monitor writes types in several shapes ("Tillverkad", "M", "Köpt", "P",
// "K", "Legoartikel"...). The ascii variants (tjanst/kop) also catch
// mojibake exports.
//
// Monitor's FIKTIV is this system's fantomartikel, which is not a type but
// the is_phantom FLAG beside one — so the cell resolves to a type AND the
// flag. A phantom is dissolved into its own components, so it must carry a
// structure, and the article card only shows the Beredning tab (BOM +
// routing) for manufactured articles: Fiktiv therefore lands on
// manufactured, never on the wizard's Standardtyp.
export interface ParsedArticleType {
  type: ArticleType;
  isPhantom: boolean;
}

export function parseArticleType(cell: string): ParsedArticleType | null {
  const value = cell.trim().toLowerCase();
  if (value.includes("fiktiv") || value === "f") return { type: "manufactured", isPhantom: true };
  if (value.includes("till")) return { type: "manufactured", isPhantom: false };
  if (value.includes("tjänst") || value.includes("tjanst") || value.includes("lego")) {
    return { type: "service", isPhantom: false };
  }
  if (value.includes("köp") || value.includes("kop")) return { type: "purchased", isPhantom: false };
  if (value === "m") return { type: "manufactured", isPhantom: false };
  if (value === "p" || value === "k") return { type: "purchased", isPhantom: false };
  return null;
}

function parseActive(cell: string): boolean | null {
  const value = cell.trim().toLowerCase();
  if (value === "ja" || value === "1" || value === "true") return true;
  if (value === "nej" || value === "0" || value === "false") return false;
  return null;
}

export async function planArticleImport(
  input: ImportCommitInput,
  deps: ArticleImportDeps
): Promise<ArticleImportPlan> {
  const columns = resolveColumns(input.mapping, [...ARTICLE_IMPORT_FIELDS], ["articleNumber"]);
  const fallback = await deps.resolveDefaults();
  const unitMap = await deps.unitsByCode();
  const groupMap = await deps.groupsByCode();
  const articleCodeMap = await deps.articleCodesByCode();

  // One record per CSV row: target field -> trimmed cell (mapped columns only).
  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["articleNumber"] ?? "").filter((n) => n !== "");
  const existingByNumber = await deps.articlesByNumber(numbers);
  const barcodeCells = records.map((r) => normalizeScanCode(r["barcode"] ?? "")).filter((c) => c !== "");
  const takenBarcodes = barcodeCells.length > 0 ? await deps.articlesByBarcode(barcodeCells) : new Map<string, string>();
  // Barcode -> the article number that claimed it first in this file.
  const barcodesInFile = new Map<string, string>();
  const supplierNumbers = records.map((r) => r["primarySupplierNumber"] ?? "").filter((n) => n !== "");
  const suppliersByNumber = supplierNumbers.length > 0 ? await deps.suppliersByNumber(supplierNumbers) : new Map();

  const rows: ImportRowResult[] = [];
  const creates: ArticleCreatePlan[] = [];
  const updates: ArticleUpdatePlan[] = [];
  // Lowercased code -> the first-seen original casing (what gets created).
  const newUnits = new Map<string, string>();
  const newGroups = new Set<string>();
  const newArticleCodes = new Set<string>();
  const seenNumbers = new Set<string>();

  records.forEach((record, index) => {
    // 1-based data rows, +1 for the header line — matches what the user sees
    // when the file is open in Excel.
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const articleNumber = record["articleNumber"] ?? "";
    values["articleNumber"] = articleNumber;
    if (articleNumber === "") {
      errors.push("Artikelnummer saknas");
    } else {
      if (articleNumber.length > 50) errors.push("Artikelnumret är för långt (max 50 tecken)");
      if (seenNumbers.has(articleNumber)) errors.push("Artikelnumret förekommer flera gånger i filen");
      seenNumbers.add(articleNumber);
    }

    const existing = existingByNumber.get(articleNumber);
    if (existing && input.skipExisting) {
      // "Hoppa över rader som redan finns": the article is left completely
      // alone — no patch, no cost-history row. Short-circuit before the field
      // validation below, so a bad cell on a row we are not importing cannot
      // block the file. The number is already in seenNumbers (recorded
      // above), so a second occurrence still blames the duplicate.
      rows.push(skippedRow(rowNumber, `Artikeln ${articleNumber} finns redan i artikelregistret`, { ...record }));
      return;
    }
    const action: "create" | "update" = existing ? "update" : "create";

    const name = record["name"] ?? "";
    if (name.length > 255) errors.push("Benämningen är för lång (max 255 tecken)");
    if (!existing && name === "") errors.push("Benämning saknas");
    if (name !== "") values["name"] = name;

    // type — NEVER changed on update (locked like the card's type field);
    // a differing value is a warning, not an update. The phantom flag rides
    // along with the type (Fiktiv) and follows the same lock: an existing
    // article's Fantomartikel is never flipped by an import.
    const typeCell = record["type"] ?? "";
    let parsedType: ParsedArticleType | null = null;
    if (typeCell !== "") {
      parsedType = parseArticleType(typeCell);
      if (parsedType === null) errors.push(`Okänd artikeltyp: "${typeCell}"`);
    }
    if (existing && parsedType !== null) {
      if (parsedType.type !== existing.type) {
        warnings.push(`Artikeltypen ändras inte vid uppdatering (behåller ${existing.type})`);
      }
      if (parsedType.isPhantom !== existing.isPhantom) {
        warnings.push(
          existing.isPhantom
            ? "Fantomartikeln ändras inte vid uppdatering (artikeln förblir fantom)"
            : "Fantomflaggan sätts inte vid uppdatering (artikeln förblir icke-fantom)"
        );
      }
    }

    // unitCode — NEVER changed on update (unit-lock rules: alternative-unit
    // factors would silently change meaning).
    const unitCode = record["unitCode"] ?? "";
    if (unitCode.length > 20) {
      errors.push("Enhetskoden är för lång (max 20 tecken)");
    } else if (unitCode !== "") {
      if (existing) {
        if (unitCode.toLowerCase() !== existing.unitCode.toLowerCase()) {
          warnings.push(`Grundenheten ändras inte vid uppdatering (behåller ${existing.unitCode})`);
        }
      } else {
        values["unitCode"] = unitCode;
        if (!unitMap.has(unitCode.toLowerCase()) && !newUnits.has(unitCode.toLowerCase())) {
          newUnits.set(unitCode.toLowerCase(), unitCode);
        }
      }
    }

    const groupCode = record["groupCode"] ?? "";
    if (groupCode !== "") {
      if (!GROUP_CODE_PATTERN.test(groupCode)) {
        errors.push(`Ogiltig varugruppskod: "${groupCode}" (1–4 siffror)`);
      } else {
        values["groupCode"] = groupCode;
        if (!groupMap.has(groupCode)) newGroups.add(groupCode);
      }
    }

    // Artikelkod — same rule as the varugrupp: a code missing from the
    // register is created (name = code), an empty cell leaves it untouched.
    const articleCode = record["articleCode"] ?? "";
    if (articleCode.length > ARTICLE_CODE_MAX) {
      errors.push(`Artikelkoden är för lång (max ${ARTICLE_CODE_MAX} tecken)`);
    } else if (articleCode !== "") {
      values["articleCode"] = articleCode;
      if (!articleCodeMap.has(articleCode)) newArticleCodes.add(articleCode);
    }

    const costCell = record["standardCost"] ?? "";
    let standardCost: number | null = null;
    if (costCell !== "") {
      standardCost = normalizeDecimal(costCell);
      if (standardCost === null) {
        errors.push(`Ogiltigt standardpris: "${costCell}"`);
      } else if (standardCost < 0) {
        errors.push("Standardpriset kan inte vara negativt");
        standardCost = null;
      } else {
        values["standardCost"] = standardCost;
      }
    }

    const weightCell = record["weight"] ?? "";
    let weight: number | null = null;
    if (weightCell !== "") {
      weight = normalizeDecimal(weightCell);
      if (weight === null) {
        errors.push(`Ogiltig vikt: "${weightCell}"`);
      } else if (weight < 0) {
        errors.push("Vikten kan inte vara negativ");
        weight = null;
      } else {
        values["weight"] = weight;
      }
    }

    // surfaceTreatment/colour — free text, nullable. Empty cell = leave the
    // existing value untouched (same "never blank a stored value from an
    // empty CSV cell" invariant as name/groupCode/weight above); a non-empty
    // cell only patches when it actually differs from the stored value, so
    // re-importing an unchanged file never stages a no-op write.
    const surfaceTreatmentCell = record["surfaceTreatment"] ?? "";
    let surfaceTreatment: string | null = null;
    if (surfaceTreatmentCell !== "") {
      if (surfaceTreatmentCell.length > 200) {
        errors.push("Fältet 'Ytbehandling' är för långt (max 200 tecken)");
      } else {
        surfaceTreatment = surfaceTreatmentCell;
        values["surfaceTreatment"] = surfaceTreatmentCell;
      }
    }

    const colourCell = record["colour"] ?? "";
    let colour: string | null = null;
    if (colourCell !== "") {
      if (colourCell.length > 200) {
        errors.push("Fältet 'Färg' är för långt (max 200 tecken)");
      } else {
        colour = colourCell;
        values["colour"] = colourCell;
      }
    }

    // Extra benämning — multi-line free text (xlsx.ts has already turned
    // Monitor's _x000d_ breaks into "\n"). Same 2000-character ceiling as
    // the article card; a longer text is a row error, never truncated.
    const extraDescriptionCell = record["extraDescription"] ?? "";
    let extraDescription: string | null = null;
    if (extraDescriptionCell !== "") {
      if (extraDescriptionCell.length > 2000) {
        errors.push(`Extra benämning är för lång (${extraDescriptionCell.length} tecken, max 2000)`);
      } else {
        extraDescription = extraDescriptionCell;
        values["extraDescription"] = extraDescriptionCell;
      }
    }

    // Streckkod (EAN/GTIN): a valid GTIN, unique across the register and the
    // file. Empty leaves the stored code alone, like the other text fields.
    const barcodeCell = normalizeScanCode(record["barcode"] ?? "");
    let barcode: string | null = null;
    if (barcodeCell !== "") {
      const rowNumberOf = record["articleNumber"] ?? "";
      const holder = takenBarcodes.get(barcodeCell);
      const fileHolder = barcodesInFile.get(barcodeCell);
      if (!isValidGtin(barcodeCell)) {
        errors.push(`Ogiltig streckkod "${barcodeCell}" — 8, 12, 13 eller 14 siffror med rätt kontrollsiffra`);
      } else if (holder !== undefined && holder !== rowNumberOf) {
        errors.push(`Streckkoden ${barcodeCell} finns redan på artikel ${holder}`);
      } else if (fileHolder !== undefined && fileHolder !== rowNumberOf) {
        errors.push(`Streckkoden ${barcodeCell} står också på artikel ${fileHolder} i filen`);
      } else {
        barcode = barcodeCell;
        values["barcode"] = barcodeCell;
        barcodesInFile.set(barcodeCell, rowNumberOf);
      }
    }

    const activeCell = record["active"] ?? "";
    let active: boolean | null = null;
    if (activeCell !== "") {
      active = parseActive(activeCell);
      if (active === null) {
        errors.push(`Ogiltigt värde för Aktiv: "${activeCell}" (Ja/Nej/1/0/true/false)`);
      } else {
        values["active"] = active;
      }
    }

    // Planning fields (Monitor's Planering export). A cell holding 0 is
    // Monitor's "none" and clears the field (undefined = untouched, null =
    // cleared). Orderkvantitet is only taken when Partiformningsregel says
    // "Fast orderstorlek" — with "Mot behov" Monitor plans purely on demand,
    // and importing the quantity would turn every such article into a
    // multiple-of-N buyer here. An unmapped rule column takes the quantity
    // as-is.
    const planning: { reorderPoint?: number | null; orderQuantity?: number | null; rounding?: number | null } = {};
    const reorderPointCell = record["reorderPoint"] ?? "";
    if (reorderPointCell !== "") {
      const parsed = normalizeDecimal(reorderPointCell);
      if (parsed === null) errors.push(`Ogiltig beställningspunkt: "${reorderPointCell}"`);
      else if (parsed < 0) errors.push("Beställningspunkten kan inte vara negativ");
      else {
        planning.reorderPoint = parsed === 0 ? null : parsed;
        values["reorderPoint"] = planning.reorderPoint;
      }
    }
    const lotSizingRuleCell = record["lotSizingRule"] ?? "";
    const fixedLotSize =
      !columns.includes("lotSizingRule") ||
      lotSizingRuleCell.toLowerCase().replace(/[^a-zåäö]/g, "") === "fastorderstorlek";
    const orderQuantityCell = record["orderQuantity"] ?? "";
    if (orderQuantityCell !== "") {
      const parsed = normalizeDecimal(orderQuantityCell);
      if (parsed === null) errors.push(`Ogiltig orderkvantitet: "${orderQuantityCell}"`);
      else if (parsed < 0) errors.push("Orderkvantiteten kan inte vara negativ");
      else if (fixedLotSize) {
        planning.orderQuantity = parsed === 0 ? null : parsed;
        values["orderQuantity"] = planning.orderQuantity;
      } else if (parsed > 0) {
        // 0 is Monitor's "none" — nothing is lost by skipping it, so only a
        // real quantity is worth a warning.
        warnings.push("Orderkvantitet hoppades över — Partiformningsregel är inte Fast orderstorlek");
      }
    }
    const roundingCell = record["rounding"] ?? "";
    if (roundingCell !== "") {
      const parsed = normalizeDecimal(roundingCell);
      if (parsed === null) errors.push(`Ogiltig avrundning: "${roundingCell}"`);
      else if (parsed < 0) errors.push("Avrundningen kan inte vara negativ");
      else {
        // numeric(14,3): more decimals are rounded, with a warning rather
        // than a refusal — 28,86000111 in the real export is 28,86.
        const rounded = Math.round(parsed * 1000) / 1000;
        if (rounded !== parsed) warnings.push(`Avrundningen ${roundingCell} avrundas till ${rounded} (högst 3 decimaler)`);
        planning.rounding = rounded === 0 ? null : rounded;
        values["rounding"] = planning.rounding;
      }
    }

    // Säkerhetslager — 0 is "none" like the other planning fields.
    const safetyStockCell = record["safetyStock"] ?? "";
    let safetyStock: number | null | undefined;
    if (safetyStockCell !== "") {
      const parsed = normalizeDecimal(safetyStockCell);
      if (parsed === null) errors.push(`Ogiltigt säkerhetslager: "${safetyStockCell}"`);
      else if (parsed < 0) errors.push("Säkerhetslagret kan inte vara negativt");
      else {
        safetyStock = parsed === 0 ? null : Math.round(parsed * 10000) / 10000;
        values["safetyStock"] = safetyStock;
      }
    }
    // Styrning: Lagerstyrd / Orderstyrd (information only).
    const stockControlledCell = record["stockControlled"] ?? "";
    let stockControlled: boolean | undefined;
    if (stockControlledCell !== "") {
      const word = stockControlledCell.toLowerCase();
      if (word.startsWith("lager")) stockControlled = true;
      else if (word.startsWith("order")) stockControlled = false;
      else errors.push(`Okänd styrning: "${stockControlledCell}" (Lagerstyrd eller Orderstyrd)`);
      if (stockControlled !== undefined) values["stockControlled"] = stockControlled;
    }

    // Revisioner. Artikelrevision becomes the article's active revision
    // (added when missing; the previous one stays, inactive) and is only
    // staged when it differs from the active one, so re-importing a file
    // writes nothing. Ritningsnummer is added when the article lacks it —
    // its other drawing numbers stay — and Ritningsrevision becomes the
    // active revision of THAT drawing, so it needs the number on its row.
    const articleRevision = record["articleRevision"] ?? "";
    const drawingNumber = record["drawingNumber"] ?? "";
    const drawingRevision = record["drawingRevision"] ?? "";
    if (articleRevision.length > REVISION_MAX) {
      errors.push(`Artikelrevisionen är för lång (max ${REVISION_MAX} tecken)`);
    } else if (articleRevision !== "") {
      values["articleRevision"] = articleRevision;
      const active = existing?.activeRevision ?? null;
      if (active !== null && active !== articleRevision) {
        warnings.push(`Aktiv artikelrevision byts från ${active} till ${articleRevision}`);
      }
    }
    if (drawingNumber.length > DRAWING_NUMBER_MAX) {
      errors.push(`Ritningsnumret är för långt (max ${DRAWING_NUMBER_MAX} tecken)`);
    } else if (drawingNumber !== "") {
      values["drawingNumber"] = drawingNumber;
    }
    if (drawingRevision.length > REVISION_MAX) {
      errors.push(`Ritningsrevisionen är för lång (max ${REVISION_MAX} tecken)`);
    } else if (drawingRevision !== "") {
      if (drawingNumber === "") errors.push("Ritningsrevision kräver ett ritningsnummer på samma rad");
      values["drawingRevision"] = drawingRevision;
    }
    const revisionPlan: ArticleRevisionPlan = {
      articleRevision:
        articleRevision !== "" && articleRevision !== (existing?.activeRevision ?? null) ? articleRevision : null,
      drawingNumber: drawingNumber !== "" ? drawingNumber : null,
      drawingRevision: drawingRevision !== "" ? drawingRevision : null,
    };
    const revisions =
      revisionPlan.articleRevision !== null || revisionPlan.drawingNumber !== null ? revisionPlan : undefined;

    // Antal/kolli: 0 is Monitor's "none" and clears the field, like the
    // planning fields; numeric(14,4) rounds further decimals with a warning.
    const packageCell = record["quantityPerPackage"] ?? "";
    let quantityPerPackage: number | null | undefined;
    if (packageCell !== "") {
      const parsed = normalizeDecimal(packageCell);
      if (parsed === null) errors.push(`Ogiltigt antal per förpackning: "${packageCell}"`);
      else if (parsed < 0) errors.push("Antal per förpackning kan inte vara negativt");
      else {
        const rounded = Math.round(parsed * 10000) / 10000;
        if (rounded !== parsed) warnings.push(`Antal per förpackning ${packageCell} avrundas till ${rounded} (högst 4 decimaler)`);
        quantityPerPackage = rounded === 0 ? null : rounded;
        values["quantityPerPackage"] = quantityPerPackage;
      }
    }

    // Leverantörsnr — an unknown supplier is a row error like every other
    // register reference (import the suppliers first).
    const supplierCell = record["primarySupplierNumber"] ?? "";
    let primarySupplierId: string | null = null;
    if (supplierCell !== "") {
      values["primarySupplierNumber"] = supplierCell;
      const supplier = suppliersByNumber.get(supplierCell);
      if (!supplier) errors.push(`Leverantören ${supplierCell} finns inte i leverantörsregistret`);
      else primarySupplierId = supplier.id;
    }

    rows.push({ rowNumber, action, errors, warnings, values });
    if (errors.length > 0) return;

    if (!existing) {
      // Empty cell on create = unset/null; type falls back to the wizard's
      // Standardtyp (defaults.articleType), then "purchased". An unmapped or
      // empty cell never produces a phantom — only an explicit Fiktiv does.
      const resolvedType = parsedType?.type ?? input.defaults?.articleType ?? "purchased";
      values["type"] = resolvedType;
      if (parsedType?.isPhantom) values["isPhantom"] = true;
      creates.push({
        articleNumber,
        name,
        type: resolvedType,
        isPhantom: parsedType?.isPhantom ?? false,
        unitCode: unitCode === "" ? null : unitCode,
        groupCode: groupCode === "" ? null : groupCode,
        articleCode: articleCode === "" || articleCode.length > ARTICLE_CODE_MAX ? null : articleCode,
        standardCost,
        weight,
        surfaceTreatment,
        colour,
        ...(extraDescription !== null ? { extraDescription } : {}),
        ...(barcode !== null ? { barcode } : {}),
        active: active ?? true,
        reorderPoint: planning.reorderPoint ?? null,
        orderQuantity: planning.orderQuantity ?? null,
        rounding: planning.rounding ?? null,
        ...(revisions ? { revisions } : {}),
        ...(quantityPerPackage != null ? { quantityPerPackage } : {}),
        ...(safetyStock != null ? { safetyStock } : {}),
        ...(stockControlled !== undefined ? { stockControlled } : {}),
        ...(primarySupplierId !== null ? { primarySupplierId } : {}),
      });
    } else {
      // Empty cell on update = leave the existing value untouched (never
      // blank a stored value from an empty CSV cell).
      const patch: ArticleUpdatePlan["patch"] = {};
      if (name !== "") patch.name = name;
      if (groupCode !== "" && GROUP_CODE_PATTERN.test(groupCode) && groupCode !== existing.groupCode) {
        patch.groupCode = groupCode;
      }
      if (articleCode !== "" && articleCode.length <= ARTICLE_CODE_MAX && articleCode !== (existing.articleCode ?? null)) {
        patch.articleCode = articleCode;
      }
      if (standardCost !== null) {
        // Same "only patch when it differs" rule as groupCode above — without
        // it, re-importing the same file every time would stage a no-op
        // patch that (with D1) writes a fresh, spurious history row on every
        // run. Doing the comparison here means executeArticlePlan doesn't
        // need to re-check: an update row's patch.standardCost being present
        // already means the value is genuinely changing.
        const existingCost = existing.standardCost !== null ? Number(existing.standardCost) : null;
        if (existingCost === null || existingCost !== standardCost) patch.standardCost = standardCost;
      }
      if (weight !== null) patch.weight = weight;
      if (surfaceTreatment !== null && surfaceTreatment !== existing.surfaceTreatment) {
        patch.surfaceTreatment = surfaceTreatment;
      }
      if (colour !== null && colour !== existing.colour) patch.colour = colour;
      if (extraDescription !== null) patch.extraDescription = extraDescription;
      if (barcode !== null && barcode !== existing.barcode) patch.barcode = barcode;
      if (active !== null) patch.active = active;
      if (planning.reorderPoint !== undefined) patch.reorderPoint = planning.reorderPoint;
      if (planning.orderQuantity !== undefined) patch.orderQuantity = planning.orderQuantity;
      if (planning.rounding !== undefined) patch.rounding = planning.rounding;
      if (quantityPerPackage !== undefined) patch.quantityPerPackage = quantityPerPackage;
      if (safetyStock !== undefined) patch.safetyStock = safetyStock;
      if (stockControlled !== undefined) patch.stockControlled = stockControlled;
      updates.push({
        id: existing.id,
        patch,
        ...(revisions ? { revisions } : {}),
        ...(primarySupplierId !== null ? { primarySupplierId } : {}),
      });
    }
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: {
      units: [...newUnits.values()],
      articleGroups: [...newGroups].sort(),
      articleCodes: [...newArticleCodes].sort(),
    },
    creates,
    updates,
    fallbackUnitId: fallback.unitId,
    fallbackLocationId: fallback.locationId,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
