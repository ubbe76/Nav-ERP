import {
  articleCopyPartAllowed,
  deriveLoadingMeters,
  toBaseQuantity,
  type ArticleCopyPart,
  type ArticleType,
  type CreateArticleDrawingInput,
  type CreateArticleGroupInput,
  type CreateArticleInput,
  type CreateArticleRevisionInput,
  type CreateArticleUnitInput,
  type CreateBomComponentInput,
  type CreateDrawingRevisionInput,
  type ListArticlesQuery,
  type UpdateArticleDrawingInput,
  type UpdateArticleGroupInput,
  type UpdateArticleInput,
  type BatchUpdateArticleRow,
  type UpdateArticleRevisionInput,
  type UpdateArticleUnitInput,
  type UpdateBomComponentInput,
  type UpdateDrawingRevisionInput,
} from "@navet/shared";
import type { Db, Tx } from "@navet/db";
import type { ArticleRepository } from "../repository/article.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { DEFAULT_ARTICLE_SERIES_KEY, SeriesExhaustedError } from "../../system/service/number-series.js";
import { ERROR_CODES } from "@navet/shared";
import { codeFromName, errorBody } from "../../system/service/error-body.js";
import { assertModeAllowed } from "../../configurator/service/configurator-rules.js";

// Only domain errors the web has a translation for are reported by code; any
// other error (a raw database error, a bug) must not leak its message.
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));
const isKnownCode = (code: string | undefined): boolean => code !== undefined && KNOWN_CODES.has(code);

export type BatchUpdateResult =
  | { id: string; ok: true; article: NonNullable<Awaited<ReturnType<ArticleRepository["findById"]>>> }
  | { id: string; ok: false; error: { code: string; message: string } };

export class BomCycleError extends Error {
  constructor(message = "Adding this component would create a circular BOM structure") {
    super(message);
    this.name = "BomCycleError";
  }
}

// The same component twice on one article. bom_components is unique on
// (parent, component) — the operation link is chosen PER COMPONENT, not per
// routing row — so the second insert violates the constraint. Caught and
// named here for the same reason DuplicateArticleNumberError is: the raw
// violation reached the client as a 500.
export class DuplicateBomComponentError extends Error {
  constructor() {
    super("This component is already part of the article's structure");
    this.name = "DuplicateBomComponentError";
  }
}

export class ArticleNotFoundError extends Error {
  constructor(id: string) {
    super(`Article ${id} not found`);
    this.name = "ArticleNotFoundError";
  }
}

// Produktkonfigurator: a template in mode `variants` (mall) is never put on
// a new order row — its variants are. Thrown by assertOrderableArticle from
// the sales/purchase/manufacturing services (→ 409 article-is-template).
export class ArticleIsTemplateError extends Error {
  // Default text is the variants-template refusal; purchase passes the beställningsvara text.
  constructor(public articleNumber: string, message = `${articleNumber} är en mall — välj en variant`) {
    super(message);
    this.name = "ArticleIsTemplateError";
  }
}

// The guard itself — pure, so the three order services share one rule. Runs
// on new rows only (quote/KO create + addRow, IO addRow, inquiry create +
// addRow, new TO incl. the KO row's Skapa TO); an existing row keeps working
// (quantity/price edits, inquiry → IO conversion) — the mode may have been set
// after the row was created. A to_order template is left to delprojekt 4.
export function assertOrderableArticle(article: { articleNumber: string; configuratorMode: "variants" | "to_order" | null }): void {
  if (article.configuratorMode === "variants") throw new ArticleIsTemplateError(article.articleNumber);
}

// Purchase side (IO rows, inquiry rows): neither template mode can be bought — a to_order
// template is made to order, never purchased (4b; stays until 4c decides otherwise).
export function assertPurchasableArticle(article: { articleNumber: string; configuratorMode: "variants" | "to_order" | null }): void {
  assertOrderableArticle(article);
  if (article.configuratorMode === "to_order") {
    throw new ArticleIsTemplateError(article.articleNumber, `${article.articleNumber} är en beställningsvara och kan inte köpas`);
  }
}

// "Kopiera från befintlig artikel": Beredning only goes to a manufactured
// article, Inköp only to a purchased/service one (articleCopyPartAllowed).
export class ArticleCopyPartNotAllowedError extends Error {
  constructor(part: ArticleCopyPart, type: ArticleType) {
    super(`The part "${part}" cannot be copied to a ${type} article`);
    this.name = "ArticleCopyPartNotAllowedError";
  }
}

export class DuplicateArticleNumberError extends Error {
  constructor(articleNumber: string) {
    super(`An article with number "${articleNumber}" already exists`);
    this.name = "DuplicateArticleNumberError";
  }
}

// A referenced register row (article group / package type) that does not
// exist. Surfaced as 400 — without this check the FK violation became a 500.
export class InvalidReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceError";
  }
}

export class BomComponentNotFoundError extends Error {
  constructor(id: string) {
    super(`BOM component row ${id} not found`);
    this.name = "BomComponentNotFoundError";
  }
}

export class ArticleGroupNotFoundError extends Error {
  constructor(id: string) {
    super(`Article group ${id} not found`);
    this.name = "ArticleGroupNotFoundError";
  }
}

export class DuplicateArticleGroupError extends Error {
  constructor(field: "code" | "name", value: string) {
    super(
      field === "code"
        ? `An article group with code ${value} already exists`
        : `An article group named ${value} already exists`
    );
    this.name = "DuplicateArticleGroupError";
  }
}

// One node in the structure tree served by GET /articles/:id/bom-tree.
// quantity/bomRowId are null on the root (the article itself has no BOM row).
export interface BomTreeNode {
  articleId: string;
  articleNumber: string;
  name: string;
  isPhantom: boolean;
  quantity: string | null;
  bomRowId: string | null;
  children: BomTreeNode[];
}

export class ArticleFileNotFoundError extends Error {
  constructor(id: string) {
    super(`Article file ${id} not found`);
    this.name = "ArticleFileNotFoundError";
  }
}

export class InvalidFileTypeError extends Error {
  constructor(contentType: string) {
    super(`Unsupported file type "${contentType}" — only PDF, JPEG and PNG are allowed`);
    this.name = "InvalidFileTypeError";
  }
}

// Drawings are PDF/JPEG/PNG: the formats the printout/merge step can render.
export const ALLOWED_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Narrow reader for cross-module use: order rows entered in an alternative
// unit resolve their factor snapshot here — same pattern as
// RegisterReferenceReader/StockBalanceReader.
export interface ArticleUnitReader {
  resolveUnitSelection(
    articleId: string,
    unitId: string | null | undefined
  ): Promise<{ unitId: string | null; unitFactor: number | null }>;
}

// Narrow reader for cross-module use (TO printout, order email attachments)
// — same pattern as RegisterReferenceReader/StockBalanceReader.
export interface ArticleFileReader {
  listFiles(articleId: string): Promise<{ id: string; filename: string; contentType: string; sizeBytes: number }[]>;
  filesWithData(articleIds: string[]): Promise<{ filename: string; contentType: string; data: Buffer }[]>;
}

export class ArticleRevisionNotFoundError extends Error {
  constructor(id: string) {
    super(`Article revision ${id} not found`);
    this.name = "ArticleRevisionNotFoundError";
  }
}

export class ArticleDrawingNotFoundError extends Error {
  constructor(id: string) {
    super(`Article drawing ${id} not found`);
    this.name = "ArticleDrawingNotFoundError";
  }
}

export class DuplicateRevisionError extends Error {
  constructor(revision: string) {
    super(`Revision "${revision}" already exists`);
    this.name = "DuplicateRevisionError";
  }
}

export class DuplicateDrawingNumberError extends Error {
  constructor(drawingNumber: string) {
    super(`Drawing number "${drawingNumber}" already exists on this article`);
    this.name = "DuplicateDrawingNumberError";
  }
}

// Narrow reader for document printing (offert/orderbekräftelse/IO/förfrågan):
// the active article revision plus drawing numbers with their active revision.
export interface ArticleRevisionReader {
  activeRevisionInfo(
    articleIds: string[]
  ): Promise<Map<string, { revision: string | null; drawings: { drawingNumber: string; revision: string | null }[] }>>;
}

export class RoutingOperationMismatchError extends Error {
  constructor() {
    super("The routing operation does not belong to this article");
    this.name = "RoutingOperationMismatchError";
  }
}

// A "Kalkyl" operation is priced into the pre-calculation but never
// snapshotted onto a manufacturing order, so material tied to it would
// silently fall through to final completion. The manufacturing side refuses
// the other direction (OperationHasLinkedMaterialError).
export class CostingOnlyOperationLinkError extends Error {
  constructor() {
    super("The routing operation is a Kalkyl operation and cannot draw material");
    this.name = "CostingOnlyOperationLinkError";
  }
}

// --- Units (enheter) ---

// The unit is not usable here: unknown in the register, or not the article's
// base unit / one of its alternative units.
export class InvalidUnitError extends Error {
  constructor(message = "The unit is not one of the article's units") {
    super(message);
    this.name = "InvalidUnitError";
  }
}

export class BaseUnitConflictError extends Error {
  constructor() {
    super("The base unit cannot be added as an alternative unit");
    this.name = "BaseUnitConflictError";
  }
}

export class DuplicateArticleUnitError extends Error {
  constructor() {
    super("The article already has this alternative unit");
    this.name = "DuplicateArticleUnitError";
  }
}

export class ArticleUnitNotFoundError extends Error {
  constructor(id: string) {
    super(`Article unit row ${id} not found`);
    this.name = "ArticleUnitNotFoundError";
  }
}

// Changing the base unit would silently change what every factor means.
export class BaseUnitLockedError extends Error {
  constructor() {
    super("The base unit cannot be changed while the article has alternative units");
    this.name = "BaseUnitLockedError";
  }
}

export class ArticleUnitInUseError extends Error {
  constructor() {
    super("The unit is the article's purchase or sales unit and cannot be removed");
    this.name = "ArticleUnitInUseError";
  }
}

// A series-issued number that collides with one typed by hand meanwhile is
// retried with the next free number this many times.
const ARTICLE_NUMBER_UNIQUE = "articles_article_number_unique";
const ARTICLE_NUMBER_RETRIES = 5;

export function createArticleService(repo: ArticleRepository) {
  // A group (or an article) may only point at an article number series.
  async function assertArticleNumberSeries(key: string | null | undefined) {
    if (key && !(await repo.findArticleNumberSeries(key))) throw new InvalidReferenceError("Unknown article number series");
  }

  // A BOM row may only point at one of its OWN article's routing operations —
  // otherwise the material would be tied to a step that never runs on this MO.
  async function assertOperationBelongsToArticle(operationId: string, articleId: string) {
    const operation = await repo.findRoutingOperationById(operationId);
    if (!operation || operation.articleId !== articleId) throw new RoutingOperationMismatchError();
    if (operation.costingOnly) throw new CostingOnlyOperationLinkError();
  }

  // A default purchase/sales unit must be the base unit or one of the
  // article's alternative units — anything else would have no factor.
  async function assertUsableDefaultUnit(articleId: string, baseUnitId: string, unitId: string) {
    if (unitId === baseUnitId) return;
    if (!(await repo.findArticleUnit(articleId, unitId))) throw new InvalidUnitError();
  }

  return {
    async createArticle(input: CreateArticleInput) {
      // "Kopiera från": the type rules first (no database needed), then the
      // source must exist.
      const copy = input.copyFrom;
      for (const part of copy?.parts ?? []) {
        if (!articleCopyPartAllowed(part, input.type)) throw new ArticleCopyPartNotAllowedError(part, input.type);
      }
      const source = copy ? await repo.findById(copy.articleId) : null;
      if (copy && !source) throw new ArticleNotFoundError(copy.articleId);
      // Referenced registers are validated up front so a bad id becomes a
      // 400 instead of surfacing as an FK violation (500) — the importer and
      // the configurator both depend on clean semantics here.
      if (input.groupId && !(await repo.articleGroupExists(input.groupId))) {
        throw new InvalidReferenceError("Unknown article group");
      }
      if (input.articleCodeId && !(await repo.articleCodeExists(input.articleCodeId))) {
        throw new InvalidReferenceError("Unknown article code");
      }
      if (input.packageTypeId && !(await repo.packageTypeExists(input.packageTypeId))) {
        throw new InvalidReferenceError("Unknown package type");
      }
      // "Lagerplats sätts *** automatiskt" — an article always carries a
      // default location from birth; *** is created on first use. The base
      // unit falls back the same way, to the register's "st" unit.
      const defaultLocationId = input.defaultLocationId ?? (await repo.getOrCreateFallbackLocationId());
      let unitId = input.unitId;
      if (unitId) {
        if (!(await repo.findUnitById(unitId))) throw new InvalidUnitError("Unknown unit");
      } else {
        unitId = await repo.getOrCreateDefaultUnitId();
      }
      // Without a copy, alternative units can't exist yet, so defaults may
      // only be the base unit. Copying Information onto the source's base
      // unit brings the source's alternative units along — those are usable
      // defaults too.
      const usableDefaultUnits = new Set([unitId]);
      if (copy?.parts.includes("information") && source!.unitId === unitId) {
        for (const altUnit of await repo.listArticleUnits(source!.id)) usableDefaultUnits.add(altUnit.unitId);
      }
      for (const defaultUnit of [input.purchaseUnitId, input.salesUnitId]) {
        if (defaultUnit && !usableDefaultUnits.has(defaultUnit)) throw new InvalidUnitError();
      }
      const { numberSeriesKey, articleNumber, ...fields } = input;
      const loadingMeters = deriveLoadingMeters(input.palletSpaces, input.loadingMeters) ?? undefined;
      const insert = async (number: string) => {
        const created = await repo.create({ ...fields, articleNumber: number, loadingMeters, unitId, defaultLocationId });
        // The source was deleted between the check above and the transaction.
        if (!created) throw new ArticleNotFoundError(copy!.articleId);
        // Re-read joined so the response carries what the GET does (unit
        // codes, the varugrupp's vatRate).
        return (await repo.findById(created.id))!;
      };

      if (articleNumber !== undefined) {
        try {
          return await insert(articleNumber);
        } catch (err) {
          // Same mapping updateArticle already has — a duplicate number on
          // POST was a raw 500 until the importer needed the 409.
          if (isUniqueViolation(err)) throw new DuplicateArticleNumberError(articleNumber);
          throw err;
        }
      }

      // Artikelnummerserie: the one asked for, else the group's, else the
      // default. The claimed number was free when it was issued; a number
      // typed by hand on another article in between makes the insert
      // collide, and the next free number is taken instead (bounded).
      const key =
        numberSeriesKey ?? (input.groupId ? await repo.articleGroupNumberSeries(input.groupId) : null) ?? DEFAULT_ARTICLE_SERIES_KEY;
      for (let attempt = 0; ; attempt++) {
        const issued = await repo.claimArticleNumber(key);
        if (issued === null) throw new InvalidReferenceError("Unknown article number series");
        try {
          return await insert(issued);
        } catch (err) {
          if (!isUniqueViolation(err, ARTICLE_NUMBER_UNIQUE)) throw err;
          if (attempt >= ARTICLE_NUMBER_RETRIES) throw new SeriesExhaustedError(key);
        }
      }
    },

    // Ny artikel: the article number series with the number each would
    // issue right now (a preview — nothing is reserved).
    async listArticleNumberSeries() {
      const rows = await repo.listArticleNumberSeries();
      return Promise.all(
        rows.map(async (row) => ({
          key: row.key,
          name: row.name,
          prefix: row.prefix,
          isDefault: row.key === DEFAULT_ARTICLE_SERIES_KEY,
          nextArticleNumber: await repo.previewArticleNumber(row),
        }))
      );
    },

    async getArticle(id: string) {
      return repo.findById(id);
    },

    async listArticles(query: ListArticlesQuery) {
      return repo.list(query);
    },

    async updateArticle(id: string, input: UpdateArticleInput) {
      const article = await repo.findById(id);
      if (!article) throw new ArticleNotFoundError(id);

      if (input.groupId && !(await repo.articleGroupExists(input.groupId))) {
        throw new InvalidReferenceError("Unknown article group");
      }
      if (input.articleCodeId && !(await repo.articleCodeExists(input.articleCodeId))) {
        throw new InvalidReferenceError("Unknown article code");
      }

      if (input.unitId !== undefined && input.unitId !== article.unitId) {
        if (!(await repo.findUnitById(input.unitId))) throw new InvalidUnitError("Unknown unit");
        if ((await repo.countArticleUnits(id)) > 0) throw new BaseUnitLockedError();
      }
      const baseUnitId = input.unitId ?? article.unitId;
      if (input.purchaseUnitId) await assertUsableDefaultUnit(id, baseUnitId, input.purchaseUnitId);
      if (input.salesUnitId) await assertUsableDefaultUnit(id, baseUnitId, input.salesUnitId);

      // Pallplatser → flakmeter, but never over a flakmeter the user already has.
      let effective = input;
      if (input.palletSpaces !== undefined && input.loadingMeters === undefined && article.loadingMeters === null) {
        const derived = deriveLoadingMeters(input.palletSpaces, undefined);
        if (derived !== undefined) effective = { ...input, loadingMeters: derived };
      }
      const write = async (ex?: Db | Tx) => {
        try {
          await repo.update(id, effective, ex);
        } catch (err) {
          if (isUniqueViolation(err)) throw new DuplicateArticleNumberError(input.articleNumber ?? "");
          throw err;
        }
      };
      // Produktkonfigurator: a template article may not change into a type (or
      // become a phantom) its mode does not allow (ConfiguratorModeNotAllowedError).
      // The check and the write run in ONE transaction holding the article row
      // FOR UPDATE, which the template writers (createTemplate/updateTemplate/
      // createVariants) read FOR SHARE — so a mode that is set between the
      // check and the write is impossible, and vice versa. The row is locked
      // whenever the patch mentions type/isPhantom (not only when the unlocked
      // read above says they change): the comparison is made against the LOCKED
      // row, so a concurrent change can never slip past as "unchanged". A patch
      // without those fields writes as before.
      if (input.type !== undefined || input.isPhantom !== undefined) {
        await repo.transaction(async (tx) => {
          const locked = await repo.lockArticle(tx, id);
          if (!locked) throw new ArticleNotFoundError(id);
          const typeChanges = input.type !== undefined && input.type !== locked.type;
          const phantomChanges = input.isPhantom !== undefined && input.isPhantom !== locked.isPhantom;
          if (typeChanges || phantomChanges) {
            const mode = await repo.configuratorModeFor(id, tx);
            if (mode) assertModeAllowed({ type: input.type ?? locked.type, isPhantom: input.isPhantom ?? locked.isPhantom }, mode);
          }
          await write(tx);
        });
      } else {
        await write();
      }
      // Re-read joined so the response carries unit codes like the GET.
      return repo.findById(id);
    },

    // Inline editing in the register: each row goes through updateArticle in
    // its own transaction, so one rejected row never blocks the others.
    // Results come back in request order.
    async updateArticlesBatch(rows: BatchUpdateArticleRow[]): Promise<{ results: BatchUpdateResult[] }> {
      const results: BatchUpdateResult[] = [];
      for (const { id, ...patch } of rows) {
        try {
          results.push({ id, ok: true, article: (await this.updateArticle(id, patch))! });
        } catch (err) {
          if (err instanceof Error && isKnownCode(codeFromName(err.name))) {
            const { error, code } = errorBody(err);
            results.push({ id, ok: false, error: { code: code!, message: error } });
          } else {
            console.error("updateArticlesBatch: unexpected error for article", id, err);
            results.push({ id, ok: false, error: { code: "unexpected", message: "Kunde inte spara raden" } });
          }
        }
      }
      return { results };
    },

    // --- Alternative units (alternativa enheter) ---

    async listArticleUnits(articleId: string) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      return repo.listArticleUnits(articleId);
    },

    async addArticleUnit(articleId: string, input: CreateArticleUnitInput) {
      const article = await repo.findById(articleId);
      if (!article) throw new ArticleNotFoundError(articleId);
      if (!(await repo.findUnitById(input.unitId))) throw new InvalidUnitError("Unknown unit");
      if (input.unitId === article.unitId) throw new BaseUnitConflictError();
      if (await repo.findArticleUnit(articleId, input.unitId)) throw new DuplicateArticleUnitError();
      return repo.addArticleUnit(articleId, input.unitId, input.quantityPerBase);
    },

    async updateArticleUnit(articleId: string, rowId: string, input: UpdateArticleUnitInput) {
      const row = await repo.updateArticleUnit(articleId, rowId, input.quantityPerBase);
      if (!row) throw new ArticleUnitNotFoundError(rowId);
      return row;
    },

    async removeArticleUnit(articleId: string, rowId: string) {
      const article = await repo.findById(articleId);
      if (!article) throw new ArticleNotFoundError(articleId);
      const row = await repo.findArticleUnitRow(articleId, rowId);
      if (!row) throw new ArticleUnitNotFoundError(rowId);
      if (row.unitId === article.purchaseUnitId || row.unitId === article.salesUnitId) {
        throw new ArticleUnitInUseError();
      }
      await repo.deleteArticleUnit(articleId, rowId);
    },

    // Resolves a row-level unit choice for an article: null/base unit → no
    // snapshot, alternative unit → its snapshotted factor. Shared by BOM rows
    // here and order rows in purchase/sales (via ArticleUnitReader).
    async resolveUnitSelection(articleId: string, unitId: string | null | undefined) {
      if (!unitId) return { unitId: null, unitFactor: null };
      const article = await repo.findById(articleId);
      if (!article) throw new ArticleNotFoundError(articleId);
      if (unitId === article.unitId) return { unitId: null, unitFactor: null };
      const altUnit = await repo.findArticleUnit(articleId, unitId);
      if (!altUnit) throw new InvalidUnitError();
      return { unitId, unitFactor: Number(altUnit.quantityPerBase) };
    },

    async updateStandardCost(id: string, standardCost: number) {
      const article = await repo.findById(id);
      if (!article) throw new ArticleNotFoundError(id);
      return repo.updateStandardCost(id, standardCost);
    },

    // Narrow sibling of updateStandardCost, for the costing module's "Sätt
    // försäljningspris". Deliberately not routed through updateArticle: that
    // would make costing depend on the whole UpdateArticleInput shape and its
    // unit validation, for a single numeric field.
    async updateSalesPrice(id: string, salesPrice: number) {
      const article = await repo.findById(id);
      if (!article) throw new ArticleNotFoundError(id);
      return repo.update(id, { salesPrice });
    },

    async getBom(parentArticleId: string) {
      return repo.getBomComponents(parentArticleId);
    },

    // Full structure tree for the article card's Beredning view. Unlike
    // explodeBom this preserves the hierarchy as authored: nothing is merged
    // and phantom articles appear as their own nodes with children.
    async getBomTree(articleId: string): Promise<BomTreeNode> {
      const root = await repo.findById(articleId);
      if (!root) throw new ArticleNotFoundError(articleId);

      const walk = async (parentId: string, path: Set<string>): Promise<BomTreeNode[]> => {
        if (path.has(parentId)) {
          throw new Error(`Cyclic BOM detected at article ${parentId} — this should be impossible`);
        }
        const nextPath = new Set(path).add(parentId);

        const rows = await repo.getBomComponents(parentId);
        return Promise.all(
          rows.map(async (row) => ({
            articleId: row.componentArticleId,
            articleNumber: row.componentArticleNumber,
            name: row.componentName,
            isPhantom: row.componentIsPhantom,
            quantity: row.quantity,
            bomRowId: row.id,
            children: await walk(row.componentArticleId, nextPath),
          }))
        );
      };

      return {
        articleId: root.id,
        articleNumber: root.articleNumber,
        name: root.name,
        isPhantom: root.isPhantom,
        quantity: null,
        bomRowId: null,
        children: await walk(articleId, new Set()),
      };
    },

    async createArticleGroup(input: CreateArticleGroupInput) {
      await assertArticleNumberSeries(input.numberSeriesKey);
      await repo.resolveDimensions({ costCenterId: input.defaultCostCenterId });
      if (await repo.findArticleGroupByCode(input.code)) throw new DuplicateArticleGroupError("code", input.code);
      if (await repo.findArticleGroupByName(input.name)) throw new DuplicateArticleGroupError("name", input.name);
      return repo.createArticleGroup(input);
    },

    async updateArticleGroup(id: string, input: UpdateArticleGroupInput) {
      await assertArticleNumberSeries(input.numberSeriesKey);
      // Kostnadsställe (förval): a new choice must be active; the kept one may stay.
      if (input.defaultCostCenterId !== undefined) {
        const current = await repo.findArticleGroupById(id);
        if (!current) throw new ArticleGroupNotFoundError(id);
        await repo.resolveDimensions({ costCenterId: input.defaultCostCenterId }, { existing: { costCenterId: current.defaultCostCenterId, projectId: null } });
      }
      // A group may of course keep its own code/name, so conflicts only
      // count when they sit on a different row.
      const byCode = await repo.findArticleGroupByCode(input.code);
      if (byCode && byCode.id !== id) throw new DuplicateArticleGroupError("code", input.code);
      const byName = await repo.findArticleGroupByName(input.name);
      if (byName && byName.id !== id) throw new DuplicateArticleGroupError("name", input.name);

      const row = await repo.updateArticleGroup(id, input);
      if (!row) throw new ArticleGroupNotFoundError(id);
      return row;
    },

    // Quantity/unit and the operation link are editable — swapping the
    // component is remove + add, so the cycle check in addBomComponent stays
    // the single validation point.
    async updateBomComponent(parentArticleId: string, rowId: string, input: UpdateBomComponentInput) {
      if (input.routingOperationId) await assertOperationBelongsToArticle(input.routingOperationId, parentArticleId);

      const existing = await repo.findBomComponentRow(parentArticleId, rowId);
      if (!existing) throw new BomComponentNotFoundError(rowId);

      // The unit the incoming quantity is expressed in: the newly chosen unit
      // when the PATCH sets one, otherwise the row's current unit.
      let unitPatch: { unitId?: string | null; unitFactor?: number | null } = {};
      let effectiveFactor = existing.unitFactor !== null ? Number(existing.unitFactor) : null;
      if (input.unitId !== undefined) {
        const selection = await this.resolveUnitSelection(existing.componentArticleId, input.unitId);
        unitPatch = selection;
        effectiveFactor = selection.unitFactor;
      }

      const row = await repo.updateBomComponent(parentArticleId, rowId, {
        ...unitPatch,
        quantity: input.quantity !== undefined ? toBaseQuantity(input.quantity, effectiveFactor) : undefined,
        routingOperationId: input.routingOperationId,
        position: input.position,
      });
      if (!row) throw new BomComponentNotFoundError(rowId);
      return row;
    },

    async removeBomComponent(parentArticleId: string, rowId: string) {
      const row = await repo.deleteBomComponent(parentArticleId, rowId);
      if (!row) throw new BomComponentNotFoundError(rowId);
    },

    async listArticleGroups() {
      return repo.listArticleGroups();
    },

    // --- Attached files (ritningar) ---

    async listFiles(articleId: string) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      return repo.listFiles(articleId);
    },

    async addFile(articleId: string, file: { filename: string; contentType: string; data: Buffer }) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      if (!(ALLOWED_FILE_TYPES as readonly string[]).includes(file.contentType)) {
        throw new InvalidFileTypeError(file.contentType);
      }
      return repo.addFile({
        articleId,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        data: file.data,
      });
    },

    async downloadFile(articleId: string, fileId: string) {
      const row = await repo.findFile(articleId, fileId);
      if (!row) throw new ArticleFileNotFoundError(fileId);
      return row;
    },

    async deleteFile(articleId: string, fileId: string) {
      const row = await repo.deleteFile(articleId, fileId);
      if (!row) throw new ArticleFileNotFoundError(fileId);
    },

    async filesWithData(articleIds: string[]) {
      return repo.filesWithData(articleIds);
    },

    // --- Artikelrevisioner ---

    async listRevisions(articleId: string) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      return repo.listRevisions(articleId);
    },

    async createRevision(articleId: string, input: CreateArticleRevisionInput) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      try {
        return await repo.createRevision(articleId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateRevisionError(input.revision);
        throw err;
      }
    },

    async updateRevision(articleId: string, revisionId: string, input: UpdateArticleRevisionInput) {
      try {
        const row = await repo.updateRevision(articleId, revisionId, input);
        if (!row) throw new ArticleRevisionNotFoundError(revisionId);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateRevisionError(input.revision ?? "");
        throw err;
      }
    },

    async deleteRevision(articleId: string, revisionId: string) {
      const row = await repo.deleteRevision(articleId, revisionId);
      if (!row) throw new ArticleRevisionNotFoundError(revisionId);
    },

    // --- Ritningsnummer & ritningsrevisioner ---

    async listDrawings(articleId: string) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      return repo.listDrawings(articleId);
    },

    async createDrawing(articleId: string, input: CreateArticleDrawingInput) {
      if (!(await repo.findById(articleId))) throw new ArticleNotFoundError(articleId);
      try {
        return await repo.createDrawing(articleId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateDrawingNumberError(input.drawingNumber);
        throw err;
      }
    },

    async updateDrawing(articleId: string, drawingId: string, input: UpdateArticleDrawingInput) {
      try {
        const row = await repo.updateDrawing(articleId, drawingId, input);
        if (!row) throw new ArticleDrawingNotFoundError(drawingId);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateDrawingNumberError(input.drawingNumber);
        throw err;
      }
    },

    async deleteDrawing(articleId: string, drawingId: string) {
      const row = await repo.deleteDrawing(articleId, drawingId);
      if (!row) throw new ArticleDrawingNotFoundError(drawingId);
    },

    async createDrawingRevision(articleId: string, drawingId: string, input: CreateDrawingRevisionInput) {
      if (!(await repo.findDrawing(articleId, drawingId))) throw new ArticleDrawingNotFoundError(drawingId);
      try {
        return await repo.createDrawingRevision(drawingId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateRevisionError(input.revision);
        throw err;
      }
    },

    async updateDrawingRevision(
      articleId: string,
      drawingId: string,
      revisionId: string,
      input: UpdateDrawingRevisionInput
    ) {
      if (!(await repo.findDrawing(articleId, drawingId))) throw new ArticleDrawingNotFoundError(drawingId);
      try {
        const row = await repo.updateDrawingRevision(drawingId, revisionId, input);
        if (!row) throw new ArticleRevisionNotFoundError(revisionId);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateRevisionError(input.revision ?? "");
        throw err;
      }
    },

    async deleteDrawingRevision(articleId: string, drawingId: string, revisionId: string) {
      if (!(await repo.findDrawing(articleId, drawingId))) throw new ArticleDrawingNotFoundError(drawingId);
      const row = await repo.deleteDrawingRevision(drawingId, revisionId);
      if (!row) throw new ArticleRevisionNotFoundError(revisionId);
    },

    // For document printing (ArticleRevisionReader).
    async activeRevisionInfo(articleIds: string[]) {
      return repo.activeRevisionInfo(articleIds);
    },

    // Direct self-reference is already rejected by the `no_self_reference` DB check.
    // This walks the component's existing subtree to reject indirect cycles
    // (e.g. A contains B, B contains C, then adding C -> A would loop back).
    async addBomComponent(parentArticleId: string, input: CreateBomComponentInput) {
      const parent = await repo.findById(parentArticleId);
      if (!parent) throw new ArticleNotFoundError(parentArticleId);

      const component = await repo.findById(input.componentArticleId);
      if (!component) throw new ArticleNotFoundError(input.componentArticleId);

      if (await this.isDescendant(input.componentArticleId, parentArticleId)) {
        throw new BomCycleError();
      }
      if (input.routingOperationId) await assertOperationBelongsToArticle(input.routingOperationId, parentArticleId);

      // The quantity is entered in the chosen unit (one of the COMPONENT's
      // units) — stored in the component's base unit with the factor
      // snapshotted for display.
      const selection = await this.resolveUnitSelection(input.componentArticleId, input.unitId);
      try {
        return await repo.addBomComponent(parentArticleId, {
          ...input,
          quantity: toBaseQuantity(input.quantity, selection.unitFactor),
          unitId: selection.unitId,
          unitFactor: selection.unitFactor,
        });
      } catch (err) {
        // bom_components has exactly one unique constraint — (parent,
        // component) — so the unnamed check is unambiguous here, unlike
        // isForeignKeyViolation's constraint-name variant. updateBomComponent
        // needs no such guard: it only ever changes unit, quantity and the
        // operation link, never componentArticleId.
        if (isUniqueViolation(err)) throw new DuplicateBomComponentError();
        throw err;
      }
    },

    // Is `candidateAncestorId` reachable by walking down from `articleId`'s BOM tree?
    async isDescendant(articleId: string, candidateAncestorId: string, visited = new Set<string>()): Promise<boolean> {
      if (articleId === candidateAncestorId) return true;
      if (visited.has(articleId)) return false;
      visited.add(articleId);

      const children = await repo.getBomComponents(articleId);
      for (const child of children) {
        if (await this.isDescendant(child.componentArticleId, candidateAncestorId, visited)) {
          return true;
        }
      }
      return false;
    },
  };
}

export type ArticleService = ReturnType<typeof createArticleService>;
