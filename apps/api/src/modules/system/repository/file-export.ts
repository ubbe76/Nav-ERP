import { asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  articleFiles,
  articles,
  bankFiles,
  companyInfo,
  deviationFiles,
  deviations,
  einvoiceTransmissions,
  fiscalYears,
  invoiceDocuments,
  invoices,
  invoiceScans,
  routingOperationFiles,
  routingOperations,
  shipmentFiles,
  shipments,
  supplierInvoiceFiles,
  supplierInvoices,
  verificationFiles,
  verifications,
  verificationSeries,
  type Db,
} from "@navet/db";

// Exportera filer (System → Säkerhetskopiering): every stored file, kind by
// kind, under a folder a person recognises — the article number, the
// deviation's AV number, the verification's series-year-number and so on.
// The keys are STORED_FILE_KINDS' (storage.ts); system-storage.test.ts keeps
// the two lists the same. Metadata is listed first (never the bytes), then
// the bytes are read a few rows at a time, so memory stays bounded however
// many files there are. A file deleted between the two reads is skipped.

export interface ExportedFile {
  folder: string[];
  filename: string;
  modified: Date;
  data: Buffer;
}

interface FileMeta {
  id: string;
  folder: string[];
  filename: string;
  modified: Date;
}

interface ExportKind {
  key: string;
  list(db: Db): Promise<FileMeta[]>;
  data(db: Db, ids: string[]): Promise<{ id: string; data: Buffer | null }[]>;
}

const BATCH = 10;

const BANK_DIRECTION: Record<string, string> = { outgoing: "Utgående", incoming: "Inkommande" };
const LOGO_EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp" };

export const FILE_EXPORT_KINDS: ExportKind[] = [
  {
    key: "articleFiles",
    async list(db) {
      const rows = await db
        .select({ id: articleFiles.id, number: articles.articleNumber, filename: articleFiles.filename, modified: articleFiles.createdAt })
        .from(articleFiles)
        .innerJoin(articles, eq(articles.id, articleFiles.articleId))
        .orderBy(asc(articles.articleNumber), asc(articleFiles.createdAt));
      return rows.map((r) => ({ id: r.id, folder: ["Artikelfiler", r.number], filename: r.filename, modified: r.modified }));
    },
    data: (db, ids) => db.select({ id: articleFiles.id, data: articleFiles.data }).from(articleFiles).where(inArray(articleFiles.id, ids)),
  },
  {
    key: "routingOperationFiles",
    async list(db) {
      const rows = await db
        .select({
          id: routingOperationFiles.id,
          number: articles.articleNumber,
          sequenceNo: routingOperations.sequenceNo,
          filename: routingOperationFiles.filename,
          modified: routingOperationFiles.createdAt,
        })
        .from(routingOperationFiles)
        .innerJoin(routingOperations, eq(routingOperations.id, routingOperationFiles.routingOperationId))
        .innerJoin(articles, eq(articles.id, routingOperations.articleId))
        .orderBy(asc(articles.articleNumber), asc(routingOperations.sequenceNo));
      return rows.map((r) => ({
        id: r.id,
        folder: ["Operationer", r.number, `Op ${r.sequenceNo}`],
        filename: r.filename,
        modified: r.modified,
      }));
    },
    data: (db, ids) =>
      db.select({ id: routingOperationFiles.id, data: routingOperationFiles.data }).from(routingOperationFiles).where(inArray(routingOperationFiles.id, ids)),
  },
  {
    key: "deviationFiles",
    async list(db) {
      const rows = await db
        .select({ id: deviationFiles.id, number: deviations.deviationNumber, filename: deviationFiles.filename, modified: deviationFiles.createdAt })
        .from(deviationFiles)
        .innerJoin(deviations, eq(deviations.id, deviationFiles.deviationId))
        .orderBy(asc(deviations.deviationNumber), asc(deviationFiles.createdAt));
      return rows.map((r) => ({ id: r.id, folder: ["Avvikelser", r.number], filename: r.filename, modified: r.modified }));
    },
    data: (db, ids) => db.select({ id: deviationFiles.id, data: deviationFiles.data }).from(deviationFiles).where(inArray(deviationFiles.id, ids)),
  },
  {
    key: "supplierInvoiceFiles",
    async list(db) {
      const rows = await db
        .select({
          id: supplierInvoiceFiles.id,
          number: supplierInvoices.registrationNumber,
          filename: supplierInvoiceFiles.filename,
          modified: supplierInvoiceFiles.createdAt,
        })
        .from(supplierInvoiceFiles)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceFiles.supplierInvoiceId))
        .orderBy(asc(supplierInvoices.registrationNumber), asc(supplierInvoiceFiles.createdAt));
      return rows.map((r) => ({ id: r.id, folder: ["Leverantörsfakturor", r.number], filename: r.filename, modified: r.modified }));
    },
    data: (db, ids) =>
      db.select({ id: supplierInvoiceFiles.id, data: supplierInvoiceFiles.data }).from(supplierInvoiceFiles).where(inArray(supplierInvoiceFiles.id, ids)),
  },
  {
    key: "invoiceScans",
    // A converted scan hands its bytes to the supplier invoice (data = null).
    async list(db) {
      const rows = await db
        .select({ id: invoiceScans.id, number: invoiceScans.scanNumber, filename: invoiceScans.filename, modified: invoiceScans.createdAt })
        .from(invoiceScans)
        .where(isNotNull(invoiceScans.data))
        .orderBy(asc(invoiceScans.scanNumber));
      return rows.map((r) => ({ id: r.id, folder: ["Fakturainkorgen", r.number], filename: r.filename, modified: r.modified }));
    },
    data: (db, ids) => db.select({ id: invoiceScans.id, data: invoiceScans.data }).from(invoiceScans).where(inArray(invoiceScans.id, ids)),
  },
  {
    key: "verificationFiles",
    async list(db) {
      const rows = await db
        .select({
          id: verificationFiles.id,
          verificationId: verifications.id,
          series: verificationSeries.code,
          year: fiscalYears.label,
          number: verifications.verificationNumber,
          filename: verificationFiles.filename,
          modified: verificationFiles.createdAt,
        })
        .from(verificationFiles)
        .innerJoin(verifications, eq(verifications.id, verificationFiles.verificationId))
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .orderBy(asc(verificationSeries.code), asc(fiscalYears.label), asc(verifications.verificationNumber));
      return rows.map((r) => ({
        id: r.id,
        // Same display number as the verification card; a draft has none yet.
        folder: ["Verifikat", r.number === null ? `${r.series}-${r.year}-utkast-${r.verificationId.slice(0, 8)}` : `${r.series}-${r.year}-${r.number}`],
        filename: r.filename,
        modified: r.modified,
      }));
    },
    data: (db, ids) => db.select({ id: verificationFiles.id, data: verificationFiles.data }).from(verificationFiles).where(inArray(verificationFiles.id, ids)),
  },
  {
    key: "invoiceDocuments",
    async list(db) {
      const rows = await db
        .select({
          id: invoiceDocuments.id,
          invoiceId: invoices.id,
          number: invoices.invoiceNumber,
          filename: invoiceDocuments.filename,
          modified: invoiceDocuments.createdAt,
        })
        .from(invoiceDocuments)
        .innerJoin(invoices, eq(invoices.id, invoiceDocuments.invoiceId))
        .orderBy(asc(invoices.invoiceNumber), asc(invoiceDocuments.createdAt));
      return rows.map((r) => ({
        id: r.id,
        folder: ["Kundfakturor", r.number ?? `utkast-${r.invoiceId.slice(0, 8)}`],
        filename: r.filename,
        modified: r.modified,
      }));
    },
    data: (db, ids) => db.select({ id: invoiceDocuments.id, data: invoiceDocuments.data }).from(invoiceDocuments).where(inArray(invoiceDocuments.id, ids)),
  },
  {
    key: "einvoiceTransmissions",
    async list(db) {
      const rows = await db
        .select({
          id: einvoiceTransmissions.id,
          invoiceId: invoices.id,
          number: invoices.invoiceNumber,
          started: einvoiceTransmissions.startedAt,
        })
        .from(einvoiceTransmissions)
        .innerJoin(invoices, eq(invoices.id, einvoiceTransmissions.invoiceId))
        .orderBy(asc(invoices.invoiceNumber), asc(einvoiceTransmissions.startedAt));
      return rows.map((r) => {
        const number = r.number ?? r.invoiceId.slice(0, 8);
        return { id: r.id, folder: ["E-fakturor", number], filename: `${number}.xml`, modified: r.started };
      });
    },
    data: (db, ids) =>
      db.select({ id: einvoiceTransmissions.id, data: einvoiceTransmissions.document }).from(einvoiceTransmissions).where(inArray(einvoiceTransmissions.id, ids)),
  },
  {
    key: "shipmentFiles",
    async list(db) {
      const rows = await db
        .select({ id: shipmentFiles.id, number: shipments.shipmentNumber, filename: shipmentFiles.filename, modified: shipmentFiles.createdAt })
        .from(shipmentFiles)
        .innerJoin(shipments, eq(shipments.id, shipmentFiles.shipmentId))
        .orderBy(asc(shipments.shipmentNumber), asc(shipmentFiles.createdAt));
      return rows.map((r) => ({ id: r.id, folder: ["Fraktsedlar", r.number], filename: r.filename, modified: r.modified }));
    },
    data: (db, ids) => db.select({ id: shipmentFiles.id, data: shipmentFiles.data }).from(shipmentFiles).where(inArray(shipmentFiles.id, ids)),
  },
  {
    key: "bankFiles",
    async list(db) {
      const rows = await db
        .select({ id: bankFiles.id, direction: bankFiles.direction, filename: bankFiles.filename, modified: bankFiles.createdAt })
        .from(bankFiles)
        .orderBy(asc(bankFiles.direction), asc(bankFiles.createdAt));
      return rows.map((r) => ({
        id: r.id,
        folder: ["Bankfiler", BANK_DIRECTION[r.direction] ?? r.direction],
        filename: r.filename,
        modified: r.modified,
      }));
    },
    data: (db, ids) => db.select({ id: bankFiles.id, data: bankFiles.data }).from(bankFiles).where(inArray(bankFiles.id, ids)),
  },
  {
    key: "companyLogo",
    // The singleton row; its id stands in as the file id.
    async list(db) {
      const rows = await db
        .select({ id: companyInfo.id, contentType: companyInfo.logoContentType, modified: companyInfo.updatedAt })
        .from(companyInfo)
        .where(isNotNull(companyInfo.logo));
      return rows.map((r) => ({
        id: r.id,
        folder: ["Logotyp"],
        filename: `logotyp.${LOGO_EXTENSION[r.contentType ?? ""] ?? "bin"}`,
        modified: r.modified,
      }));
    },
    data: (db, ids) =>
      db.select({ id: companyInfo.id, data: companyInfo.logo }).from(companyInfo).where(inArray(companyInfo.id, ids)),
  },
];

export async function* exportStoredFiles(db: Db): AsyncGenerator<ExportedFile> {
  for (const kind of FILE_EXPORT_KINDS) {
    const metas = await kind.list(db);
    for (let i = 0; i < metas.length; i += BATCH) {
      const batch = metas.slice(i, i + BATCH);
      const rows = await kind.data(db, batch.map((m) => m.id));
      const byId = new Map(rows.map((r) => [r.id, r.data]));
      for (const meta of batch) {
        const data = byId.get(meta.id);
        if (!data) continue;
        yield { folder: meta.folder, filename: meta.filename, modified: meta.modified, data };
      }
    }
  }
}
