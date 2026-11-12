// GET /imports/:entity/export (#35): reads the register and renders it as
// the entity's import file. The row rules are import-export.ts (pure), the
// reads import-export.repository.ts; the article selection is resolved by
// the article register itself (ArticleSelectionReader — ArticleService's
// selectArticleIds, the register's own where).
import {
  IMPORT_ENTITY_ORDER,
  IMPORT_EXPORT_MAX_ROWS,
  type ImportEntity,
  type ImportExportArticleSelection,
  type ImportExportQuery,
} from "@navet/shared";
import { stockholmToday } from "../../system/service/delivery-days.js";
import type { ImportExportRepository } from "../repository/import-export.repository.js";
import {
  articleExportBlocks,
  articleUnitExportBlocks,
  bomExportBlocks,
  contactExportBlocks,
  customerExportBlocks,
  customerPriceExportBlocks,
  deliveryAddressExportBlocks,
  legoWorkCenterExportBlocks,
  productionGroupExportBlocks,
  renderImportExport,
  routingExportBlocks,
  stockBalanceExportBlocks,
  supplierExportBlocks,
  supplierPriceExportBlocks,
  workCenterExportBlocks,
  type ImportExportBlock,
  type ImportExportFile,
} from "./import-export.js";

export interface ArticleSelectionReader {
  // null = no selection (every article); otherwise the selected ids.
  selectArticleIds(selection: ImportExportArticleSelection, userId: string | undefined): Promise<string[] | null>;
}

export interface ImportExportServiceOptions {
  // Rows per file before the export is split — the import's own row limit.
  // Lowered by tests only.
  maxRows?: number;
}

// The entities whose rows belong to articles and follow the article
// selection: the article page's seven tabs.
export function isArticleBoundExport(entity: ImportEntity): boolean {
  return IMPORT_ENTITY_ORDER.includes(entity);
}

export function createImportExportService(
  repo: ImportExportRepository,
  articles: ArticleSelectionReader,
  options: ImportExportServiceOptions = {}
) {
  async function blocks(entity: ImportEntity, query: ImportExportQuery, userId: string | undefined): Promise<ImportExportBlock[]> {
    const activeOnly = query.activeOnly === true;
    const articleIds = isArticleBoundExport(entity)
      ? await articles.selectArticleIds(
          {
            copied: query.copied,
            articleNumberFrom: query.articleNumberFrom,
            articleNumberTo: query.articleNumberTo,
            groupId: query.groupId,
            type: query.type,
            activeOnly,
          },
          userId
        )
      : null;
    switch (entity) {
      case "articles":
        return articleExportBlocks(await repo.articles(articleIds));
      case "articleUnits":
        return articleUnitExportBlocks(await repo.articleUnits(articleIds));
      case "routing":
        return routingExportBlocks(await repo.routing(articleIds));
      case "bom":
        return bomExportBlocks(await repo.bom(articleIds));
      case "supplierPrices":
        return supplierPriceExportBlocks(await repo.supplierPrices(articleIds));
      case "customerPrices":
        return customerPriceExportBlocks(await repo.customerPrices(articleIds));
      case "stockBalances":
        return stockBalanceExportBlocks(await repo.stockBalances(articleIds));
      // The partner and resource registers: the whole register, or its
      // active rows (a contact or address follows its customer/supplier).
      case "customers":
        return customerExportBlocks(await repo.customers(activeOnly));
      case "customerContacts":
        return contactExportBlocks(await repo.customerContacts(activeOnly), "customerNumber");
      case "customerDeliveryAddresses":
        return deliveryAddressExportBlocks(await repo.customerDeliveryAddresses(activeOnly), "customerNumber");
      case "suppliers":
        return supplierExportBlocks(await repo.suppliers(activeOnly));
      case "supplierContacts":
        return contactExportBlocks(await repo.supplierContacts(activeOnly), "supplierNumber");
      case "supplierDeliveryAddresses":
        return deliveryAddressExportBlocks(await repo.supplierDeliveryAddresses(activeOnly), "supplierNumber");
      case "workCenters":
        return workCenterExportBlocks(await repo.workCenters(activeOnly));
      case "legoWorkCenters":
        return legoWorkCenterExportBlocks(await repo.legoWorkCenters(activeOnly));
      case "productionGroups":
        return productionGroupExportBlocks(await repo.productionGroups(activeOnly));
    }
  }

  return {
    // One file, or a .zip of files of at most maxRows rows each (never
    // splitting an article's rows) — see renderImportExport.
    async exportFile(entity: ImportEntity, query: ImportExportQuery, userId?: string): Promise<ImportExportFile> {
      return renderImportExport(
        entity,
        await blocks(entity, query, userId),
        query.format,
        stockholmToday(),
        options.maxRows ?? IMPORT_EXPORT_MAX_ROWS
      );
    },
  };
}

export type ImportExportService = ReturnType<typeof createImportExportService>;
