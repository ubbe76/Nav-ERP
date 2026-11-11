"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { copiedNotice } from "../../lib/copiedArticles";
import { apiErrorMessage } from "../../lib/errorMessages";
import { ARTICLE_TYPE_LABELS, type Article, type CopiedArticleRow, type CopiedArticles } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { ArticlePicker } from "../ui/ArticlePicker";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Card } from "../ui/Card";
import { Checkbox } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { StatusPill } from "../ui/StatusPill";
import { shareTrack, Table, TableSkeleton } from "../ui/Table";
import styles from "./CopiedArticlesPageClient.module.css";

// Kopierat (#28): the user's own working list, in the order it was copied
// (the API's `position`). Everything here goes through the four existing
// routes — GET ?details=true for the rows, POST add for one article, POST
// remove for the marked rows, DELETE for Töm — and re-reads the list after
// each write so the order and count are always the server's.
export function CopiedArticlesPageClient() {
  const [rows, setRows] = useState<CopiedArticleRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picker is cleared after each add; the key forces a fresh instance so
  // its typed search text goes too.
  const [pickerKey, setPickerKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<CopiedArticles>("/api/v1/articles/copied?details=true");
      setRows(res.articles ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "Kunde inte hämta Kopierat"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Marks that no longer point at a row (removed in this or another tab) are dropped.
  const rowIds = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
  const selectedIds = useMemo(() => [...selected].filter((id) => rowIds.has(id)), [selected, rowIds]);

  async function addArticle(article: Article | null) {
    if (!article) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const alreadyThere = rowIds.has(article.id);
    try {
      const res = await apiFetch<{ count: number; added: number }>("/api/v1/articles/copied", {
        method: "POST",
        body: JSON.stringify({ mode: "add", articleIds: [article.id] }),
      });
      await load();
      setNotice(
        alreadyThere || res.added === 0
          ? `${article.articleNumber} finns redan i Kopierat och behåller sin plats.`
          : `${article.articleNumber} lades till sist. ${copiedNotice(res.count)}`
      );
      setPickerKey((k) => k + 1);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till artikeln i Kopierat"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { count } = await apiFetch<{ count: number }>("/api/v1/articles/copied/remove", {
        method: "POST",
        body: JSON.stringify({ articleIds: ids }),
      });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      await load();
      setNotice(count === 0 ? "Kopierat är tomt." : copiedNotice(count));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort artiklarna ur Kopierat"));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!(await confirmDialog("Töm Kopierat? Alla kopierade artiklar tas bort ur listan.", { confirmLabel: "Töm Kopierat", danger: true }))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/v1/articles/copied", { method: "DELETE" });
      setSelected(new Set());
      await load();
      setNotice("Kopierat är tömt.");
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte tömma Kopierat"));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const count = rows?.length ?? null;
  const allSelected = rows !== null && rows.length > 0 && selectedIds.length === rows.length;

  const columns = [
    {
      key: "select",
      label: "Markera",
      width: "28px",
      header: (
        <SelectAllCheckbox
          checked={allSelected}
          indeterminate={selectedIds.length > 0 && !allSelected}
          disabled={!rows || rows.length === 0}
          onChange={(on) => setSelected(on ? new Set((rows ?? []).map((r) => r.id)) : new Set())}
          ariaLabel="Markera alla artiklar"
        />
      ),
    },
    { key: "position", label: "#", width: "44px", align: "right" as const },
    { key: "articleNumber", label: "Artikelnummer", width: shareTrack(110) },
    { key: "name", label: "Benämning", width: shareTrack(160, 2) },
    { key: "type", label: "Typ", width: shareTrack(80) },
    { key: "status", label: "Status", width: shareTrack(70) },
    { key: "actions", label: "", width: "88px", align: "right" as const },
  ];

  const tableRows = (rows ?? []).map((r, i) => ({ ...r, position: i + 1 }));

  function renderCell(r: (typeof tableRows)[number], key: string) {
    switch (key) {
      case "select":
        return <Checkbox checked={selected.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} aria-label={`Markera ${r.articleNumber}`} />;
      case "position":
        return <span className={styles.position}>{r.position}</span>;
      case "articleNumber":
        return <GatedLink href={`/artiklar/${r.id}`}>{r.articleNumber}</GatedLink>;
      case "name":
        return r.name;
      case "type":
        return ARTICLE_TYPE_LABELS[r.type];
      case "status":
        return r.active ? <StatusPill status="running" label="Aktiv" compact /> : <StatusPill status="draft" label="Inaktiv" compact />;
      case "actions":
        return (
          <Button type="button" variant="ghost" size="small" disabled={busy} onClick={() => void remove([r.id])} aria-label={`Ta bort ${r.articleNumber} ur Kopierat`}>
            Ta bort
          </Button>
        );
      default:
        return null;
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kopierat</div>
          <div className={shellStyles.meta}>
            {count === null ? "Din egen arbetslista med artiklar" : count === 1 ? "1 artikel i listan" : `${count.toLocaleString("sv-SE")} artiklar i listan`}
            {count !== null && count > 0 ? " — i den ordning de kopierades" : ""}
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          {selectedIds.length > 0 && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void remove(selectedIds)}>
              Ta bort markerade ({selectedIds.length})
            </Button>
          )}
          {count !== null && count > 0 && (
            <GatedLink href="/artiklar/forkalkylera?urval=kopierat" className={`${buttonStyles.button} ${buttonStyles.secondary}`}>
              Förkalkylera Kopierat
            </GatedLink>
          )}
          {count !== null && count > 0 && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void clear()}>
              Töm Kopierat
            </Button>
          )}
          <HelpLink chapter="artiklar" anchor="kopierat" label="Hjälp om Kopierat" />
        </div>
      </div>

      <div className={styles.stack}>
        <Card maxWidth="none">
          <div className={styles.addRow}>
            <label className={styles.addLabel} htmlFor="copied-add">
              Lägg till artikel
            </label>
            <div className={styles.picker}>
              <ArticlePicker key={pickerKey} id="copied-add" value={null} onChange={(article) => void addArticle(article)} placeholder="Sök artikelnummer eller benämning…" />
            </div>
          </div>
          <p className={styles.hint}>
            Artikeln läggs sist i listan. Fler på en gång kopierar du från <GatedLink href="/artiklar/register">artikelregistret</GatedLink>, behovsberäkningen eller en
            artikels struktur.
          </p>
          {notice && <FormNotice role="status">{notice}</FormNotice>}
          <FormError>{error}</FormError>
        </Card>

        {loadError ? (
          <FormError>{loadError}</FormError>
        ) : rows === null ? (
          <TableSkeleton label="Hämtar Kopierat" columns={6} rows={5} />
        ) : (
          <div className={styles.tableWrap}>
            <Table columns={columns} rows={tableRows} renderCell={renderCell} emptyText="Kopierat är tomt" />
          </div>
        )}
      </div>
    </>
  );
}
