// Shared import machinery: header normalization/mapping suggestion, column
// resolution and the row/summary types every entity planner produces. The
// entity-specific planners (articles.ts; customers.ts/suppliers.ts in later
// blocks) build on these; createImportService (the routes' dependency) sits
// at the bottom of this file.
import type { ImportBatchPreviewInput, ImportCommitInput, ImportEntity } from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import type { ImportRepository } from "../repository/import.repository.js";
import { parseImportFile } from "./parse-file.js";
import { detectImportEntity, importFileRank } from "./detect.js";
import { planArticleImport, suggestArticleMapping, type ArticleImportPlan } from "./articles.js";
import { planCustomerImport, suggestCustomerMapping, type CustomerImportPlan } from "./customers.js";
import { planSupplierImport, suggestSupplierMapping, type SupplierImportPlan } from "./suppliers.js";
import { planBomImport, suggestBomMapping, type BomImportPlan } from "./bom.js";
import { planRoutingImport, suggestRoutingMapping, type RoutingImportPlan } from "./routing.js";
import {
  planCustomerContactImport,
  suggestCustomerContactMapping,
  type CustomerContactImportPlan,
} from "./customer-contacts.js";
import { planWorkCenterImport, suggestWorkCenterMapping, type WorkCenterImportPlan } from "./work-centers.js";
import {
  planLegoWorkCenterImport,
  suggestLegoWorkCenterMapping,
  type LegoWorkCenterImportPlan,
} from "./lego-work-centers.js";
import {
  planProductionGroupImport,
  suggestProductionGroupMapping,
  type ProductionGroupImportPlan,
} from "./production-groups.js";
import {
  planCustomerDeliveryAddressImport,
  suggestCustomerDeliveryAddressMapping,
  type CustomerDeliveryAddressImportPlan,
} from "./customer-delivery-addresses.js";
import {
  planSupplierContactImport,
  suggestSupplierContactMapping,
  type SupplierContactImportPlan,
} from "./supplier-contacts.js";
import {
  planSupplierDeliveryAddressImport,
  suggestSupplierDeliveryAddressMapping,
  type SupplierDeliveryAddressImportPlan,
} from "./supplier-delivery-addresses.js";
import { planArticleUnitImport, suggestArticleUnitMapping, type ArticleUnitImportPlan } from "./article-units.js";
import {
  planSupplierPriceImport,
  suggestSupplierPriceMapping,
  type SupplierPriceImportPlan,
} from "./supplier-prices.js";
import {
  planCustomerPriceImport,
  suggestCustomerPriceMapping,
  type CustomerPriceImportPlan,
} from "./customer-prices.js";
import { planStockBalanceImport, suggestStockBalanceMapping, type StockBalanceImportPlan } from "./stock-balances.js";

// "skip" = the record already exists and input.skipExisting was set: the row
// is written nowhere and reported back to the user instead.
export type ImportAction = "create" | "update" | "skip";

export interface ImportRowResult {
  rowNumber: number;
  action: ImportAction;
  errors: string[];
  warnings: string[];
  values: Record<string, unknown>;
  // Only set when action === "skip". Deliberately NOT a warning: skipped rows
  // are the normal outcome of the option, and counting them in summary.warning
  // would drown the real warnings.
  skipReason?: string;
}

export interface ImportSummary {
  create: number;
  update: number;
  skip: number;
  error: number;
  warning: number;
}

// create/update/skip count only clean rows; error/warning count rows carrying
// at least one of each (a row can be counted in warning AND create).
export function summarize(rows: ImportRowResult[]): ImportSummary {
  const summary: ImportSummary = { create: 0, update: 0, skip: 0, error: 0, warning: 0 };
  for (const row of rows) {
    if (row.errors.length > 0) summary.error++;
    else if (row.action === "skip") summary.skip++;
    else if (row.action === "create") summary.create++;
    else summary.update++;
    if (row.warnings.length > 0) summary.warning++;
  }
  return summary;
}

// The row shape the commit response lists skipped rows with — enough for the
// wizard to render, save as CSV and print the list. Kept separate from
// ImportRowResult: errors/warnings are always empty on a skipped row.
export interface SkippedImportRow {
  rowNumber: number;
  reason: string;
  values: Record<string, unknown>;
}

// Builds a skipped row for the planners. The planners pass their whole
// `record` (every mapped cell, trimmed) as `values`, not the partially built
// values object — the row short-circuits before the later cells are read, and
// the saved/printed list should show the whole row, not just its key.
export function skippedRow(
  rowNumber: number,
  reason: string,
  values: Record<string, unknown>
): ImportRowResult {
  return { rowNumber, action: "skip", errors: [], warnings: [], values, skipReason: reason };
}

// The commit response's skipped list, in file order.
export function collectSkipped(rows: ImportRowResult[]): SkippedImportRow[] {
  return rows
    .filter((row) => row.action === "skip")
    .map((row) => ({ rowNumber: row.rowNumber, reason: row.skipReason ?? "", values: row.values }));
}

// A mapping the wizard could not have produced: unknown target field, the
// same field mapped twice, or a missing required column. 400 { error } —
// not a per-row error.
export class ImportMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportMappingError";
  }
}

// Any row error aborts the whole commit; the payload is the preview shape so
// the client can show exactly which rows failed. willCreate is generic
// (Record) so the customer/supplier planners can reuse the class with their
// own register keys.
export class ImportValidationError extends Error {
  constructor(
    public readonly payload: {
      rows: ImportRowResult[];
      summary: ImportSummary;
      willCreate: Record<string, string[]>;
    }
  ) {
    super("Importen innehåller fel — inget har importerats");
    this.name = "ImportValidationError";
  }
}

// Lowercase + strip diacritics/punctuation: "Benämning" -> "benamning",
// "Art.nr" -> "artnr". Both CSV headers and alias-dictionary keys normalize
// through here.
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Auto-guess: the first column whose normalized header hits `aliases` claims
// the field. A column that LOST that contest — its heading repeats an earlier
// one, or its field is already taken — gets a second chance in `secondary`,
// which exists because Monitor G5's Materiallista names the parent and the
// component with the SAME headings ("Artikelnummer", "Artikelbenämning") and
// lists the parent first.
//
// A heading that never contested anything (no primary alias, first occurrence)
// stays unmapped, so `secondary` can never claim a column the primary
// dictionary deliberately ignores — the FIRST "Artikelbenämning" is the
// parent's name and must stay out of the mapping.
//
// Passing no `secondary` reproduces the old behaviour exactly, which is what
// the article/customer/supplier/routing imports do: every second-chance branch
// yields null with an empty dictionary, and the added guards only ever move a
// column from "mapped" to "unmapped" for a heading that repeats — which the
// old `taken` check already caught whenever the first occurrence won.
//
// `preferred` runs a FIRST pass, before the alias contest, and exists for the
// opposite ordering problem: Monitor G5's Postadress export lists a generic
// "Namn" column BEFORE the specific "Postadress – Namn" one, and both would
// normally alias to the same field ("name") — the generic column would win
// simply by coming first. A header whose normalized key is in `preferred`
// claims its field unconditionally in the first pass, so `taken`/`seenKeys`
// already hold that field by the time the main loop reaches the generic
// column, which then loses the (now-lost) contest and maps to null (or its
// `secondary` fallback) instead. Passing no `preferred` reproduces the old
// behaviour exactly, like `secondary` above.
export function suggestMapping(
  headers: string[],
  aliases: Record<string, string>,
  secondary: Record<string, string> = {},
  preferred: Record<string, string> = {}
): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const taken = new Set<string>();
  const seenKeys = new Set<string>();

  // Pass 1 only pre-claims `taken`/`seenKeys` for every header a `preferred`
  // entry applies to — nothing is written into `mapping` here. That matters:
  // JSON objects preserve insertion order, and every caller (resolveColumns,
  // the wizard) zips mapping keys to row columns POSITIONALLY by that order.
  // Writing "Postadress – Namn" into `mapping` here, ahead of an earlier
  // "Kund" column, would silently reorder the mapping the wizard hands back.
  const preferredField = new Map<string, string>();
  for (const header of headers) {
    const key = normalizeHeader(header.replace(/ \(\d+\)$/, ""));
    const field = preferred[key];
    if (field !== undefined && !taken.has(field)) {
      preferredField.set(header, field);
      taken.add(field);
      seenKeys.add(key);
    }
  }

  // Pass 2 runs in header order — this is what keeps `mapping`'s key order
  // matching `headers`. A header pre-claimed above just replays its field;
  // everything else runs the normal alias contest, which by now already
  // sees the pre-claimed fields as `taken`.
  for (const header of headers) {
    const already = preferredField.get(header);
    if (already !== undefined) {
      mapping[header] = already;
      continue;
    }
    // parse() renames a repeated header to "Namn (2)" so the mapping can
    // address every column — strip that suffix before the alias lookup, or the
    // second occurrence would not recognize its own heading.
    const key = normalizeHeader(header.replace(/ \(\d+\)$/, ""));
    const primary = aliases[key] ?? null;
    const lostTheContest = seenKeys.has(key) || (primary !== null && taken.has(primary));
    let field: string | null = null;
    if (primary !== null && !lostTheContest) {
      field = primary;
    } else if (lostTheContest) {
      const fallback = secondary[key] ?? null;
      if (fallback !== null && !taken.has(fallback)) field = fallback;
    }
    mapping[header] = field;
    if (field !== null) taken.add(field);
    seenKeys.add(key);
  }
  return mapping;
}

// A header JavaScript would not keep in insertion order as an object key: a
// canonical array index ("2025", "0") is enumerated FIRST, in numeric order,
// whatever its column — the mapping's key order IS the column order, so such
// a header shifted every column after it ("Kundnummer;Namn;2025" read the
// name as the customer number). "__proto__" is no own key at all.
export function isUnorderedHeaderKey(header: string): boolean {
  return (/^(0|[1-9]\d*)$/.test(header) && Number(header) < 4294967295) || header === "__proto__";
}

// The headers the mapping is keyed by: a repeated header gets " (2)", " (3)"
// … — never one the file already has ("Namn", "Namn (2)", "Namn" gives
// "Namn (3)" for the last, not a second "Namn (2)" that would swallow a
// column) — and a header that would not keep its place as an object key
// (isUnorderedHeaderKey) is named after its column instead.
export function uniqueHeaders(raw: string[]): string[] {
  const used = new Set<string>();
  return raw.map((header, index) => {
    let name = isUnorderedHeaderKey(header) ? `${header} (kolumn ${index + 1})` : header;
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name} (${n})`) || raw.includes(`${name} (${n})`)) n++;
      name = `${name} (${n})`;
    }
    used.add(name);
    return name;
  });
}

// Column i of every row belongs to key i of the mapping (JSON objects
// preserve key order — the wizard builds the mapping from the parse
// response's headers in order, and parse renames the headers that would not
// keep it, see uniqueHeaders). Returns the target field per column.
export function resolveColumns(
  mapping: Record<string, string | null>,
  allowedFields: string[],
  requiredFields: string[]
): (string | null)[] {
  // A caller that built the mapping from its own headers: refuse rather than
  // read the wrong columns.
  const unordered = Object.keys(mapping).find(isUnorderedHeaderKey);
  if (unordered !== undefined) {
    throw new ImportMappingError(
      `Kolumnrubriken "${unordered}" är ett heltal och kan inte användas som nyckel i mappningen — byt rubrik eller använd rubrikerna som filtolkningen returnerar`
    );
  }
  const columns = Object.values(mapping);
  const seen = new Set<string>();
  for (const field of columns) {
    if (field === null) continue;
    if (!allowedFields.includes(field)) throw new ImportMappingError(`Okänt fält: ${field}`);
    if (seen.has(field)) throw new ImportMappingError(`Fältet ${field} är mappat mot två kolumner`);
    seen.add(field);
  }
  for (const required of requiredFields) {
    if (!seen.has(required)) throw new ImportMappingError(`En kolumn måste mappas mot ${required}`);
  }
  return columns;
}

// A number that was free at plan time but taken by a concurrent manual
// create — the transaction has already rolled back when this surfaces.
export class ImportConflictError extends Error {
  constructor() {
    super("En post med samma nummer skapades samtidigt av någon annan — försök igen");
    this.name = "ImportConflictError";
  }
}

// units.name and article_groups.name are UNIQUE, and the register step creates
// them as { code, name: code }. A register row that already carries the same
// NAME under a different code makes onConflictDoNothing swallow the insert, and
// the code -> id lookup then comes up empty. Surfacing that as a named error
// beats a NOT NULL violation from a non-null assertion.
export class ImportRegisterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRegisterConflictError";
  }
}

export interface ImportServiceOptions {
  // Runs fn against a repository bound to a transaction that is ALWAYS
  // rolled back — the multi-file preview executes every file for real so
  // the next one sees its result, and nothing is kept. Wired in app.ts.
  dryRun?: <T>(fn: (repo: ImportRepository) => Promise<T>) => Promise<T>;
}

// One file's outcome in the batch preview, in request order. `blocked` =
// not previewed, because an earlier file has errors: its rows were never
// executed, so every later file would show follow-on errors ("Kunden …
// finns inte") instead of its own.
export type ImportBatchPreviewFile =
  | { status: "previewed"; rows: ImportRowResult[]; summary: ImportSummary; willCreate: Record<string, string[]> }
  | { status: "failed"; error: string; rows?: ImportRowResult[]; summary?: ImportSummary; willCreate?: Record<string, string[]> }
  | { status: "blocked" };

export function createImportService(repo: ImportRepository, options: ImportServiceOptions = {}) {
  // Per-entity dispatch: the customer/supplier importers add cases to these
  // switches and widen importEntitySchema — the routes file stays untouched.
  function suggest(entity: ImportEntity, headers: string[]): Record<string, string | null> {
    switch (entity) {
      case "articles":
        return suggestArticleMapping(headers);
      case "customers":
        return suggestCustomerMapping(headers);
      case "suppliers":
        return suggestSupplierMapping(headers);
      case "bom":
        return suggestBomMapping(headers);
      case "routing":
        return suggestRoutingMapping(headers);
      case "customerContacts":
        return suggestCustomerContactMapping(headers);
      case "customerDeliveryAddresses":
        return suggestCustomerDeliveryAddressMapping(headers);
      case "supplierContacts":
        return suggestSupplierContactMapping(headers);
      case "supplierDeliveryAddresses":
        return suggestSupplierDeliveryAddressMapping(headers);
      case "workCenters":
        return suggestWorkCenterMapping(headers);
      case "legoWorkCenters":
        return suggestLegoWorkCenterMapping(headers);
      case "productionGroups":
        return suggestProductionGroupMapping(headers);
      case "articleUnits":
        return suggestArticleUnitMapping(headers);
      case "supplierPrices":
        return suggestSupplierPriceMapping(headers);
      case "customerPrices":
        return suggestCustomerPriceMapping(headers);
      case "stockBalances":
        return suggestStockBalanceMapping(headers);
    }
  }

  async function buildPlan(
    r: ImportRepository,
    entity: ImportEntity,
    input: ImportCommitInput
  ): Promise<
    | ArticleImportPlan
    | CustomerImportPlan
    | SupplierImportPlan
    | BomImportPlan
    | RoutingImportPlan
    | CustomerContactImportPlan
    | CustomerDeliveryAddressImportPlan
    | SupplierContactImportPlan
    | SupplierDeliveryAddressImportPlan
    | WorkCenterImportPlan
    | LegoWorkCenterImportPlan
    | ProductionGroupImportPlan
    | ArticleUnitImportPlan
    | SupplierPriceImportPlan
    | CustomerPriceImportPlan
    | StockBalanceImportPlan
  > {
    switch (entity) {
      case "articles":
        // The repository implements ArticleImportDeps structurally.
        return planArticleImport(input, r);
      case "customers":
        // The repository implements CustomerImportDeps structurally.
        return planCustomerImport(input, r);
      case "suppliers":
        // The repository implements SupplierImportDeps structurally.
        return planSupplierImport(input, r);
      case "bom":
        // The repository implements BomImportDeps structurally.
        return planBomImport(input, r);
      case "routing":
        // The repository implements RoutingImportDeps structurally.
        return planRoutingImport(input, r);
      case "customerContacts":
        // The repository implements CustomerContactImportDeps structurally.
        return planCustomerContactImport(input, r);
      case "customerDeliveryAddresses":
        // The repository implements CustomerDeliveryAddressImportDeps structurally.
        return planCustomerDeliveryAddressImport(input, r);
      case "supplierContacts":
        // The repository implements SupplierContactImportDeps structurally.
        return planSupplierContactImport(input, r);
      case "supplierDeliveryAddresses":
        // The repository implements SupplierDeliveryAddressImportDeps structurally.
        return planSupplierDeliveryAddressImport(input, r);
      case "workCenters":
        // The repository implements WorkCenterImportDeps structurally.
        return planWorkCenterImport(input, r);
      case "legoWorkCenters":
        return planLegoWorkCenterImport(input, r);
      case "productionGroups":
        return planProductionGroupImport(input, r);
      case "articleUnits":
        return planArticleUnitImport(input, r);
      case "supplierPrices":
        return planSupplierPriceImport(input, r);
      case "customerPrices":
        return planCustomerPriceImport(input, r);
      case "stockBalances":
        return planStockBalanceImport(input, r);
    }
  }

  // The casts are safe — buildPlan's switch correlates entity to plan type,
  // which TypeScript cannot track across the function boundary.
  function executePlan(
    r: ImportRepository,
    entity: ImportEntity,
    plan: Awaited<ReturnType<typeof buildPlan>>
  ): Promise<{
    created: number;
    updated: number;
    // `articles` is optional so the other imports that create no articles as
    // a side register keep returning their object literals unchanged; only
    // the bom import fills it (the article import's own articles are
    // `created`). The four term/carrier/price-list keys are optional the
    // same way — only the customer/supplier imports' executeCustomerPlan/
    // executeSupplierPlan fill them (suppliers: no price list).
    registersCreated: {
      units: string[];
      articleGroups: string[];
      // Artikelkoder — only the article import fills it.
      articleCodes?: string[];
      articles?: string[];
      paymentTerms?: string[];
      deliveryTerms?: string[];
      carriers?: string[];
      priceLists?: string[];
      // Avdelningar created on the fly by the resource import.
      productionGroups?: string[];
      // Lager and lagerplatser created by the stock balance import.
      warehouses?: string[];
      stockLocations?: string[];
    };
  }> {
    switch (entity) {
      case "articles":
        return r.executeArticlePlan(plan as ArticleImportPlan);
      case "customers":
        return r.executeCustomerPlan(plan as CustomerImportPlan);
      case "suppliers":
        return r.executeSupplierPlan(plan as SupplierImportPlan);
      case "bom":
        return r.executeBomPlan(plan as BomImportPlan);
      case "routing":
        return r.executeRoutingPlan(plan as RoutingImportPlan);
      case "customerContacts":
        return r.executeCustomerContactPlan(plan as CustomerContactImportPlan);
      case "customerDeliveryAddresses":
        return r.executeCustomerDeliveryAddressPlan(plan as CustomerDeliveryAddressImportPlan);
      case "supplierContacts":
        return r.executeSupplierContactPlan(plan as SupplierContactImportPlan);
      case "supplierDeliveryAddresses":
        return r.executeSupplierDeliveryAddressPlan(plan as SupplierDeliveryAddressImportPlan);
      case "workCenters":
        return r.executeWorkCenterPlan(plan as WorkCenterImportPlan);
      case "legoWorkCenters":
        return r.executeLegoWorkCenterPlan(plan as LegoWorkCenterImportPlan);
      case "productionGroups":
        return r.executeProductionGroupPlan(plan as ProductionGroupImportPlan);
      case "articleUnits":
        return r.executeArticleUnitPlan(plan as ArticleUnitImportPlan);
      case "supplierPrices":
        return r.executeSupplierPricePlan(plan as SupplierPriceImportPlan);
      case "customerPrices":
        return r.executeCustomerPricePlan(plan as CustomerPriceImportPlan);
      case "stockBalances":
        return r.executeStockBalancePlan(plan as StockBalanceImportPlan);
    }
  }

  // CSV or .xlsx — parseImportFile sniffs the content and picks. Duplicate
  // header names get a numeric suffix so the mapping (keyed by header) can
  // address every column unambiguously. Shared by parse() and detect().
  async function parseWithUniqueHeaders(file: Buffer) {
    const parsed = await parseImportFile(file);
    return {
      headers: uniqueHeaders(parsed.headers),
      rows: parsed.rows,
      meta: {
        format: parsed.format,
        delimiter: parsed.delimiter,
        encoding: parsed.encoding,
        sheetName: parsed.sheetName,
        sheetCount: parsed.sheetCount,
        rowCount: parsed.rows.length,
      },
    };
  }

  return {
    async parse(entity: ImportEntity, file: Buffer) {
      const parsed = await parseWithUniqueHeaders(file);
      // orderRank too: the multi-file wizard re-parses a file whose type the
      // user changes by hand, and an address file must keep running after
      // Lista/Övrigt (importFileRank).
      return {
        ...parsed,
        orderRank: importFileRank(entity, parsed.headers),
        suggestedMapping: suggest(entity, parsed.headers),
      };
    },

    // The multi-file import's first step: parse without knowing the entity,
    // recognise it from the header row (detect.ts) and suggest that entity's
    // mapping. detectedEntity null = no signature matched — the wizard shows
    // the file as unknown and lets the user pick an entity by hand (which
    // re-parses through parse()).
    async detect(file: Buffer) {
      const parsed = await parseWithUniqueHeaders(file);
      const detectedEntity = detectImportEntity(parsed.headers);
      const orderRank = detectedEntity ? importFileRank(detectedEntity, parsed.headers) : 0;
      return {
        ...parsed,
        detectedEntity,
        orderRank,
        suggestedMapping: detectedEntity ? suggest(detectedEntity, parsed.headers) : {},
      };
    },

    async preview(entity: ImportEntity, input: ImportCommitInput) {
      const plan = await buildPlan(repo, entity, input);
      return { rows: plan.rows, summary: plan.summary, willCreate: plan.willCreate };
    },

    // The multi-file wizard's preview: plan AND execute every file in the
    // order given, inside one transaction that is always rolled back, so
    // each file is previewed against what the earlier ones leave behind —
    // exactly what the per-file commits will then meet. A file with errors
    // is not executed and blocks the rest (see ImportBatchPreviewFile).
    async previewBatch(files: ImportBatchPreviewInput["files"]): Promise<{ files: ImportBatchPreviewFile[] }> {
      const dryRun = options.dryRun;
      if (!dryRun) throw new Error("previewBatch needs the dryRun option");
      const results = await dryRun(async (txRepo) => {
        const out: ImportBatchPreviewFile[] = [];
        let blocked = false;
        for (const { entity, ...input } of files) {
          if (blocked) {
            out.push({ status: "blocked" });
            continue;
          }
          try {
            const plan = await buildPlan(txRepo, entity, input);
            const preview = { rows: plan.rows, summary: plan.summary, willCreate: plan.willCreate };
            if (plan.hasErrors) {
              const n = plan.summary.error;
              const error = `Filen har fel på ${n} ${n === 1 ? "rad" : "rader"} — rätta filen eller hoppa över den`;
              out.push({ status: "failed", error, ...preview });
              blocked = true;
              continue;
            }
            await executePlan(txRepo, entity, plan);
            out.push({ status: "previewed", ...preview });
          } catch (err) {
            // Only the errors commit() turns into a 4xx — anything else is a
            // bug and fails the request. The execute ran in its own savepoint
            // (a nested transaction), but the later files are blocked all the
            // same: they would be previewed without this file's rows.
            const message =
              err instanceof ImportMappingError || err instanceof ImportRegisterConflictError
                ? err.message
                : isUniqueViolation(err)
                  ? new ImportConflictError().message
                  : null;
            if (message === null) throw err;
            out.push({ status: "failed", error: message });
            blocked = true;
          }
        }
        return out;
      });
      return { files: results };
    },

    // Re-plans from scratch — the preview round-trip is never trusted — and
    // executes atomically: ANY row error aborts with the preview payload,
    // warnings never block.
    async commit(entity: ImportEntity, input: ImportCommitInput) {
      const plan = await buildPlan(repo, entity, input);
      if (plan.hasErrors) {
        throw new ImportValidationError({
          rows: plan.rows,
          summary: plan.summary,
          willCreate: plan.willCreate,
        });
      }
      try {
        const result = await executePlan(repo, entity, plan);
        // The skipped rows are the plan's, not the repository's — nothing was
        // written for them, so the repository never sees them. The WHOLE list
        // rides along uncapped: saving or printing it is the point of the
        // option, and `rows` is already capped at 10 000.
        return { ...result, skipped: plan.summary.skip, skippedRows: collectSkipped(plan.rows) };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ImportConflictError();
        throw err;
      }
    },
  };
}

export type ImportService = ReturnType<typeof createImportService>;
