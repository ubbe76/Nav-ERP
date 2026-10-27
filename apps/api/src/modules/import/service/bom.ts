// BOM import (artikelstruktur — TODO2 #15). Sibling of routing.ts: the
// entity-specific planner lives here and builds on the shared machinery in
// import.service.ts; all database work lives in import.repository.ts.
//
// CREATE-ONLY by default, like the routing import: a component that is
// already in the structure is a row error, not an update — or a SKIP, with
// input.skipExisting. With input.updateExisting (opt-in, mutually exclusive
// with skipExisting) the existing row is rewritten: antal and enhet always,
// the operation link when the column is mapped, Pos. when the cell is filled.
import type { ArticleType, ImportCommitInput } from "@navet/shared";
import { toBaseQuantity } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
import type { ExistingArticle, ParsedArticleType } from "./articles.js";
import { parseArticleType } from "./articles.js";
import { findCyclicRows, type BomEdge } from "./bom-cycle.js";
import {
  ImportMappingError,
  normalizeHeader,
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them. articleNumber
// is the PARENT — named like the other entities so the wizard's keyField
// (the first required field) lands on something meaningful.
export const BOM_IMPORT_FIELDS = [
  "articleNumber",
  "componentNumber",
  "quantity",
  "unitCode",
  "operationSequenceNo",
  // "Pos." — the row's position on the drawing.
  "position",
  // Read ONLY for components missing from the article register, and ONLY with
  // input.createMissingArticles. An existing article is never touched by this
  // import — not even when the file disagrees with it.
  "componentName",
  "componentType",
  "componentStandardCost",
] as const;
export type BomImportField = (typeof BOM_IMPORT_FIELDS)[number];

const REQUIRED_FIELDS: BomImportField[] = ["articleNumber", "componentNumber", "quantity"];

// What a created component gets when its row names no unit — the same "st"
// resolveDefaults falls back to. Named here so a later row that DOES spell out
// "st" is recognised as the same base unit rather than a conflicting one.
const FALLBACK_UNIT_CODE = "st";

// Normalized header -> target field (see import.service.ts's normalizeHeader:
// "Ingående artikel" -> "ingaendeartikel", "Åtgång" -> "atgang").
export const BOM_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  huvudartikel: "articleNumber",
  huvudartikelnummer: "articleNumber",
  moderartikel: "articleNumber",
  overordnadartikel: "articleNumber",
  tillverkadartikel: "articleNumber",
  komponentnummer: "componentNumber",
  komponentnr: "componentNumber",
  komponent: "componentNumber",
  komponentartikelnummer: "componentNumber",
  ingaendeartikel: "componentNumber",
  ingaendeartikelnummer: "componentNumber",
  underartikel: "componentNumber",
  materialartikel: "componentNumber",
  delartikelnummer: "componentNumber",
  antal: "quantity",
  kvantitet: "quantity",
  mangd: "quantity",
  atgang: "quantity",
  strukturantal: "quantity",
  antalperenhet: "quantity",
  antalperstyck: "quantity",
  enhet: "unitCode",
  enhetskod: "unitCode",
  operation: "operationSequenceNo",
  operationsnr: "operationSequenceNo",
  operationsnummer: "operationSequenceNo",
  opnr: "operationSequenceNo",
  arbetsmoment: "operationSequenceNo",
  tilloperation: "operationSequenceNo",
  // Monitor's Materiallista heads it "Pos." (normalizeHeader drops the dot).
  pos: "position",
  position: "position",
  positionsnummer: "position",
  posnr: "position",
  komponentbenamning: "componentName",
  komponentnamn: "componentName",
  komponentensbenamning: "componentName",
  artikeltyp: "componentType",
  komponenttyp: "componentType",
  typ: "componentType",
  standardpris: "componentStandardCost",
  standardkostnad: "componentStandardCost",
  sjalvkostnad: "componentStandardCost",
  // The Excel template's heading (field-help.ts).
  komponentensstandardpris: "componentStandardCost",
};

// Second chance (see suggestMapping): a header that repeats, or whose field an
// earlier column already claimed, means the COMPONENT in Monitor G5's
// Materiallista — the file carries "Huvudartikel" plus "Artikelnummer", and
// "Artikelbenämning" twice (parent first, component second).
//
// "artikelbenamning"/"benamning" are deliberately NOT primary aliases: the
// FIRST such column is the parent's name, which this import does not store.
export const BOM_SECONDARY_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "componentNumber",
  artikelnr: "componentNumber",
  artnr: "componentNumber",
  artikelbenamning: "componentName",
  benamning: "componentName",
};

export function suggestBomMapping(headers: string[]): Record<string, string | null> {
  const mapping = suggestMapping(headers, BOM_HEADER_ALIASES, BOM_SECONDARY_HEADER_ALIASES);

  // The secondary dictionary only ever fires for a column that LOST a
  // contest, so a file with a SINGLE "Artikelbenämning" — no repeat, no
  // primary alias — leaves componentName unmapped, and every row then fails
  // with "Benämning saknas för den nya komponenten". That is the wrong
  // outcome for a plain structure file, where the one name column IS the
  // component's; Monitor's Materiallista is untouched by this rule because it
  // carries TWO such columns and the secondary dictionary has already claimed
  // the second one. Ambiguity is refused rather than guessed: two or more
  // candidates and the rule stays silent.
  if (!Object.values(mapping).includes("componentName")) {
    const candidates = headers.filter(
      (header) =>
        BOM_SECONDARY_HEADER_ALIASES[normalizeHeader(header.replace(/ \(\d+\)$/, ""))] === "componentName"
    );
    const sole = candidates[0];
    if (candidates.length === 1 && sole !== undefined && mapping[sole] === null) {
      mapping[sole] = "componentName";
    }
  }

  return mapping;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface BomImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  /** Keyed by LOWERCASED code — units.code is case-sensitive in the DB. */
  unitsByCode(): Promise<Map<string, { id: string; code: string }>>;
  /** articleId -> unitId -> quantity_per_base, for the article's alternative units. */
  articleUnitFactors(articleIds: string[]): Promise<Map<string, Map<string, number>>>;
  routingOperationsByArticle(
    articleIds: string[]
  ): Promise<Map<string, Map<number, { id: string; costingOnly: boolean }>>>;
  allBomEdges(): Promise<BomEdge[]>;
  /**
   * The same fallbacks createArticle uses ("st" + the "***" location). Called
   * ONLY when createMissingArticles is set — resolveDefaults CREATES those two
   * registers on first use, and a plain structure preview must not have that
   * side effect.
   */
  resolveDefaults(): Promise<{ unitId: string; locationId: string }>;
}

/** A component missing from the article register, created by the same import. */
export interface BomArticleCreatePlan {
  articleNumber: string;
  name: string;
  type: ArticleType;
  /** Monitor's FIKTIV — a manufactured article that resolves to its components. */
  isPhantom: boolean;
  /** null = the fallback unit "st". Becomes the article's BASE unit. */
  unitCode: string | null;
  standardCost: number | null;
}

export interface BomCreatePlan {
  parentArticleId: string;
  /**
   * null = the component is created by this same import; executeBomPlan then
   * resolves it by componentNumber INSIDE the transaction, after the articles
   * have been written.
   */
  componentArticleId: string | null;
  /** Always set — the key for the lookup above. */
  componentNumber: string;
  /** ALWAYS in the component's base unit, like bom_components.quantity. */
  quantity: number;
  /** Display unit; null = the component's base unit. */
  unitId: string | null;
  /** Snapshot of article_units.quantity_per_base at import time. */
  unitFactor: number | null;
  routingOperationId: string | null;
  /** "Pos." — null when the cell is empty. */
  position?: string | null;
}

// An existing structure row rewritten under input.updateExisting. Antal and
// enhet are always set (the quantity column is required); the operation link
// only when its column is mapped (an empty cell then unlinks); Pos. only
// from a filled cell — an empty one never blanks a stored value.
export interface BomUpdatePlan {
  id: string;
  patch: {
    quantity: number;
    unitId: string | null;
    unitFactor: number | null;
    routingOperationId?: string | null;
    position?: string;
  };
}

export interface BomImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // units/articles fill up only with createMissingArticles; articleGroups is
  // always empty (a structure file carries no article group — Monitor's "Pgrp"
  // is the receiving OPERATION's production group, not the component's).
  willCreate: { units: string[]; articleGroups: string[]; articles: string[] };
  creates: BomCreatePlan[];
  /** Optional so hand-built plans in tests need not carry it. */
  updates?: BomUpdatePlan[];
  /** Written BEFORE creates, in the same transaction. */
  articleCreates: BomArticleCreatePlan[];
  /** Resolved only when articleCreates is non-empty. */
  fallbackUnitId: string | null;
  fallbackLocationId: string | null;
  hasErrors: boolean;
}

export async function planBomImport(input: ImportCommitInput, deps: BomImportDeps): Promise<BomImportPlan> {
  // Not a per-row error: the two options contradict each other for EVERY
  // existing row (same rule as the routing import).
  if (input.skipExisting && input.updateExisting) {
    throw new ImportMappingError(
      "Välj antingen Hoppa över rader som redan finns eller Uppdatera befintliga strukturrader, inte båda"
    );
  }
  const columns = resolveColumns(input.mapping, [...BOM_IMPORT_FIELDS], REQUIRED_FIELDS);
  const operationMapped = columns.includes("operationSequenceNo");

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = [
    ...records.map((r) => r["articleNumber"] ?? ""),
    ...records.map((r) => r["componentNumber"] ?? ""),
  ].filter((n) => n !== "");
  const articlesByNumber = await deps.articlesByNumber(numbers);

  const componentIds = records
    .map((r) => articlesByNumber.get(r["componentNumber"] ?? "")?.id)
    .filter((id): id is string => id !== undefined);
  const parentIds = records
    .map((r) => articlesByNumber.get(r["articleNumber"] ?? "")?.id)
    .filter((id): id is string => id !== undefined);

  const unitFactors = await deps.articleUnitFactors(componentIds);
  const existingOperations = await deps.routingOperationsByArticle(parentIds);
  const unitsByCode = await deps.unitsByCode();
  const existingEdges = await deps.allBomEdges();

  // The same query answers both questions: which (parent, component) pairs
  // already exist, and what the graph looks like for the cycle check.
  const existingPairs = new Map<string, string>(existingEdges.map((e) => [`${e.parentId}#${e.componentId}`, e.id ?? ""]));

  // resolveDefaults() creates the "st" unit and the "***" location on first
  // use, so it is called only when the flag is actually on.
  const createMissing = input.createMissingArticles === true;
  const fallback = createMissing ? await deps.resolveDefaults() : null;

  const rows: ImportRowResult[] = [];
  // Parallel to `rows` — the create is staged here and only harvested after
  // the cycle pass, which may still invalidate a row.
  const staged: (BomCreatePlan | null)[] = [];
  const updates: BomUpdatePlan[] = [];
  const seen = new Set<string>();
  // articleNumber -> the article staged for creation. The FIRST row that names
  // a missing component defines it; later rows may only warn about a
  // divergence. Rows with errors contribute too: the import is all-or-nothing,
  // so executeBomPlan only ever runs on an error-free plan, and the preview
  // SHOULD show what would be created.
  const pendingArticles = new Map<string, BomArticleCreatePlan>();
  // Lowercased code -> the first spelling seen, exactly like the article
  // import's newUnits.
  const newUnits = new Map<string, string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};
    // Set when the row rewrites an existing structure row (updateExisting).
    let existingRowId: string | null = null;

    const articleNumber = record["articleNumber"] ?? "";
    values["articleNumber"] = articleNumber;
    const parent = articlesByNumber.get(articleNumber);
    if (articleNumber === "") {
      errors.push("Artikelnummer saknas");
    } else if (!parent) {
      errors.push(`Artikeln ${articleNumber} finns inte i artikelregistret`);
    } else if (parent.type !== "manufactured" && !parent.isPhantom) {
      warnings.push(`Artikeln ${articleNumber} är inte tillverkad — strukturen används inte vid tillverkning`);
    }

    const componentNumber = record["componentNumber"] ?? "";
    values["componentNumber"] = componentNumber;
    const component = articlesByNumber.get(componentNumber);
    if (componentNumber === "") {
      errors.push("Komponentnummer saknas");
    } else if (!component) {
      // With createMissingArticles the row is validated and staged further
      // down instead; the parent is never created that way — the file carries
      // neither type nor unit for it.
      if (!createMissing) errors.push(`Komponenten ${componentNumber} finns inte i artikelregistret`);
    } else if (parent && component.id === parent.id) {
      // Mirrors the DB check constraint no_self_reference.
      errors.push("En artikel kan inte ingå i sin egen struktur");
    }

    if (parent && component && component.id !== parent.id) {
      // The uniqueness is (parent, component) — NOT (parent, component,
      // operation). The same component cannot sit on a parent twice even at
      // different operations.
      const key = `${parent.id}#${component.id}`;
      if (existingPairs.has(key)) {
        if (input.skipExisting) {
          // Short-circuit: nothing is written for this row, so the remaining
          // cells (antal, enhet, operation) are not validated — a bad cell on
          // a row we are not importing must not block the file. `seen` is
          // still recorded, but the in-file duplicate stays silent here: with
          // the pair already in the structure BOTH rows are skipped and no
          // conflict is possible. staged gets its null so the two arrays stay
          // parallel for the cycle pass below; the edge is already in
          // existingEdges, so the graph is unchanged either way.
          seen.add(key);
          rows.push(
            skippedRow(
              rowNumber,
              `Komponenten ${componentNumber} finns redan i strukturen för ${articleNumber}`,
              { ...record }
            )
          );
          staged.push(null);
          return;
        }
        if (input.updateExisting) {
          existingRowId = existingPairs.get(key) || null;
        } else {
          errors.push(
            `Komponenten ${componentNumber} finns redan i strukturen för ${articleNumber} — ta bort raden ur filen`
          );
        }
      }
      if (seen.has(key)) {
        errors.push(`Komponenten ${componentNumber} för artikel ${articleNumber} förekommer flera gånger i filen`);
      }
      seen.add(key);
    }

    // Echoed for every row, mapped or not, so the preview payload has the same
    // shape whether or not the component turned out to be missing.
    if ("componentName" in record) values["componentName"] = record["componentName"];
    if ("componentType" in record) values["componentType"] = record["componentType"];
    if ("componentStandardCost" in record) {
      values["componentStandardCost"] = record["componentStandardCost"];
    }

    // Staged AFTER the skipExisting short-circuit above (a skipped row must
    // never stage an article) and BEFORE the unit branch below, which needs to
    // know the new article's base unit.
    let pending: BomArticleCreatePlan | null = null;
    if (createMissing && componentNumber !== "" && !component) {
      const nameCell = record["componentName"] ?? "";
      const typeCell = record["componentType"] ?? "";
      const costCell = record["componentStandardCost"] ?? "";
      const rawComponentUnit = record["unitCode"] ?? "";

      // Mirrors the varchar lengths on articles.article_number/name.
      if (componentNumber.length > 50) {
        errors.push(`Artikelnumret ${componentNumber} är för långt (max 50 tecken)`);
      }
      if (nameCell === "") {
        errors.push(`Benämning saknas för den nya komponenten ${componentNumber}`);
      } else if (nameCell.length > 255) {
        errors.push(`Benämningen för ${componentNumber} är för lång (max 255 tecken)`);
      }

      let parsedType: ParsedArticleType | null = null;
      if (typeCell !== "") {
        parsedType = parseArticleType(typeCell);
        if (parsedType === null) errors.push(`Okänd artikeltyp: "${typeCell}"`);
      }
      // Unmapped column or empty cell -> the wizard's Standardtyp, then köpt:
      // a component the structure file did not classify is nearly always
      // bought material.
      const resolvedType: ArticleType = parsedType?.type ?? input.defaults?.articleType ?? "purchased";

      let cost: number | null = null;
      if (costCell !== "") {
        cost = normalizeDecimal(costCell);
        if (cost === null) errors.push(`Ogiltigt standardpris: "${costCell}"`);
        else if (cost < 0) {
          errors.push(`Standardpriset för ${componentNumber} kan inte vara negativt`);
          cost = null;
        }
      }
      if (rawComponentUnit.length > 20) {
        errors.push(`Enhetskoden ${rawComponentUnit} är för lång (max 20 tecken)`);
      }

      const already = pendingArticles.get(componentNumber);
      if (already) {
        pending = already;
        // First occurrence wins; a divergence only warns. The unit is the
        // exception and is handled as an ERROR by the unit branch below — a
        // new article can have exactly one base unit.
        if (nameCell !== "" && nameCell !== pending.name) {
          warnings.push(
            `Benämningen för ${componentNumber} avviker från en tidigare rad — "${pending.name}" används`
          );
        }
        if (
          parsedType !== null &&
          (parsedType.type !== pending.type || parsedType.isPhantom !== pending.isPhantom)
        ) {
          warnings.push(`Artikeltypen för ${componentNumber} avviker från en tidigare rad`);
        }
        if (cost !== null && cost !== pending.standardCost) {
          warnings.push(`Standardpriset för ${componentNumber} avviker från en tidigare rad`);
        }
      } else {
        pending = {
          articleNumber: componentNumber,
          name: nameCell,
          type: resolvedType,
          isPhantom: parsedType?.isPhantom ?? false,
          unitCode: rawComponentUnit === "" ? null : rawComponentUnit,
          standardCost: cost,
        };
        pendingArticles.set(componentNumber, pending);
        warnings.push(`Komponenten ${componentNumber} finns inte och skapas som ny artikel`);
        // The unit has to be created too — exactly what the article import does.
        const unitKey = rawComponentUnit.toLowerCase();
        if (
          rawComponentUnit !== "" &&
          rawComponentUnit.length <= 20 &&
          !unitsByCode.has(unitKey) &&
          !newUnits.has(unitKey)
        ) {
          newUnits.set(unitKey, rawComponentUnit);
        }
      }
    }

    // The in-file duplicate check above only covers components that already
    // exist — it keys on their ids. A component this import creates has no id
    // yet, so the same (parent, new component) twice would slip through to the
    // (parent_article_id, component_article_id) unique index and surface as a
    // 409 instead of a row error. Same synthetic key as the cycle pass.
    if (parent && pending) {
      const pendingKey = `${parent.id}#new:${componentNumber}`;
      if (seen.has(pendingKey)) {
        errors.push(`Komponenten ${componentNumber} för artikel ${articleNumber} förekommer flera gånger i filen`);
      }
      seen.add(pendingKey);
    }

    const rawQuantity = record["quantity"] ?? "";
    values["quantity"] = rawQuantity;
    let quantity: number | null = null;
    if (rawQuantity === "") {
      errors.push("Antal saknas");
    } else {
      const parsed = normalizeDecimal(rawQuantity);
      if (parsed === null) errors.push(`Ogiltigt antal: "${rawQuantity}"`);
      // Mirrors createBomComponentSchema's positive().
      else if (parsed <= 0) errors.push("Antalet måste vara större än 0");
      else quantity = parsed;
    }

    // The unit resolves against the COMPONENT's units, not the parent's —
    // the same rule as addBomComponent's resolveUnitSelection.
    const rawUnit = record["unitCode"] ?? "";
    values["unitCode"] = rawUnit;
    let unitId: string | null = null;
    let unitFactor: number | null = null;
    if (rawUnit !== "" && pending) {
      // A new article's BASE unit is whatever the first row naming it said.
      // A later row with a different unit is the same error as for an existing
      // component — the new article has no alternative units.
      if ((pending.unitCode ?? FALLBACK_UNIT_CODE).toLowerCase() !== rawUnit.toLowerCase()) {
        errors.push(
          `Enheten ${rawUnit} är inte upplagd på komponenten ${componentNumber} — lägg upp den som alternativ enhet först`
        );
      }
      // It matches: the base unit, so unitId/unitFactor stay null. The code is
      // deliberately NOT looked up in unitsByCode — it may be in newUnits.
    } else if (rawUnit !== "" && component) {
      const unit = unitsByCode.get(rawUnit.toLowerCase());
      if (!unit) {
        errors.push(`Enheten ${rawUnit} finns inte i enhetsregistret`);
      } else if (unit.id !== component.unitId) {
        const factor = unitFactors.get(component.id)?.get(unit.id);
        if (factor === undefined) {
          errors.push(
            `Enheten ${rawUnit} är inte upplagd på komponenten ${componentNumber} — lägg upp den som alternativ enhet först`
          );
        } else {
          unitId = unit.id;
          unitFactor = factor;
        }
      }
      // unit.id === component.unitId is the base unit: unitId/unitFactor stay
      // null, exactly as resolveUnitSelection returns for the base unit.
    }

    const rawOperation = record["operationSequenceNo"] ?? "";
    values["operationSequenceNo"] = rawOperation;
    let routingOperationId: string | null = null;
    if (rawOperation !== "") {
      const parsed = normalizeDecimal(rawOperation);
      if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
        errors.push(`Ogiltig operation: "${rawOperation}" (ange ett heltal större än 0)`);
      } else if (parent) {
        const perArticle = existingOperations.get(parent.id);
        const operation = perArticle?.get(parsed);
        if (!operation) {
          // A WARNING, not an error: an unlinked component is drawn at final
          // reporting instead (CLAUDE.md, principle 3), which beats stopping a
          // whole file because a routing has not been imported yet — Monitor's
          // Materiallista carries "Till operation" even for articles whose
          // routing is not in the operations export.
          warnings.push(
            perArticle === undefined
              ? `Artikel ${articleNumber} har ingen rutt — materialet kopplas inte till någon operation och dras i takt med inleveransen av färdiga varor`
              : `Operation ${parsed} finns inte på artikel ${articleNumber} — materialet kopplas inte till någon operation och dras i takt med inleveransen av färdiga varor`
          );
        } else if (operation.costingOnly) {
          // Same rule as assertOperationBelongsToArticle's
          // CostingOnlyOperationLinkError — a Kalkyl operation is never
          // released, so material tied to it would never be drawn.
          errors.push(
            `Operation ${parsed} på artikel ${articleNumber} är en kalkyloperation och kan inte förbruka material`
          );
        } else {
          routingOperationId = operation.id;
        }
      }
    }

    // Pos. — free text like the card's field (varchar(20)); longer is a row
    // error, never a silent truncation.
    const rawPosition = record["position"] ?? "";
    let position: string | null = null;
    if (rawPosition !== "") {
      values["position"] = rawPosition;
      if (rawPosition.length > 20) errors.push(`Pos. är för lång (${rawPosition.length} tecken, max 20)`);
      else position = rawPosition;
    }

    rows.push({ rowNumber, action: existingRowId ? "update" : "create", errors, warnings, values });

    if (existingRowId) {
      // The edge already exists, so the row adds nothing to the cycle check.
      staged.push(null);
      if (errors.length === 0 && quantity !== null) {
        const patch: BomUpdatePlan["patch"] = {
          quantity: unitFactor === null ? quantity : toBaseQuantity(quantity, unitFactor),
          unitId,
          unitFactor,
        };
        if (operationMapped) patch.routingOperationId = routingOperationId;
        if (position !== null) patch.position = position;
        updates.push({ id: existingRowId, patch });
      }
      return;
    }

    if (errors.length === 0 && parent && (component || pending) && quantity !== null) {
      staged.push({
        parentArticleId: parent.id,
        componentArticleId: component?.id ?? null,
        componentNumber,
        quantity: unitFactor === null ? quantity : toBaseQuantity(quantity, unitFactor),
        unitId,
        unitFactor,
        routingOperationId,
        ...(position !== null ? { position } : {}),
      });
    } else {
      staged.push(null);
    }
  });

  // Runs AFTER the row loop and BEFORE summarize: a row can still be
  // invalidated here, and summary/hasErrors must reflect that.
  const cyclic = findCyclicRows(
    existingEdges,
    staged.flatMap((create, index) =>
      create
        ? [
            {
              parentId: create.parentArticleId,
              // A newly created component is never a parent (parents are never
              // auto-created), so the node is always a sink and cannot close a
              // cycle — but it still needs a key that is unique per article
              // number, so two different new components are not merged into one
              // node. A uuid can never collide with the "new:" prefix.
              componentId: create.componentArticleId ?? `new:${create.componentNumber}`,
              rowIndex: index,
            },
          ]
        : []
    )
  );
  for (const index of cyclic) {
    const parentNumber = records[index]!["articleNumber"];
    const componentNumber = records[index]!["componentNumber"];
    rows[index]!.errors.push(
      `Raden skapar en cirkulär struktur — ${componentNumber} innehåller redan ${parentNumber}`
    );
    staged[index] = null;
  }

  return {
    rows,
    summary: summarize(rows),
    willCreate: {
      units: [...newUnits.values()],
      articleGroups: [],
      articles: [...pendingArticles.keys()],
    },
    creates: staged.filter((create): create is BomCreatePlan => create !== null),
    updates,
    articleCreates: [...pendingArticles.values()],
    fallbackUnitId: fallback?.unitId ?? null,
    fallbackLocationId: fallback?.locationId ?? null,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
