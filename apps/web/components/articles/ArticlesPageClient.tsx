"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArticleOverviewButton } from "./ArticleOverviewButton";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import buttonStyles from "../ui/Button.module.css";
import { NewArticleForm } from "./NewArticleForm";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmLeave, useUnsavedGuard } from "../../lib/unsavedGuard";
import { moveRowHighlight } from "../../lib/listKeyboard";
import { ARTICLE_TYPE_LABELS, type Article, type ArticleGroup, type ArticleType, type Paged, type RegisterEntry } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/artiklar/page.module.css";
import editStyles from "./ArticleRegister.module.css";
import { HelpLink } from "../ui/HelpLink";

// The four columns that can be edited in the list; "" stands for "no group".
type EditField = "name" | "type" | "groupId" | "unitId";
type Draft = Partial<Record<EditField, string>>;

type BatchResult =
  | { id: string; ok: true; article: Article }
  | { id: string; ok: false; error: { code: string; message: string } };

function serverValue(article: Article, field: EditField): string {
  return field === "groupId" ? (article.groupId ?? "") : article[field];
}

export function ArticlesPageClient({
  articles,
  groups,
  articleCodes,
  pageSize,
}: {
  articles: Paged<Article>;
  groups: ArticleGroup[];
  articleCodes: RegisterEntry[];
  pageSize: number;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const canEdit = useCan()(["artiklar"]);
  // The list is read-only until Redigera is pressed; the mode survives
  // paging and search, and ends with Avsluta redigering or a clean save.
  const [editing, setEditing] = useState(false);
  const editable = canEdit && editing;

  const [rows, setRows] = useState<Article[]>(articles.rows);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [units, setUnits] = useState<RegisterEntry[]>([]);
  const [unitsFailed, setUnitsFailed] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // Row marked with the arrow keys from the search field (index into rows);
  // Enter opens it. null = none marked, Enter then just searches.
  const [highlighted, setHighlighted] = useState<number | null>(null);

  // A new page of results (paging, search, filter — all guarded when drafts
  // exist) replaces the rows and starts clean.
  useEffect(() => {
    setRows(articles.rows);
    setDrafts({});
    setRowErrors({});
    setSaveError(null);
    setHighlighted(null);
  }, [articles]);

  // Redigera hands the keys to the cells — drop any marked row.
  useEffect(() => {
    if (editable) setHighlighted(null);
  }, [editable]);

  // Keep the marked row in view while walking a long list.
  useEffect(() => {
    if (highlighted === null) return;
    tableRef.current
      ?.querySelector<HTMLElement>('[data-highlighted] > *')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  // Search field keys (read-only mode only — in Redigera, Enter/Esc belong
  // to the cells): the arrows walk the result rows, Enter on a marked row
  // opens the article card, Esc unmarks, anything typed starts over.
  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (editable) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((current) => moveRowHighlight(current, e.key as "ArrowDown" | "ArrowUp", rows.length));
    } else if (e.key === "Enter") {
      const article = highlighted === null ? undefined : rows[highlighted];
      if (!article) return;
      e.preventDefault();
      void confirmLeave().then((leave) => leave && router.push(`/artiklar/${article.id}`));
    } else if (e.key === "Escape") {
      if (highlighted === null) return;
      // Unmark only — the browser would otherwise also clear the search.
      e.preventDefault();
      setHighlighted(null);
    } else if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
      setHighlighted(null);
    }
  }

  useEffect(() => {
    if (!editable) return;
    apiFetch<RegisterEntry[]>("/api/v1/units")
      .then((u) => {
        setUnits(u);
        setUnitsFailed(false);
      })
      .catch(() => {
        setUnits([]);
        setUnitsFailed(true);
      });
  }, [editable]);

  const draftCount = Object.keys(drafts).length;

  // List navigation, in-app links and tab close all ask before dropping drafts.
  useUnsavedGuard(draftCount > 0);

  function setField(article: Article, field: EditField, value: string) {
    setRowErrors((prev) => {
      if (!(article.id in prev)) return prev;
      const { [article.id]: _gone, ...rest } = prev;
      return rest;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      const draft = { ...(next[article.id] ?? {}) };
      if (value === serverValue(article, field)) delete draft[field];
      else draft[field] = value;
      if (Object.keys(draft).length === 0) delete next[article.id];
      else next[article.id] = draft;
      return next;
    });
  }

  function current(article: Article, field: EditField): string {
    return drafts[article.id]?.[field] ?? serverValue(article, field);
  }

  function discardAll() {
    setDrafts({});
    setRowErrors({});
    setSaveError(null);
  }

  async function stopEditing() {
    if (!(await confirmLeave())) return;
    discardAll();
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    // An emptied Benämning is refused here, row by row, instead of letting
    // the server reject the whole request.
    const emptyNames: Record<string, string> = {};
    const sendable = Object.entries(drafts).filter(([id, draft]) => {
      if (draft.name !== undefined && draft.name.trim() === "") {
        emptyNames[id] = "Benämning måste anges";
        return false;
      }
      return true;
    });
    if (sendable.length === 0) {
      setRowErrors(emptyNames);
      setSaving(false);
      return;
    }
    const payload = {
      rows: sendable.map(([id, draft]) => ({
        id,
        ...(draft.name !== undefined && { name: draft.name }),
        ...(draft.type !== undefined && { type: draft.type }),
        ...(draft.groupId !== undefined && { groupId: draft.groupId === "" ? null : draft.groupId }),
        ...(draft.unitId !== undefined && { unitId: draft.unitId }),
      })),
    };
    try {
      const { results } = await apiFetch<{ results: BatchResult[] }>("/api/v1/articles/batch", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const saved = new Map<string, Article>();
      const errors: Record<string, string> = {};
      for (const r of results) {
        if (r.ok) saved.set(r.id, r.article);
        else errors[r.id] = apiErrorMessage(r.error, r.error.message);
      }
      setRows((prev) =>
        prev.map((row) => {
          const a = saved.get(row.id);
          return a
            ? { ...row, name: a.name, type: a.type, groupId: a.groupId, groupName: a.groupName, unit: a.unit, unitId: a.unitId, updatedAt: a.updatedAt }
            : row;
        })
      );
      setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !saved.has(id))));
      setRowErrors({ ...emptyNames, ...errors });
      // Everything saved: back to the read-only list. A refused row keeps
      // the mode so it can be corrected.
      if (Object.keys(errors).length === 0 && Object.keys(emptyNames).length === 0) setEditing(false);
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Kunde inte spara ändringarna"));
    } finally {
      setSaving(false);
    }
  }

  // Enter jumps to the same column on the next row, Esc reverts the cell.
  function onCellKeyDown(e: KeyboardEvent<HTMLElement>, article: Article, field: EditField, index: number) {
    if (e.key === "Escape") {
      e.preventDefault();
      setField(article, field, serverValue(article, field));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const next = tableRef.current?.querySelector<HTMLElement>(`[data-inline="${field}-${index + 1}"]`);
      next?.focus();
    }
  }

  const unitOptions = useMemo(() => units.slice().sort((a, b) => a.code.localeCompare(b.code, "sv")), [units]);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Artiklar</div>
          <div className={shellStyles.meta}>{articles.total.toLocaleString("sv-SE")} artiklar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/varugrupper" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Varugrupper
          </Link>
          <Link href="/artiklar/import" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Importera
          </Link>
          {canEdit &&
            (editing ? (
              <Button type="button" variant="secondary" onClick={stopEditing} disabled={saving}>
                Avsluta redigering
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
                Redigera
              </Button>
            ))}
          <Button type="button" variant="primary" onClick={() => void confirmLeave().then((leave) => leave && setModalOpen(true))}>
            + Ny artikel
          </Button>
          <HelpLink chapter="artiklar" anchor="artikelregistret" label="Hjälp om artikelregistret" />
        </div>
      </div>

      <ListToolbar placeholder="Sök artikelnummer eller benämning…" onSearchKeyDown={onSearchKeyDown}>
        <ListFilterSelect
          param="type"
          allLabel="Alla typer"
          ariaLabel="Filtrera på artikeltyp"
          options={Object.entries(ARTICLE_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ListFilterSelect
          param="groupId"
          allLabel="Alla varugrupper"
          ariaLabel="Filtrera på varugrupp"
          options={groups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))}
        />
        <ListFilterSelect
          param="articleCodeId"
          allLabel="Alla artikelkoder"
          ariaLabel="Filtrera på artikelkod"
          options={articleCodes.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
        />
        <ListExportLink endpoint="/api/v1/articles/csv" />
      </ListToolbar>

      {editable && unitsFailed && <FormNotice>Kunde inte hämta enheter — standardenhet kan inte ändras</FormNotice>}

      <div ref={tableRef}>
        <Table<Article>
          columns={[
            { key: "articleNumber", label: "Artikelnummer", width: "160px" },
            { key: "name", label: "Benämning", width: "minmax(200px, 1fr)" },
            { key: "type", label: "Typ", width: editable ? "170px" : "160px" },
            { key: "groupName", label: "Varugrupp", width: editable ? "190px" : "140px" },
            { key: "articleCodeName", label: "Artikelkod", width: "140px" },
            { key: "unit", label: "Standardenhet", width: editable ? "140px" : "130px" },
            { key: "standardCost", label: "Standardkostnad", width: "160px", align: "right" },
            { key: "active", label: "Status", width: "120px" },
          ]}
          rows={rows}
          highlightedRowId={highlighted === null ? null : rows[highlighted]?.id ?? null}
          emptyText="Inga artiklar matchar sökningen"
          renderCell={(article, key) => {
            const index = rows.indexOf(article);
            const marked = (field: EditField) => drafts[article.id]?.[field] !== undefined;
            switch (key) {
              case "articleNumber":
                return (
                  <>
                    <Link href={`/artiklar/${article.id}`} className={styles.rowLink}>
                      {article.articleNumber}
                    </Link>
                    <ArticleOverviewButton articleId={article.id} articleNumber={article.articleNumber} />
                  </>
                );
              case "name":
                if (!editable) return article.name;
                return (
                  <div className={editStyles.nameCell}>
                    <div className={editStyles.control} data-draft={marked("name")}>
                      <Input
                        disabled={saving}
                        value={current(article, "name")}
                        maxLength={255}
                        aria-label={`Benämning för ${article.articleNumber}`}
                        data-inline={`name-${index}`}
                        onChange={(e) => setField(article, "name", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, article, "name", index)}
                      />
                    </div>
                    <FormError>{rowErrors[article.id]}</FormError>
                  </div>
                );
              case "type":
                if (!editable) return `${ARTICLE_TYPE_LABELS[article.type]}${article.isPhantom ? " · Fantom" : ""}`;
                return (
                  <div className={editStyles.control} data-draft={marked("type")}>
                    <Select
                      disabled={saving}
                      value={current(article, "type")}
                      aria-label={`Typ för ${article.articleNumber}`}
                      data-inline={`type-${index}`}
                      onChange={(e) => setField(article, "type", e.target.value as ArticleType)}
                      onKeyDown={(e) => onCellKeyDown(e, article, "type", index)}
                    >
                      {Object.entries(ARTICLE_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    {article.isPhantom && <span className={editStyles.phantom}>Fantom</span>}
                  </div>
                );
              case "groupName":
                if (!editable) return article.groupName ?? "–";
                return (
                  <div className={editStyles.control} data-draft={marked("groupId")}>
                    <Select
                      disabled={saving}
                      value={current(article, "groupId")}
                      aria-label={`Varugrupp för ${article.articleNumber}`}
                      data-inline={`groupId-${index}`}
                      onChange={(e) => setField(article, "groupId", e.target.value)}
                      onKeyDown={(e) => onCellKeyDown(e, article, "groupId", index)}
                    >
                      <option value="">— Ingen —</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.code} · {g.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                );
              case "articleCodeName":
                return article.articleCodeName ?? "–";
              case "unit":
                if (!editable) return article.unit;
                return (
                  <div className={editStyles.control} data-draft={marked("unitId")}>
                    <Select
                      disabled={saving || unitsFailed}
                      value={current(article, "unitId")}
                      aria-label={`Standardenhet för ${article.articleNumber}`}
                      data-inline={`unitId-${index}`}
                      onChange={(e) => setField(article, "unitId", e.target.value)}
                      onKeyDown={(e) => onCellKeyDown(e, article, "unitId", index)}
                    >
                      {/* The register may not be loaded yet: keep the saved unit selectable. */}
                      {!unitOptions.some((u) => u.id === article.unitId) && <option value={article.unitId}>{article.unit}</option>}
                      {unitOptions.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.code}
                        </option>
                      ))}
                    </Select>
                  </div>
                );
              case "standardCost":
                return article.standardCost ? `${Number(article.standardCost).toFixed(2)} kr` : "–";
              case "active":
                return article.active ? (
                  <StatusPill status="running" label="Aktiv" compact />
                ) : (
                  <StatusPill status="draft" label="Inaktiv" compact />
                );
              default:
                return null;
            }
          }}
        />
      </div>

      <Pagination total={articles.total} pageSize={pageSize} />

      {editable && draftCount > 0 && (
        <div className={editStyles.bar} role="region" aria-label="Osparade ändringar">
          <span className={editStyles.barCount}>
            {draftCount} {draftCount === 1 ? "rad ändrad" : "rader ändrade"}
          </span>
          {saveError && <FormError inline>{saveError}</FormError>}
          <Button type="button" variant="ghost" onClick={discardAll} disabled={saving}>
            Ångra
          </Button>
          <Button type="button" variant="primary" onClick={save} disabled={saving}>
            {saving ? "Sparar…" : "Spara ändringar"}
          </Button>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny artikel">
        <NewArticleForm groups={groups} />
      </Modal>
    </>
  );
}
