// The reads behind the import exports (#35, service/import-export.ts): each
// register as the records its row builder takes — codes and numbers instead
// of ids, numbers as numbers. Read-only.
//
// `articleIds`: the article selection the article register resolved
// (ArticleService.selectArticleIds) — null = every article. The ids are
// bound in chunks, so a selection of any size stays under Postgres'
// parameter limit; the rows are sorted here, by article number in code-unit
// order (the selection's from/to are byte order), then by the register's
// own order within an article.
import { and, asc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articleCodes,
  articleGroups,
  articleRevisions,
  articleSupplierPriceBreaks,
  articleSuppliers,
  articleUnits,
  articles,
  bomComponents,
  carriers,
  customerArticleNumbers,
  customerContacts,
  customerDeliveryAddresses,
  customerPrices,
  customers,
  deliveryTerms,
  paymentTerms,
  priceLists,
  productionGroups,
  routingOperations,
  stockBatches,
  stockLocations,
  stockTransactions,
  supplierContacts,
  supplierDeliveryAddresses,
  suppliers,
  units,
  warehouses,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import { UNKNOWN_BATCH_LABEL } from "@navet/shared";
import {
  registerCellTexts,
  type ArticleExportRecord,
  type ArticleUnitExportRecord,
  type BomExportRecord,
  type ContactExportRecord,
  type CustomerExportRecord,
  type CustomerPriceExportRecord,
  type DeliveryAddressExportRecord,
  type LegoWorkCenterExportRecord,
  type ProductionGroupExportRecord,
  type RegisterRow,
  type RoutingExportRecord,
  type StockBalanceExportRecord,
  type SupplierExportRecord,
  type SupplierPriceExportRecord,
  type WorkCenterExportRecord,
} from "../service/import-export.js";

const CHUNK = 1000;

const num = (value: string | number | null): number | null => (value === null ? null : Number(value));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createImportExportRepository(db: Db | Tx) {
  // Runs `query` once for the whole register (ids null) or once per chunk of
  // the selection, with the condition that restricts `column` to the chunk.
  async function forArticles<T>(
    articleIds: readonly string[] | null,
    column: Parameters<typeof inArray>[0],
    query: (condition: SQL | undefined) => Promise<T[]>
  ): Promise<T[]> {
    if (articleIds === null) return query(undefined);
    const out: T[] = [];
    for (let i = 0; i < articleIds.length; i += CHUNK) {
      out.push(...(await query(inArray(column, articleIds.slice(i, i + CHUNK)))));
    }
    return out;
  }

  // id -> the cell that names the row (registerCellTexts).
  async function registerTexts(rows: Promise<RegisterRow[]>): Promise<Map<string, string>> {
    return registerCellTexts(await rows);
  }

  return {
    async articles(articleIds: readonly string[] | null): Promise<ArticleExportRecord[]> {
      const primary = alias(articleSuppliers, "primary_supplier");
      const rows = await forArticles(articleIds, articles.id, (condition) =>
        db
          .select({
            articleNumber: articles.articleNumber,
            name: articles.name,
            type: articles.type,
            isPhantom: articles.isPhantom,
            unitCode: units.code,
            groupCode: articleGroups.code,
            articleCode: articleCodes.code,
            standardCost: articles.standardCost,
            weight: articles.weight,
            surfaceTreatment: articles.surfaceTreatment,
            colour: articles.colour,
            extraDescription: articles.extraDescription,
            nameEn: articles.nameEn,
            extraDescriptionEn: articles.extraDescriptionEn,
            barcode: articles.barcode,
            active: articles.active,
            reorderPoint: articles.reorderPoint,
            orderQuantity: articles.orderQuantity,
            rounding: articles.rounding,
            safetyStock: articles.safetyStock,
            stockControlled: articles.stockControlled,
            forecastControlled: articles.forecastControlled,
            tracking: articles.tracking,
            shelfLifeDays: articles.shelfLifeDays,
            manufacturingLeadTimeDays: articles.manufacturingLeadTimeDays,
            quantityPerPackage: articles.quantityPerPackage,
            primarySupplierNumber: suppliers.supplierNumber,
            primarySupplierLeadTimeDays: primary.leadTimeDays,
            // At most one active revision per article (partial unique index).
            activeRevision: articleRevisions.revision,
            // The article's FIRST drawing number and that drawing's active
            // revision — one row per article has room for one drawing.
            drawingNumber: sql<string | null>`(select d.drawing_number from article_drawings d where d.article_id = "articles"."id" order by d.created_at, d.id limit 1)`,
            drawingRevision: sql<string | null>`(select r.revision from article_drawing_revisions r where r.is_active and r.drawing_id = (select d.id from article_drawings d where d.article_id = "articles"."id" order by d.created_at, d.id limit 1))`,
          })
          .from(articles)
          .innerJoin(units, eq(units.id, articles.unitId))
          .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
          .leftJoin(articleCodes, eq(articleCodes.id, articles.articleCodeId))
          .leftJoin(articleRevisions, and(eq(articleRevisions.articleId, articles.id), eq(articleRevisions.isActive, true)))
          // At most one primary supplier per article (partial unique index).
          .leftJoin(primary, and(eq(primary.articleId, articles.id), eq(primary.isPrimary, true)))
          .leftJoin(suppliers, eq(suppliers.id, primary.supplierId))
          .where(condition)
      );
      return rows
        .map((row) => ({
          ...row,
          standardCost: num(row.standardCost),
          weight: num(row.weight),
          reorderPoint: num(row.reorderPoint),
          orderQuantity: num(row.orderQuantity),
          rounding: num(row.rounding),
          safetyStock: num(row.safetyStock),
          quantityPerPackage: num(row.quantityPerPackage),
        }))
        .sort((a, b) => byText(a.articleNumber, b.articleNumber));
    },

    async articleUnits(articleIds: readonly string[] | null): Promise<ArticleUnitExportRecord[]> {
      const baseUnit = alias(units, "base_unit");
      const rows = await forArticles(articleIds, articleUnits.articleId, (condition) =>
        db
          .select({
            articleNumber: articles.articleNumber,
            baseUnitId: articles.unitId,
            baseUnitCode: baseUnit.code,
            purchaseUnitId: articles.purchaseUnitId,
            salesUnitId: articles.salesUnitId,
            unitId: articleUnits.unitId,
            unitCode: units.code,
            quantityPerBase: articleUnits.quantityPerBase,
          })
          .from(articleUnits)
          .innerJoin(articles, eq(articles.id, articleUnits.articleId))
          .innerJoin(baseUnit, eq(baseUnit.id, articles.unitId))
          .innerJoin(units, eq(units.id, articleUnits.unitId))
          .where(condition)
      );
      rows.sort((a, b) => byText(a.articleNumber, b.articleNumber) || byText(a.unitCode, b.unitCode));
      const byArticle = new Map<string, ArticleUnitExportRecord>();
      for (const row of rows) {
        let record = byArticle.get(row.articleNumber);
        if (!record) {
          record = {
            articleNumber: row.articleNumber,
            baseUnitCode: row.baseUnitCode,
            purchaseOnBase: row.purchaseUnitId === null || row.purchaseUnitId === row.baseUnitId,
            salesOnBase: row.salesUnitId === null || row.salesUnitId === row.baseUnitId,
            units: [],
          };
          byArticle.set(row.articleNumber, record);
        }
        record.units.push({
          unitCode: row.unitCode,
          quantityPerBase: Number(row.quantityPerBase),
          isPurchaseUnit: row.purchaseUnitId === row.unitId,
          isSalesUnit: row.salesUnitId === row.unitId,
        });
      }
      return [...byArticle.values()];
    },

    async routing(articleIds: readonly string[] | null): Promise<RoutingExportRecord[]> {
      const rows = await forArticles(articleIds, routingOperations.articleId, (condition) =>
        db
          .select({
            articleNumber: articles.articleNumber,
            sequenceNo: routingOperations.sequenceNo,
            workCenterCode: workCenters.code,
            workCenterType: workCenters.type,
            setupTime: routingOperations.setupTime,
            runTimePerUnit: routingOperations.runTimePerUnit,
            cycleTimePerUnit: routingOperations.cycleTimePerUnit,
            timeUnit: routingOperations.timeUnit,
            costingOnly: routingOperations.costingOnly,
            comment: routingOperations.comment,
            description: routingOperations.description,
            packingInstructions: routingOperations.packingInstructions,
            subcontractSupplierNumber: suppliers.supplierNumber,
            setupPrice: routingOperations.setupPrice,
            unitPrice: routingOperations.unitPrice,
            transportPrice: routingOperations.transportPrice,
          })
          .from(routingOperations)
          .innerJoin(articles, eq(articles.id, routingOperations.articleId))
          .innerJoin(workCenters, eq(workCenters.id, routingOperations.workCenterId))
          .leftJoin(suppliers, eq(suppliers.id, routingOperations.subcontractSupplierId))
          .where(condition)
      );
      return rows
        .map(({ workCenterType, ...row }) => ({
          ...row,
          isSubcontract: workCenterType === "subcontract",
          setupTime: Number(row.setupTime),
          runTimePerUnit: Number(row.runTimePerUnit),
          cycleTimePerUnit: num(row.cycleTimePerUnit),
          setupPrice: num(row.setupPrice),
          unitPrice: num(row.unitPrice),
          transportPrice: num(row.transportPrice),
        }))
        .sort((a, b) => byText(a.articleNumber, b.articleNumber) || a.sequenceNo - b.sequenceNo);
    },

    // The structure of the selected PARENTS, each in the structure's own
    // order (created_at, id — allBomEdges' order, which the import matches a
    // repeated component by).
    async bom(articleIds: readonly string[] | null): Promise<BomExportRecord[]> {
      const component = alias(articles, "component");
      const baseUnit = alias(units, "component_unit");
      const rowUnit = alias(units, "row_unit");
      const rows = await forArticles(articleIds, bomComponents.parentArticleId, (condition) =>
        db
          .select({
            parentNumber: articles.articleNumber,
            componentNumber: component.articleNumber,
            quantity: bomComponents.quantity,
            baseUnitCode: baseUnit.code,
            rowUnitCode: rowUnit.code,
            // The component's CURRENT factor for the row's unit — the one
            // the import converts with; null when the unit is no longer an
            // alternative unit of the component.
            currentFactor: articleUnits.quantityPerBase,
            operationSequenceNo: routingOperations.sequenceNo,
            position: bomComponents.position,
            costingOnly: bomComponents.costingOnly,
            componentName: component.name,
            componentType: component.type,
            componentIsPhantom: component.isPhantom,
            componentStandardCost: component.standardCost,
            createdAt: bomComponents.createdAt,
            id: bomComponents.id,
          })
          .from(bomComponents)
          .innerJoin(articles, eq(articles.id, bomComponents.parentArticleId))
          .innerJoin(component, eq(component.id, bomComponents.componentArticleId))
          .innerJoin(baseUnit, eq(baseUnit.id, component.unitId))
          .leftJoin(rowUnit, eq(rowUnit.id, bomComponents.unitId))
          .leftJoin(
            articleUnits,
            and(eq(articleUnits.articleId, bomComponents.componentArticleId), eq(articleUnits.unitId, bomComponents.unitId))
          )
          .leftJoin(routingOperations, eq(routingOperations.id, bomComponents.routingOperationId))
          .where(condition)
      );
      rows.sort(
        (a, b) =>
          byText(a.parentNumber, b.parentNumber) || a.createdAt.getTime() - b.createdAt.getTime() || byText(a.id, b.id)
      );
      return rows.map((row) => {
        const inRowUnit = row.rowUnitCode !== null && row.currentFactor !== null;
        return {
          parentNumber: row.parentNumber,
          componentNumber: row.componentNumber,
          quantity: Number(row.quantity),
          unitCode: inRowUnit ? row.rowUnitCode! : row.baseUnitCode,
          unitFactor: inRowUnit ? Number(row.currentFactor) : null,
          operationSequenceNo: row.operationSequenceNo,
          position: row.position,
          costingOnly: row.costingOnly,
          componentName: row.componentName,
          componentType: row.componentType,
          componentIsPhantom: row.componentIsPhantom,
          componentStandardCost: num(row.componentStandardCost),
        };
      });
    },

    async supplierPrices(articleIds: readonly string[] | null): Promise<SupplierPriceExportRecord[]> {
      const rows = await forArticles(articleIds, articleSuppliers.articleId, (condition) =>
        db
          .select({
            id: articleSuppliers.id,
            articleNumber: articles.articleNumber,
            supplierNumber: suppliers.supplierNumber,
            supplierArticleNumber: articleSuppliers.supplierArticleNumber,
            price: articleSuppliers.price,
            isPrimary: articleSuppliers.isPrimary,
            leadTimeDays: articleSuppliers.leadTimeDays,
          })
          .from(articleSuppliers)
          .innerJoin(articles, eq(articles.id, articleSuppliers.articleId))
          .innerJoin(suppliers, eq(suppliers.id, articleSuppliers.supplierId))
          .where(condition)
      );
      const breaks = new Map<string, { fromQuantity: number; price: number }[]>();
      const ids = rows.map((row) => row.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = await db
          .select({
            articleSupplierId: articleSupplierPriceBreaks.articleSupplierId,
            fromQuantity: articleSupplierPriceBreaks.fromQuantity,
            price: articleSupplierPriceBreaks.price,
          })
          .from(articleSupplierPriceBreaks)
          .where(inArray(articleSupplierPriceBreaks.articleSupplierId, ids.slice(i, i + CHUNK)));
        for (const step of part) {
          const list = breaks.get(step.articleSupplierId) ?? [];
          list.push({ fromQuantity: Number(step.fromQuantity), price: Number(step.price) });
          breaks.set(step.articleSupplierId, list);
        }
      }
      return rows
        .map(({ id, ...row }) => ({
          ...row,
          price: num(row.price),
          breaks: (breaks.get(id) ?? []).sort((a, b) => a.fromQuantity - b.fromQuantity),
        }))
        .sort((a, b) => byText(a.articleNumber, b.articleNumber) || byText(a.supplierNumber, b.supplierNumber));
    },

    // The article rules with a price (a rule that is only a discount is not
    // a value the import can carry) and Kundens artikelnummer, per pair.
    async customerPrices(articleIds: readonly string[] | null): Promise<CustomerPriceExportRecord[]> {
      const pairs = new Map<string, CustomerPriceExportRecord>();
      const pair = (articleNumber: string, customerNumber: string) => {
        const key = `${articleNumber}\u0000${customerNumber}`;
        let record = pairs.get(key);
        if (!record) {
          record = { articleNumber, customerNumber, customerArticleNumber: null, rules: [] };
          pairs.set(key, record);
        }
        return record;
      };
      const rules = await forArticles(articleIds, customerPrices.articleId, (condition) =>
        db
          .select({
            articleNumber: articles.articleNumber,
            customerNumber: customers.customerNumber,
            fromQuantity: customerPrices.fromQuantity,
            unitPrice: customerPrices.unitPrice,
            setupPrice: customerPrices.setupPrice,
          })
          .from(customerPrices)
          .innerJoin(articles, eq(articles.id, customerPrices.articleId))
          .innerJoin(customers, eq(customers.id, customerPrices.customerId))
          .where(and(isNotNull(customerPrices.unitPrice), condition))
      );
      for (const rule of rules) {
        pair(rule.articleNumber, rule.customerNumber).rules.push({
          fromQuantity: Number(rule.fromQuantity),
          unitPrice: Number(rule.unitPrice),
          setupPrice: num(rule.setupPrice),
        });
      }
      const numbers = await forArticles(articleIds, customerArticleNumbers.articleId, (condition) =>
        db
          .select({
            articleNumber: articles.articleNumber,
            customerNumber: customers.customerNumber,
            customerArticleNumber: customerArticleNumbers.customerArticleNumber,
          })
          .from(customerArticleNumbers)
          .innerJoin(articles, eq(articles.id, customerArticleNumbers.articleId))
          .innerJoin(customers, eq(customers.id, customerArticleNumbers.customerId))
          .where(condition)
      );
      for (const row of numbers) pair(row.articleNumber, row.customerNumber).customerArticleNumber = row.customerArticleNumber;
      return [...pairs.values()].sort(
        (a, b) => byText(a.articleNumber, b.articleNumber) || byText(a.customerNumber, b.customerNumber)
      );
    },

    // Today's balance per article and place — the stock log summed, like the
    // saldo import's own reading; a place where the article has none is no
    // row.
    async stockBalances(articleIds: readonly string[] | null): Promise<StockBalanceExportRecord[]> {
      const rows = await forArticles(articleIds, stockTransactions.articleId, (condition) =>
        db
          .select({
            articleNumber: articles.articleNumber,
            warehouseName: warehouses.name,
            locationName: stockLocations.name,
            quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
            // Batch (#8): a batchstyrd article is grouped per cell — the
            // batch number, or "Okänd" for the rows without a batch — so the
            // file reads back as the saldoimport's cell rows. Every other
            // article sums over whatever batches its log holds, as before.
            tracking: articles.tracking,
            batchNumber: stockBatches.batchNumber,
            batchDate: stockBatches.batchDate,
            expiresOn: stockBatches.expiresOn,
          })
          .from(stockTransactions)
          .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
          .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
          .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .leftJoin(stockBatches, and(eq(stockBatches.id, stockTransactions.batchId), ne(articles.tracking, "none")))
          .where(condition)
          .groupBy(
            articles.articleNumber,
            articles.tracking,
            warehouses.name,
            stockLocations.name,
            stockLocations.id,
            stockBatches.id,
            stockBatches.batchNumber,
            stockBatches.batchDate,
            stockBatches.expiresOn
          )
          .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`)
      );
      return rows
        .map(({ tracking, batchNumber, batchDate, expiresOn, ...row }) => ({
          ...row,
          quantity: Number(row.quantity),
          batchNumber: tracking !== "none" ? (batchNumber ?? UNKNOWN_BATCH_LABEL) : "",
          batchDate: batchDate ?? "",
          expiresOn: expiresOn ?? "",
        }))
        .sort(
          (a, b) =>
            byText(a.articleNumber, b.articleNumber) ||
            byText(a.warehouseName, b.warehouseName) ||
            byText(a.locationName, b.locationName) ||
            byText(a.batchNumber, b.batchNumber)
        );
    },

    async customers(activeOnly: boolean): Promise<CustomerExportRecord[]> {
      const [paymentTermText, deliveryTermText, carrierText, priceListText] = await Promise.all([
        registerTexts(db.select({ id: paymentTerms.id, code: paymentTerms.code, name: paymentTerms.name }).from(paymentTerms)),
        registerTexts(db.select({ id: deliveryTerms.id, code: deliveryTerms.code, name: deliveryTerms.name }).from(deliveryTerms)),
        registerTexts(db.select({ id: carriers.id, code: carriers.code, name: carriers.name }).from(carriers)),
        registerTexts(db.select({ id: priceLists.id, code: priceLists.code, name: priceLists.name }).from(priceLists)),
      ]);
      const rows = await db
        .select()
        .from(customers)
        .where(activeOnly ? eq(customers.active, true) : undefined);
      return rows
        .map((row) => ({
          customerNumber: row.customerNumber,
          name: row.name,
          orgNumber: row.orgNumber,
          vatNumber: row.vatNumber,
          contactName: row.contactName,
          email: row.email,
          phone: row.phone,
          address: row.address,
          postalCode: row.postalCode,
          city: row.city,
          country: row.country,
          paymentTerm: row.paymentTermId ? (paymentTermText.get(row.paymentTermId) ?? null) : null,
          deliveryTerm: row.deliveryTermId ? (deliveryTermText.get(row.deliveryTermId) ?? null) : null,
          carrier: row.carrierId ? (carrierText.get(row.carrierId) ?? null) : null,
          priceList: row.priceListId ? (priceListText.get(row.priceListId) ?? null) : null,
          discountPercent: Number(row.discountPercent),
          invoiceName: row.invoiceName,
          invoiceAddress: row.invoiceAddress,
          invoicePostalCode: row.invoicePostalCode,
          invoiceCity: row.invoiceCity,
          invoiceCountry: row.invoiceCountry,
          invoiceEmail: row.invoiceEmail,
          ourSupplierNumber: row.ourSupplierNumber,
          collectiveInvoicing: row.collectiveInvoicing,
          invoiceOnHold: row.invoiceOnHold,
          privatePerson: row.privatePerson,
          website: row.website,
          currency: row.currency,
          language: row.language,
        }))
        .sort((a, b) => byText(a.customerNumber, b.customerNumber));
    },

    async customerContacts(activeOnly: boolean): Promise<ContactExportRecord[]> {
      const rows = await db
        .select({
          partnerNumber: customers.customerNumber,
          name: customerContacts.name,
          isPrimary: customerContacts.isPrimary,
          phone: customerContacts.phone,
          mobile: customerContacts.mobile,
          email: customerContacts.email,
          comment: customerContacts.comment,
        })
        .from(customerContacts)
        .innerJoin(customers, eq(customers.id, customerContacts.customerId))
        .where(activeOnly ? eq(customers.active, true) : undefined)
        .orderBy(asc(customerContacts.createdAt), asc(customerContacts.id));
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => byText(a.row.partnerNumber, b.row.partnerNumber) || a.index - b.index)
        .map(({ row }) => row);
    },

    // The register's addresses — an order's one-off address is not one.
    async customerDeliveryAddresses(activeOnly: boolean): Promise<DeliveryAddressExportRecord[]> {
      const rows = await db
        .select({
          partnerNumber: customers.customerNumber,
          label: customerDeliveryAddresses.label,
          address: customerDeliveryAddresses.address,
          postalCode: customerDeliveryAddresses.postalCode,
          city: customerDeliveryAddresses.city,
          country: customerDeliveryAddresses.country,
          isDefault: customerDeliveryAddresses.isDefault,
        })
        .from(customerDeliveryAddresses)
        .innerJoin(customers, eq(customers.id, customerDeliveryAddresses.customerId))
        .where(and(eq(customerDeliveryAddresses.oneOff, false), activeOnly ? eq(customers.active, true) : undefined))
        .orderBy(asc(customerDeliveryAddresses.createdAt), asc(customerDeliveryAddresses.id));
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => byText(a.row.partnerNumber, b.row.partnerNumber) || a.index - b.index)
        .map(({ row }) => row);
    },

    async suppliers(activeOnly: boolean): Promise<SupplierExportRecord[]> {
      const [paymentTermText, deliveryTermText, carrierText] = await Promise.all([
        registerTexts(db.select({ id: paymentTerms.id, code: paymentTerms.code, name: paymentTerms.name }).from(paymentTerms)),
        registerTexts(db.select({ id: deliveryTerms.id, code: deliveryTerms.code, name: deliveryTerms.name }).from(deliveryTerms)),
        registerTexts(db.select({ id: carriers.id, code: carriers.code, name: carriers.name }).from(carriers)),
      ]);
      const rows = await db
        .select()
        .from(suppliers)
        .where(activeOnly ? eq(suppliers.active, true) : undefined);
      return rows
        .map((row) => ({
          supplierNumber: row.supplierNumber,
          name: row.name,
          orgNumber: row.orgNumber,
          vatNumber: row.vatNumber,
          contactName: row.contactName,
          email: row.email,
          phone: row.phone,
          address: row.address,
          postalCode: row.postalCode,
          city: row.city,
          country: row.country,
          currency: row.currency,
          language: row.language,
          ourCustomerNumber: row.ourCustomerNumber,
          paymentTerm: row.paymentTermId ? (paymentTermText.get(row.paymentTermId) ?? null) : null,
          deliveryTerm: row.deliveryTermId ? (deliveryTermText.get(row.deliveryTermId) ?? null) : null,
          carrier: row.carrierId ? (carrierText.get(row.carrierId) ?? null) : null,
          carrierCustomerNumber: row.carrierCustomerNumber,
        }))
        .sort((a, b) => byText(a.supplierNumber, b.supplierNumber));
    },

    async supplierContacts(activeOnly: boolean): Promise<ContactExportRecord[]> {
      const rows = await db
        .select({
          partnerNumber: suppliers.supplierNumber,
          name: supplierContacts.name,
          isPrimary: supplierContacts.isPrimary,
          phone: supplierContacts.phone,
          mobile: supplierContacts.mobile,
          email: supplierContacts.email,
          comment: supplierContacts.comment,
        })
        .from(supplierContacts)
        .innerJoin(suppliers, eq(suppliers.id, supplierContacts.supplierId))
        .where(activeOnly ? eq(suppliers.active, true) : undefined)
        .orderBy(asc(supplierContacts.createdAt), asc(supplierContacts.id));
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => byText(a.row.partnerNumber, b.row.partnerNumber) || a.index - b.index)
        .map(({ row }) => row);
    },

    async supplierDeliveryAddresses(activeOnly: boolean): Promise<DeliveryAddressExportRecord[]> {
      const rows = await db
        .select({
          partnerNumber: suppliers.supplierNumber,
          label: supplierDeliveryAddresses.label,
          address: supplierDeliveryAddresses.address,
          postalCode: supplierDeliveryAddresses.postalCode,
          city: supplierDeliveryAddresses.city,
        })
        .from(supplierDeliveryAddresses)
        .innerJoin(suppliers, eq(suppliers.id, supplierDeliveryAddresses.supplierId))
        .where(activeOnly ? eq(suppliers.active, true) : undefined)
        .orderBy(asc(supplierDeliveryAddresses.createdAt), asc(supplierDeliveryAddresses.id));
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => byText(a.row.partnerNumber, b.row.partnerNumber) || a.index - b.index)
        .map(({ row }) => row);
    },

    // Machines and personnel — a legoresurs is the Legoresurser file's.
    async workCenters(activeOnly: boolean): Promise<WorkCenterExportRecord[]> {
      const rows = await db
        .select({
          code: workCenters.code,
          name: workCenters.name,
          type: workCenters.type,
          productionGroupCode: productionGroups.code,
          productionGroupName: productionGroups.name,
          hourlyRate: workCenters.hourlyRate,
          calcRate1: workCenters.calcRate1,
          calcRate2: workCenters.calcRate2,
          rateAppliesToSetup: workCenters.rateAppliesToSetup,
          rateAppliesToRun: workCenters.rateAppliesToRun,
          defaultSetupTime: workCenters.defaultSetupTime,
          defaultOperationName: workCenters.defaultOperationName,
        })
        .from(workCenters)
        .leftJoin(productionGroups, eq(productionGroups.id, workCenters.productionGroupId))
        .where(and(ne(workCenters.type, "subcontract"), activeOnly ? eq(workCenters.active, true) : undefined))
        .orderBy(asc(workCenters.code));
      return rows.map((row) => ({
        ...row,
        type: row.type === "personnel" ? "personnel" : "machine",
        hourlyRate: Number(row.hourlyRate),
        calcRate1: num(row.calcRate1),
        calcRate2: num(row.calcRate2),
        defaultSetupTime: num(row.defaultSetupTime),
      }));
    },

    async legoWorkCenters(activeOnly: boolean): Promise<LegoWorkCenterExportRecord[]> {
      const rows = await db
        .select({
          code: workCenters.code,
          name: workCenters.name,
          supplierNumber: suppliers.supplierNumber,
          leadTimeDays: workCenters.leadTimeDays,
          queueTimeDays: workCenters.queueTimeDays,
          orderLeadTimeDays: workCenters.orderLeadTimeDays,
        })
        .from(workCenters)
        .leftJoin(suppliers, eq(suppliers.id, workCenters.supplierId))
        .where(and(eq(workCenters.type, "subcontract"), activeOnly ? eq(workCenters.active, true) : undefined))
        .orderBy(asc(workCenters.code));
      return rows.map((row) => ({
        ...row,
        leadTimeDays: num(row.leadTimeDays),
        queueTimeDays: num(row.queueTimeDays),
        orderLeadTimeDays: num(row.orderLeadTimeDays),
      }));
    },

    async productionGroups(activeOnly: boolean): Promise<ProductionGroupExportRecord[]> {
      const rows = await db
        .select({ code: productionGroups.code, name: productionGroups.name, description: productionGroups.description })
        .from(productionGroups)
        .where(activeOnly ? eq(productionGroups.active, true) : undefined);
      return rows.sort((a, b) => byText(a.code, b.code));
    },
  };
}

export type ImportExportRepository = ReturnType<typeof createImportExportRepository>;
