"use client";

import { confirmDelete } from "../../lib/confirm";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { FormError, FormHint } from "../ui/Form";
import { API_URL, apiFetch } from "../../lib/api";

// Same shape for every underlag table (supplier_invoice_files,
// verification_files) — the listing never carries the bytes.
export interface UnderlagFile {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export const UNDERLAG_ACCEPT = ".pdf,.jpg,.jpeg,.png";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Multipart upload — apiFetch sets a JSON content type, so this goes through
// fetch directly (same as the article files and the company logo). filesUrl
// is the document's file collection, e.g. `/api/v1/verifications/{id}/files`.
export async function uploadUnderlag(filesUrl: string, file: File): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${API_URL}${filesUrl}`, { method: "POST", credentials: "include", body });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? `Kunde inte ladda upp ${file.name}`);
  }
}

// Underlag (räkenskapsinformation) on a document card — the supplier
// invoice and the verifikat. Adding is always possible (a late second page,
// a forgotten kvitto); Ta bort only while the document is unlocked — after
// attest/bokföring the server refuses (409) anyway. lockedBy names that
// event in the hint ("attest", "bokföring").
export function UnderlagSection({
  filesUrl,
  files,
  removable,
  lockedBy,
  description,
  initialError,
}: {
  filesUrl: string;
  files: UnderlagFile[];
  removable: boolean;
  lockedBy: string;
  description: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(list: FileList) {
    setError(null);
    setPending(true);
    try {
      for (const file of Array.from(list)) await uploadUnderlag(filesUrl, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uppladdningen misslyckades");
    } finally {
      setPending(false);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    }
  }

  async function remove(file: UnderlagFile) {
    if (!(await confirmDelete(`Ta bort ${file.filename}?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`${filesUrl}/${file.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort filen");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <SectionHeading spaced>Underlag</SectionHeading>
      <FormHint>
        {description} PDF eller inskannad bild (JPEG/PNG, max 20 MB). Underlaget är räkenskapsinformation och sparas i 7
        år — {removable ? `det kan tas bort fram till ${lockedBy}` : `efter ${lockedBy} kan det inte tas bort`}.
      </FormHint>
      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "12px 0" }}>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UNDERLAG_ACCEPT}
          aria-label="Ladda upp underlag"
          disabled={pending}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) void upload(e.target.files);
          }}
        />
        {pending && <span>Laddar upp…</span>}
      </div>
      <FormError>{error}</FormError>
      {files.length > 0 ? (
        <Table<UnderlagFile>
          columns={[
            { key: "filename", label: "Filnamn", width: "1fr" },
            { key: "sizeBytes", label: "Storlek", width: "100px", align: "right" },
            { key: "createdAt", label: "Uppladdad", width: "150px" },
            ...(removable ? ([{ key: "id", label: "", width: "110px", align: "right" }] as const) : []),
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
                    style={{ fontWeight: 600, color: "inherit" }}
                  >
                    {file.filename}
                  </a>
                );
              case "sizeBytes":
                return formatSize(file.sizeBytes);
              case "createdAt":
                return new Date(file.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
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
        <p>Inget underlag uppladdat.</p>
      )}
    </>
  );
}
