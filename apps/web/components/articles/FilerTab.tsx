"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useRef, useState } from "react";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { API_URL, apiFetch } from "../../lib/api";
import type { ArticleFile } from "../../lib/types";
import { FormError } from "../ui/Form";

const ACCEPT = ".pdf,.jpg,.jpeg,.png";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Ritningar och andra filer kopplade till artikeln (PDF/JPEG/PNG). Files are
// appended to the TO printout and can be attached to outgoing order emails.
export function FilerTab({ articleId }: { articleId: string }) {
  const [files, setFiles] = useState<ArticleFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setFiles(await apiFetch<ArticleFile[]>(`/api/v1/articles/${articleId}/files`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta filerna");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  async function upload(file: File) {
    setError(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", file);
      // Multipart upload — apiFetch sets a JSON content type, so this one
      // goes through fetch directly (same as the company logo upload).
      const res = await fetch(`${API_URL}/api/v1/articles/${articleId}/files`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? "Uppladdningen misslyckades");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uppladdningen misslyckades");
    } finally {
      setPending(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(file: ArticleFile) {
    if (!(await confirmDelete(`Ta bort ${file.filename}?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/files/${file.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort filen");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        Ritningar och andra filer kopplade till artikeln. Tillåtna format: PDF, JPEG och PNG, max 20 MB per fil.
        Filerna skrivs ut tillsammans med tillverkningsordern och kan bifogas när ordrar mejlas.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          aria-label="Välj fil att ladda upp"
          disabled={pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        {pending && <span>Laddar upp…</span>}
      </div>

      <FormError>{error}</FormError>

      {files.length > 0 ? (
        <Table<ArticleFile>
          columns={[
            { key: "filename", label: "Filnamn", width: "1fr" },
            { key: "contentType", label: "Typ", width: "140px" },
            { key: "sizeBytes", label: "Storlek", width: "110px", align: "right" },
            { key: "createdAt", label: "Uppladdad", width: "140px" },
            { key: "id", label: "", width: "120px", align: "right" },
          ]}
          rows={files}
          renderCell={(file, key) => {
            switch (key) {
              case "filename":
                return (
                  <a
                    href={`${API_URL}/api/v1/articles/${articleId}/files/${file.id}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontWeight: 600, color: "inherit" }}
                  >
                    {file.filename}
                  </a>
                );
              case "contentType":
                return file.contentType.replace("application/", "").replace("image/", "").toUpperCase();
              case "sizeBytes":
                return formatSize(file.sizeBytes);
              case "createdAt":
                return new Date(file.createdAt).toLocaleDateString("sv-SE");
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
        <p>Inga filer uppladdade än.</p>
      )}
    </div>
  );
}
