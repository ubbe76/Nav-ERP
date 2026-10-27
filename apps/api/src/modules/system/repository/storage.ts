import { sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  articleFiles,
  bankFiles,
  companyInfo,
  deviationFiles,
  einvoiceTransmissions,
  invoiceDocuments,
  invoiceScans,
  routingOperationFiles,
  shipmentFiles,
  supplierInvoiceFiles,
  verificationFiles,
  type Db,
} from "@navet/db";

// Lagringsutrymme (System → Säkerhetskopiering): every uploaded or archived
// file lives in a bytea column, so this list is the one place that knows
// them. A new bytea column for files belongs here too.
// octet_length on a TOASTed bytea reads the stored length from the TOAST
// pointer, so the sum never fetches the file contents. Keys are constants
// (sql.raw below), never user input.
interface StoredFileKind {
  key: string;
  label: string;
  table: PgTable;
  column: PgColumn;
}

export const STORED_FILE_KINDS: StoredFileKind[] = [
  { key: "articleFiles", label: "Artikelfiler och ritningar", table: articleFiles, column: articleFiles.data },
  { key: "routingOperationFiles", label: "Filer på operationer", table: routingOperationFiles, column: routingOperationFiles.data },
  { key: "deviationFiles", label: "Bilder och filer på avvikelser", table: deviationFiles, column: deviationFiles.data },
  { key: "supplierInvoiceFiles", label: "Underlag på leverantörsfakturor", table: supplierInvoiceFiles, column: supplierInvoiceFiles.data },
  { key: "invoiceScans", label: "Fakturainkorgen", table: invoiceScans, column: invoiceScans.data },
  { key: "verificationFiles", label: "Underlag på verifikat", table: verificationFiles, column: verificationFiles.data },
  { key: "invoiceDocuments", label: "Arkiverade kundfakturor", table: invoiceDocuments, column: invoiceDocuments.data },
  { key: "einvoiceTransmissions", label: "Skickade e-fakturor", table: einvoiceTransmissions, column: einvoiceTransmissions.document },
  { key: "shipmentFiles", label: "Fraktsedlar och etiketter", table: shipmentFiles, column: shipmentFiles.data },
  { key: "bankFiles", label: "Bankfiler", table: bankFiles, column: bankFiles.data },
  { key: "companyLogo", label: "Företagslogotyp", table: companyInfo, column: companyInfo.logo },
];

export interface StorageUsage {
  databaseBytes: number;
  filesBytes: number;
  kinds: { key: string; label: string; count: number; bytes: number }[];
}

export async function readStorageUsage(db: Db): Promise<StorageUsage> {
  const parts: SQL[] = STORED_FILE_KINDS.map(
    (k) =>
      sql`select ${sql.raw(`'${k.key}'`)}::text as key, count(${k.column})::int as count, coalesce(sum(octet_length(${k.column})), 0)::bigint as bytes from ${k.table}`
  );
  const rows = (await db.execute(sql.join(parts, sql` union all `))) as unknown as { key: string; count: number; bytes: string }[];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const kinds = STORED_FILE_KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    count: Number(byKey.get(k.key)?.count ?? 0),
    bytes: Number(byKey.get(k.key)?.bytes ?? 0),
  }));
  const [size] = (await db.execute(sql`select pg_database_size(current_database())::bigint as bytes`)) as unknown as { bytes: string }[];
  return {
    databaseBytes: Number(size!.bytes),
    filesBytes: kinds.reduce((sum, k) => sum + k.bytes, 0),
    kinds,
  };
}
