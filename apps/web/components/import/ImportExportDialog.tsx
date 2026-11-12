"use client";

import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormStack } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { API_URL, apiErrorFromBody, apiFetch } from "../../lib/api";
import { fetchCopiedCount } from "../../lib/copiedArticles";
import { apiErrorMessage } from "../../lib/errorMessages";
import { IMPORT_ENTITY_ORDER } from "../../lib/importEntities";
import { ARTICLE_TYPE_LABELS, type ArticleGroup, type ArticleType } from "../../lib/types";
import styles from "./ImportExportDialog.module.css";

type Format = "xlsx" | "csv";
// Alla = the whole register; Kopierat = the user's own list; Urval = the
// article register's filters.
type Source = "all" | "copied" | "filter";

const FALLBACK_ERROR = "Exporten kunde inte skapas";

// The file name the API gave (Content-Disposition), else one after the
// answer's type — the header is not readable across origins in development.
function downloadName(res: Response, entity: string): string {
  const header = res.headers.get("Content-Disposition") ?? "";
  const named = /filename="([^"]+)"/.exec(header)?.[1];
  if (named) return named;
  const type = res.headers.get("Content-Type") ?? "";
  const extension = type.includes("zip") ? "zip" : type.includes("csv") ? "csv" : "xlsx";
  return `export-${entity}.${extension}`;
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Exportera on an import tab (#35): the register as that tab's import file
// — GET /imports/:entity/export. Format, and for the article page's tabs
// the article selection; the answer is one file, or a .zip of files when
// the register has more rows than one import file takes.
export function ImportExportDialog({
  entity,
  title,
  open,
  onClose,
}: {
  entity: string;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const articleBound = IMPORT_ENTITY_ORDER.includes(entity);
  const [format, setFormat] = useState<Format>("xlsx");
  const [source, setSource] = useState<Source>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [groupId, setGroupId] = useState("");
  const [type, setType] = useState<ArticleType | "">("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [copiedCount, setCopiedCount] = useState<number | null>(null);
  const [groups, setGroups] = useState<ArticleGroup[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The selection's registers are only fetched when the dialog is opened.
  useEffect(() => {
    if (!open || !articleBound) return;
    let current = true;
    fetchCopiedCount()
      .then((n) => {
        if (!current) return;
        setCopiedCount(n);
        if (n === 0) setSource((s) => (s === "copied" ? "all" : s));
      })
      // Unknown, not empty: Kopierat stays selectable.
      .catch(() => current && setCopiedCount(null));
    apiFetch<ArticleGroup[]>("/api/v1/article-groups")
      .then((rows) => current && setGroups(rows))
      .catch(() => current && setGroups([]));
    return () => {
      current = false;
    };
  }, [open, articleBound]);

  const copiedDisabled = copiedCount === 0;

  async function onExport() {
    setError(null);
    setPending(true);
    try {
      const params = new URLSearchParams({ format });
      if (articleBound && source === "copied") params.set("copied", "true");
      if (articleBound && source === "filter") {
        if (from.trim()) params.set("articleNumberFrom", from.trim());
        if (to.trim()) params.set("articleNumberTo", to.trim());
        if (groupId) params.set("groupId", groupId);
        if (type) params.set("type", type);
      }
      if (activeOnly) params.set("activeOnly", "true");
      const res = await fetch(`${API_URL}/api/v1/imports/${entity}/export?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw apiErrorFromBody(res.status, payload, FALLBACK_ERROR);
      }
      saveBlob(await res.blob(), downloadName(res, entity));
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, FALLBACK_ERROR));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title.replace(/^Importera/, "Exportera")}>
      <FormStack>
        <FormHint>
          Exporten har importmallens kolumner och kan ändras och läsas in igen på den här fliken. Fler än 10 000 rader delas
          upp i flera filer i en zip-fil.
        </FormHint>
        <Field label="Format" htmlFor="import-export-format">
          <Select id="import-export-format" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV</option>
          </Select>
        </Field>

        {articleBound && (
          <fieldset className={styles.selection}>
            <legend className={styles.legend}>Urval</legend>
            <div className={styles.sources} role="radiogroup" aria-label="Urval">
              <label className={styles.choice}>
                <input type="radio" name="import-export-source" checked={source === "all"} onChange={() => setSource("all")} />
                Alla artiklar
              </label>
              <label className={styles.choice} data-disabled={copiedDisabled}>
                <input
                  type="radio"
                  name="import-export-source"
                  checked={source === "copied"}
                  disabled={copiedDisabled}
                  onChange={() => setSource("copied")}
                />
                Kopierat{copiedCount !== null ? ` (${copiedCount.toLocaleString("sv-SE")})` : ""}
              </label>
              <label className={styles.choice}>
                <input type="radio" name="import-export-source" checked={source === "filter"} onChange={() => setSource("filter")} />
                Urval
              </label>
            </div>
            {source === "filter" && (
              <div className={styles.filters}>
                <Field label="Artikelnummer från" htmlFor="import-export-from">
                  <Input id="import-export-from" value={from} maxLength={50} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="Artikelnummer till" htmlFor="import-export-to">
                  <Input id="import-export-to" value={to} maxLength={50} onChange={(e) => setTo(e.target.value)} />
                </Field>
                <Field label="Varugrupp" htmlFor="import-export-group">
                  <Select id="import-export-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    <option value="">Alla</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Typ" htmlFor="import-export-type">
                  <Select id="import-export-type" value={type} onChange={(e) => setType(e.target.value as ArticleType | "")}>
                    <option value="">Alla</option>
                    {(Object.keys(ARTICLE_TYPE_LABELS) as ArticleType[]).map((t) => (
                      <option key={t} value={t}>
                        {ARTICLE_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </fieldset>
        )}

        <label className={styles.choice}>
          <Checkbox checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Bara aktiva
        </label>

        <FormError>{error}</FormError>
        <FormActions>
          <Button type="button" onClick={() => void onExport()} disabled={pending || (source === "copied" && copiedDisabled)}>
            {pending ? "Exporterar…" : "Exportera"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Avbryt
          </Button>
        </FormActions>
      </FormStack>
    </Modal>
  );
}
