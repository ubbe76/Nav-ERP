"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { FormError } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useCanOpen } from "../PermissionsProvider";
import { ARTICLE_TYPE_LABELS, OVERVIEW_KIND_LABELS, type ArticleFile, type ArticleOverview, type ArticleOverviewRow } from "../../lib/types";
import styles from "./ArticleOverview.module.css";

interface ArticleOverviewContentProps {
  articleId: string | null;
  // The user picked another article in the search field.
  onChangeArticle: (articleId: string) => void;
  // Unique per host — the page and the floating panel can both be mounted.
  pickerId: string;
}

// The first row is the current stock, so the running balance column reads
// top-down from where it starts.
type DisplayRow = ArticleOverviewRow | { id: "onhand"; kind: "onhand" };

// Sized to fit the floating panel's body (~840 px) without a horizontal
// scroller — the panel width in ArticleOverview.module.css follows this.
const COLUMNS = [
  { key: "date", label: "Datum", width: "96px" },
  { key: "kind", label: "Typ", width: "178px" },
  { key: "document", label: "Order", width: "130px" },
  { key: "partner", label: "Kund/Leverantör", width: "minmax(140px, 1fr)" },
  { key: "quantity", label: "Antal", width: "84px", align: "right" as const },
  // "Disponibelt", not "Saldo": saldo means stock actually on the shelf
  // (the Lagersaldo above); this column is the projected running balance.
  { key: "balance", label: "Disponibelt", width: "84px", align: "right" as const },
];

function hrefFor(row: ArticleOverviewRow): string {
  switch (row.documentType) {
    case "sales_order":
      return `/forsaljning/ordrar/${row.documentId}`;
    case "purchase_order":
      return `/inkop/ordrar/${row.documentId}`;
    case "manufacturing_order":
      return `/tillverkning/ordrar/${row.documentId}`;
  }
}

function num(n: number): string {
  return n.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
}

// Shared by the /artiklar/oversikt page and the floating panel: the search
// field, the article header and the date-ordered row list with its running
// balance (Monitor G5's planeringsbild). Data is fetched here, keyed on the
// article id, so re-targeting the panel is just a prop change.
export function ArticleOverviewContent({ articleId, onChangeArticle, pickerId }: ArticleOverviewContentProps) {
  const canOpen = useCanOpen();
  const [data, setData] = useState<ArticleOverview | null>(null);
  const [files, setFiles] = useState<ArticleFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the closed search field shows. Set immediately on a pick (so the
  // field doesn't blank while the overview loads) and from the response
  // (so a button-opened panel shows the article it was opened for).
  const [picked, setPicked] = useState<ArticlePickerValue | null>(null);

  useEffect(() => {
    if (!articleId) {
      setData(null);
      setFiles([]);
      setError(null);
      setPicked(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch<ArticleOverview>(`/api/v1/articles/${articleId}/overview`),
      // A failing files request must not discard a good overview.
      apiFetch<ArticleFile[]>(`/api/v1/articles/${articleId}/files`).catch(() => [] as ArticleFile[]),
    ])
      .then(([res, fileRows]) => {
        if (cancelled) return;
        setData(res);
        setFiles(fileRows);
        setPicked({ id: res.article.articleId, articleNumber: res.article.articleNumber, name: res.article.name });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setFiles([]);
        setError(apiErrorMessage(err, "Kunde inte hämta artikelöversikten"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  const rows: DisplayRow[] = data ? [{ id: "onhand", kind: "onhand" }, ...data.rows] : [];
  const unit = data?.article.unitCode ?? "";

  return (
    <div>
      <div className={styles.pickerRow}>
        <label className={styles.label} htmlFor={pickerId}>
          Artikel
        </label>
        <ArticlePicker
          id={pickerId}
          value={picked}
          onChange={(next) => {
            // null = the user cleared/started typing; only switch on a pick.
            if (next && next.id !== articleId) {
              setPicked(next);
              onChangeArticle(next.id);
            }
          }}
        />
      </div>

      <FormError margin="below">{error}</FormError>

      {!articleId && !error && <p className={styles.hint}>Välj en artikel för att visa översikten.</p>}

      {data && (
        <>
          <div className={styles.articleHead}>
            {canOpen(`/artiklar/${data.article.articleId}`) ? (
              <Link href={`/artiklar/${data.article.articleId}`} className={styles.articleLink}>
                {data.article.articleNumber} — {data.article.name}
              </Link>
            ) : (
              <span className={styles.articleLink}>
                {data.article.articleNumber} — {data.article.name}
              </span>
            )}
            <span className={styles.typeText}>{ARTICLE_TYPE_LABELS[data.article.type]}</span>
            {data.article.isPhantom && <StatusPill status="draft" label="Fantom" compact />}
            {!data.article.active && <StatusPill status="draft" label="Inaktiv" compact />}
            {loading && <span className={styles.loading}>Hämtar…</span>}
          </div>

          <div className={styles.headerFields}>
            <div>
              <div className={styles.label}>Lagersaldo</div>
              <div className={`${styles.value} num`}>
                {num(data.onHand)} <span className={styles.unit}>{unit}</span>
              </div>
            </div>
            <div>
              <div className={styles.label}>Beställningspunkt</div>
              <div className={`${styles.value} num`}>
                {data.article.reorderPoint === null ? "—" : num(data.article.reorderPoint)}
              </div>
            </div>
            <div>
              <div className={styles.label}>Orderkvantitet</div>
              <div className={`${styles.value} num`}>
                {data.article.orderQuantity === null ? "—" : num(data.article.orderQuantity)}
              </div>
            </div>
            <div>
              <div className={styles.label}>Avrundning</div>
              <div className={`${styles.value} num`}>
                {data.article.rounding === null ? "—" : num(data.article.rounding)}
              </div>
            </div>
            <div>
              <div className={styles.label}>Huvudleverantör</div>
              <div className={styles.value}>
                {data.primarySupplier ? (
                  <>
                    {data.primarySupplier.supplierName}
                    {data.primarySupplier.leadTimeDays !== null && (
                      <span className={styles.muted}> · Ledtid {data.primarySupplier.leadTimeDays} dagar</span>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div>
              <div className={styles.label}>Ritningar</div>
              <div className={styles.value}>
                {files.length === 0 ? (
                  "—"
                ) : (
                  <span className={styles.fileLinks}>
                    {files.map((f) => (
                      <a
                        key={f.id}
                        href={`/api/v1/articles/${data.article.articleId}/files/${f.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.rowLink}
                      >
                        {f.filename}
                      </a>
                    ))}
                  </span>
                )}
              </div>
            </div>
          </div>

          <Table<DisplayRow>
            columns={COLUMNS}
            rows={rows}
            emptyText="Inga öppna behov eller inkommande"
            renderCell={(row, key) => {
              if (row.kind === "onhand") {
                switch (key) {
                  case "kind":
                    return <span className={styles.onHandRow}>Lagersaldo idag</span>;
                  case "balance":
                    return <span className={`${styles.onHandRow} ${data.onHand < 0 ? styles.negative : ""}`}>{num(data.onHand)}</span>;
                  default:
                    return null;
                }
              }
              switch (key) {
                case "date":
                  return row.date ?? <span className={styles.muted}>Saknar datum</span>;
                case "kind":
                  return OVERVIEW_KIND_LABELS[row.kind];
                case "document":
                  return (
                    <>
                      {canOpen(hrefFor(row)) ? (
                        <Link href={hrefFor(row)} className={styles.rowLink}>
                          {row.documentNumber}
                        </Link>
                      ) : (
                        <span>{row.documentNumber}</span>
                      )}
                      {row.isDraft && (
                        <>
                          {" "}
                          <StatusPill status="draft" label="Utkast" compact />
                        </>
                      )}
                    </>
                  );
                case "partner":
                  return row.partner ?? "—";
                case "quantity":
                  return <span className={row.quantity < 0 ? styles.demand : styles.supply}>{row.quantity > 0 ? `+${num(row.quantity)}` : num(row.quantity)}</span>;
                case "balance":
                  return <span className={row.balance < 0 ? styles.negative : ""}>{num(row.balance)}</span>;
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      {!data && articleId && loading && <p className={styles.hint}>Hämtar…</p>}
    </div>
  );
}
