"use client";

import { useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { GatedLink } from "../ui/GatedLink";
import { FormError } from "../ui/Form";
import { ListFilterSelect, ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { useCan } from "../PermissionsProvider";
import { API_URL } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { formatStockholmDate } from "../../lib/date";
import {
  INVOICE_SCAN_ACCEPT,
  INVOICE_SCAN_MAX_FILES_PER_UPLOAD,
  INVOICE_SCAN_SOURCE_LABELS,
  INVOICE_SCAN_TABS,
  invoiceScanDisplayStatus,
  type InvoiceScanListRow,
  type InvoiceScanListStatus,
  type InvoiceScanUploadResult,
} from "../../lib/invoiceScan";
import type { Paged } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "./InvoiceInboxPageClient.module.css";

const STATUS_WORDS: Record<string, string> = {
  new: "Ny",
  interpreted: "Tolkad",
  converted: "Skapad",
  rejected: "Avvisad",
};

// Multipart upload — apiFetch sets a JSON content type, so this goes through
// fetch directly (like uploadUnderlag). The API answers 201 when something was
// created and 200 when everything was a duplicate or rejected.
async function uploadScans(files: File[]): Promise<InvoiceScanUploadResult> {
  const body = new FormData();
  for (const file of files) body.append("file", file);
  const res = await fetch(`${API_URL}/api/v1/invoice-scans`, { method: "POST", credentials: "include", body });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error ?? "Uppladdningen misslyckades");
  return payload as InvoiceScanUploadResult;
}

export function InvoiceInboxPageClient({ scans, pageSize }: { scans: Paged<InvoiceScanListRow>; pageSize: number }) {
  const router = useRouter();
  const can = useCan();
  const canWrite = can(["inkop"]);
  const { params, setFilter } = useListNavigation();
  const tab = (params.get("status") ?? "pending") as InvoiceScanListStatus;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceScanUploadResult | null>(null);

  async function upload(list: File[]) {
    if (list.length === 0) return;
    setUploadError(null);
    setResult(null);
    if (list.length > INVOICE_SCAN_MAX_FILES_PER_UPLOAD) {
      setUploadError(`Högst ${INVOICE_SCAN_MAX_FILES_PER_UPLOAD} filer per uppladdning`);
      return;
    }
    setUploading(true);
    try {
      setResult(await uploadScans(list));
      router.refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Uppladdningen misslyckades");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    if (!canWrite || uploading) return;
    void upload(Array.from(e.dataTransfer.files));
  }

  const waiting = tab === "pending";

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Fakturainkorg</div>
          <div className={shellStyles.meta}>
            {scans.total.toLocaleString("sv-SE")} {scans.total === 1 ? "faktura" : "fakturor"}
            {waiting ? " att granska" : ""}
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <HelpLink chapter="inkop" anchor="fakturainkorg" label="Hjälp om fakturainkorgen" />
        </div>
      </div>

      {canWrite && (
        <div
          className={styles.dropZone}
          data-over={over}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <div className={styles.dropText}>
            <strong>Dra och släpp leverantörsfakturor här</strong>, eller välj filer. PDF, JPEG eller PNG, max 20 MB per
            fil och högst {INVOICE_SCAN_MAX_FILES_PER_UPLOAD} åt gången.
          </div>
          <div className={styles.dropActions}>
            <Button type="button" variant="primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? "Laddar upp…" : "Ladda upp filer"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className={styles.photoButton}
              disabled={uploading}
              onClick={() => photoInputRef.current?.click()}
            >
              Fota faktura
            </Button>
          </div>
          <input
            ref={fileInputRef}
            className={styles.hiddenInput}
            type="file"
            multiple
            accept={INVOICE_SCAN_ACCEPT}
            aria-label="Välj fakturor att ladda upp"
            onChange={(e) => void upload(Array.from(e.target.files ?? []))}
          />
          <input
            ref={photoInputRef}
            className={styles.hiddenInput}
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Fota faktura"
            onChange={(e) => void upload(Array.from(e.target.files ?? []))}
          />
        </div>
      )}

      <FormError>{uploadError}</FormError>
      {result && (
        <div className={styles.results} role="status">
          {result.created.length > 0 && (
            <div className={styles.resultLine}>
              {result.created.length === 1 ? "1 fil lästes in" : `${result.created.length} filer lästes in`}:{" "}
              {result.created.map((scan, i) => (
                <span key={scan.id}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/inkop/fakturainkorg/${scan.id}`}>{scan.scanNumber}</Link>
                </span>
              ))}
              . Öppna en post för att granska förslaget.
            </div>
          )}
          {result.duplicates.map((dup) => (
            <div key={dup.filename} className={styles.resultLine}>
              {dup.filename} finns redan i inkorgen som{" "}
              <Link href={`/inkop/fakturainkorg/${dup.existing.id}`}>{dup.existing.scanNumber}</Link> (
              {STATUS_WORDS[dup.existing.status] ?? dup.existing.status}).
            </div>
          ))}
          {result.rejected.map((rej) => (
            <div key={rej.filename} className={styles.resultLine}>
              {rej.filename} lästes inte in: {rej.reason}
            </div>
          ))}
        </div>
      )}

      <div className={styles.tabStrip} role="tablist" aria-label="Visa fakturor">
        {INVOICE_SCAN_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={t.value === tab}
            className={styles.tab}
            data-active={t.value === tab}
            onClick={() => void setFilter("status", t.value === "pending" ? null : t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ListToolbar placeholder="Sök fil, FI-nummer, avsändare, leverantör eller fakturanummer…">
        <ListFilterSelect
          param="source"
          allLabel="Alla källor"
          ariaLabel="Filtrera på källa"
          options={Object.entries(INVOICE_SCAN_SOURCE_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </ListToolbar>

      <Table<InvoiceScanListRow>
        columns={[
          { key: "scanNumber", label: "Nr", width: "90px" },
          { key: "received", label: "Inkommen", width: "110px" },
          { key: "source", label: "Källa", width: "minmax(0, 1fr)" },
          { key: "filename", label: "Fil", width: "minmax(0, 1.2fr)" },
          { key: "supplierName", label: "Leverantör", width: "minmax(0, 1.2fr)" },
          { key: "invoiceNumber", label: "Fakturanr", width: "120px" },
          { key: "grossAmount", label: "Att betala", width: "130px", align: "right" },
          { key: "status", label: "Status", width: "minmax(130px, 1fr)" },
        ]}
        rows={scans.rows}
        emptyText={
          waiting ? "Inga fakturor att granska — ladda upp en faktura ovan" : "Inga fakturor matchar sökningen"
        }
        renderCell={(scan, key) => {
          switch (key) {
            case "scanNumber":
              return (
                <Link href={`/inkop/fakturainkorg/${scan.id}`} className={styles.rowLink}>
                  {scan.scanNumber}
                </Link>
              );
            case "received":
              return formatStockholmDate(scan.emailReceivedAt ?? scan.createdAt);
            case "source":
              return (
                <span className={styles.ellipsis} title={scan.emailFrom ?? undefined}>
                  {INVOICE_SCAN_SOURCE_LABELS[scan.source]}
                  {scan.source === "email" && scan.emailFrom ? ` · ${scan.emailFrom}` : ""}
                </span>
              );
            case "filename":
              return (
                <Link href={`/inkop/fakturainkorg/${scan.id}`} className={`${styles.rowLink} ${styles.ellipsis}`} title={scan.filename}>
                  {scan.filename}
                </Link>
              );
            case "supplierName":
              return scan.supplierName ?? <span className={styles.muted}>–</span>;
            case "invoiceNumber":
              return scan.invoiceNumber ?? <span className={styles.muted}>–</span>;
            case "grossAmount":
              return scan.grossAmount === null ? (
                <span className={styles.muted}>–</span>
              ) : (
                `${formatMoney(scan.grossAmount)}${scan.currency ? ` ${scan.currency}` : ""}`
              );
            case "status": {
              const pill = invoiceScanDisplayStatus(scan);
              return (
                <span className={styles.statusCell}>
                  <StatusPill status={pill.status} label={pill.label} compact />
                  {scan.status === "converted" && scan.supplierInvoiceId && (
                    <GatedLink href={`/inkop/leverantorsfakturor/${scan.supplierInvoiceId}`}>
                      {scan.supplierInvoiceRegistrationNumber ?? "Visa faktura"}
                    </GatedLink>
                  )}
                </span>
              );
            }
            default:
              return null;
          }
        }}
      />

      <Pagination total={scans.total} pageSize={pageSize} />
    </>
  );
}
