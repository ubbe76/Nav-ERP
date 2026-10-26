"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { confirmDelete } from "../../lib/confirm";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { FormError, FormHint } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { UNDERLAG_ACCEPT, uploadUnderlag } from "../documents/UnderlagSection";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDateTime } from "../../lib/date";
import type { DeviationFile } from "../../lib/quality";
import styles from "./Deviations.module.css";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Bilder och filer: photos of damaged goods, the customer's complaint as PDF.
// Not räkenskapsinformation — a file can be removed while the case is open.
// Fota opens the phone's camera (capture="environment"); on a computer it is
// an ordinary image picker.
export function DeviationFilesSection({
  deviationId,
  files,
  canEdit,
  editable,
}: {
  deviationId: string;
  files: DeviationFile[];
  // The user may write and the case is open.
  canEdit: boolean;
  // The case is open (closed/cancelled cases explain why files are locked).
  editable: boolean;
}) {
  const router = useRouter();
  const filesUrl = `/api/v1/deviations/${deviationId}/files`;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  async function upload(list: FileList) {
    setError(null);
    setPending(true);
    try {
      for (const file of Array.from(list)) await uploadUnderlag(filesUrl, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uppladdningen misslyckades");
    } finally {
      setPending(false);
      if (pickRef.current) pickRef.current.value = "";
      if (cameraRef.current) cameraRef.current.value = "";
      router.refresh();
    }
  }

  async function remove(file: DeviationFile) {
    if (!(await confirmDelete(`Ta bort ${file.filename}?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`${filesUrl}/${file.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort filen"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.section}>
      <SectionHeading>Bilder och filer</SectionHeading>
      <FormHint>
        {editable
          ? "Foton och dokument till avvikelsen — PDF, JPEG eller PNG, max 20 MB. Filerna kan tas bort så länge avvikelsen är öppen."
          : "Avvikelsen är avslutad eller makulerad — öppna den igen för att lägga till eller ta bort filer."}
      </FormHint>

      {canEdit && (
        <div className={styles.uploadRow}>
          <input
            ref={pickRef}
            type="file"
            multiple
            accept={UNDERLAG_ACCEPT}
            aria-label="Ladda upp filer"
            disabled={pending}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void upload(e.target.files);
            }}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className={styles.hiddenInput}
            aria-label="Fota"
            disabled={pending}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void upload(e.target.files);
            }}
          />
          <Button type="button" variant="secondary" disabled={pending} onClick={() => cameraRef.current?.click()}>
            Fota
          </Button>
          {pending && <span>Laddar upp…</span>}
        </div>
      )}
      <FormError>{error}</FormError>

      {files.length > 0 ? (
        <Table<DeviationFile>
          columns={[
            { key: "filename", label: "Filnamn", width: "minmax(160px, 1fr)" },
            { key: "sizeBytes", label: "Storlek", width: "90px", align: "right" },
            { key: "createdAt", label: "Uppladdad", width: "150px" },
            ...(canEdit ? [{ key: "id", label: "", width: "100px", align: "right" as const }] : []),
          ]}
          rows={files}
          renderCell={(file, key) => {
            switch (key) {
              case "filename":
                return (
                  <a
                    href={`${API_URL}${filesUrl}/${file.id}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`SHA-256 ${file.sha256}`}
                    className={styles.photoLink}
                  >
                    {file.filename}
                  </a>
                );
              case "sizeBytes":
                return formatSize(file.sizeBytes);
              case "createdAt":
                return formatStockholmDateTime(file.createdAt);
              case "id":
                return (
                  <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => remove(file)}>
                    Ta bort
                  </Button>
                );
              default:
                return null;
            }
          }}
        />
      ) : (
        <p>Inga filer uppladdade.</p>
      )}
    </div>
  );
}
