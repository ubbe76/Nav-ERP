"use client";

import Link from "next/link";
import { DocumentActionBar } from "../documents/DocumentActionBar";
import { DocumentIdentity } from "../documents/DocumentIdentity";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { ArticleOverviewButton } from "./ArticleOverviewButton";
import { HelpLink } from "../ui/HelpLink";
import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { useCan } from "../PermissionsProvider";
import buttonStyles from "../ui/Button.module.css";
import { formatMoney, formatQuantity, formatUnitPrice } from "../../lib/format";
import {
  ARTICLE_TYPE_LABELS,
  OVERVIEW_KIND_LABELS,
  type Article,
  type ArticleOverview,
  type ArticleOverviewRow,
  type StockBalance,
} from "../../lib/types";
import styles from "./ArticleSummary.module.css";

// How many demand/supply rows the summary shows; the rest are in
// Artikelöversikten.
const OVERVIEW_ROWS = 8;

const DOCUMENT_HREF: Record<NonNullable<ArticleOverviewRow["documentType"]>, string> = {
  sales_order: "/forsaljning/ordrar",
  purchase_order: "/inkop/ordrar",
  manufacturing_order: "/tillverkning/ordrar",
};

// The right-hand pane of the article register (Programramen steg 3): the
// article at a glance — I lager, Disponibelt (I lager minus the open
// demand), Inkommande, Standardpris and the stock value at it, the balance
// per place (with Flytta) and the next demand and supply rows — and Öppna
// artikelkort for everything else.
export function ArticleSummary({
  article,
  balances,
  overview,
}: {
  article: Article;
  balances: StockBalance[] | null;
  overview: ArticleOverview | null;
}) {
  const canSeePrices = useCan()(["office"]);
  const unit = article.unit;
  const usable = overview?.onHand ?? null;
  const blocked = overview?.blockedOnHand ?? 0;
  const physical = balances ? balances.reduce((sum, b) => sum + Number(b.quantityOnHand), 0) : null;
  const demand = overview ? overview.rows.filter((r) => r.direction === "demand").reduce((s, r) => s - r.quantity, 0) : null;
  const supplyRows = overview ? overview.rows.filter((r) => r.direction === "supply") : [];
  const supply = overview ? supplyRows.reduce((s, r) => s + r.quantity, 0) : null;
  const available = usable !== null && demand !== null ? usable - demand : null;
  const standardCost = article.standardCost !== null ? Number(article.standardCost) : null;
  const stockValue = physical !== null && standardCost !== null ? physical * standardCost : null;
  const service = article.type === "service";
  const held = (balances ?? []).filter((b) => Number(b.quantityOnHand) !== 0);

  return (
    <div>
      <DocumentActionBar label={article.articleNumber}>
        <Link href={`/artiklar/${article.id}`} className={`${buttonStyles.button} ${buttonStyles.primary}`} data-nav-title={`Artikel ${article.articleNumber}`}>
          Öppna artikelkort
        </Link>
      </DocumentActionBar>

      <DocumentIdentity
        pageTitle={`Artikel ${article.articleNumber}`}
        number={article.articleNumber}
        pill={article.active ? { status: "draft", label: ARTICLE_TYPE_LABELS[article.type] } : { status: "stopped", label: "Inaktiv" }}
        note={[article.groupName, `Enhet ${unit}`].filter(Boolean).join(" · ")}
        help={
          <>
            <ArticleOverviewButton articleId={article.id} articleNumber={article.articleNumber} size="toolbar" />
            <HelpLink chapter="artiklar" anchor="artikelregistret" label="Hjälp om artikelregistret" />
          </>
        }
        title={article.name}
        titleHref={`/artiklar/${article.id}`}
      />

      <KpiRow>
        {!service && (
          <KpiTile
            label="I lager"
            value={usable !== null ? formatQuantity(usable) : physical !== null ? formatQuantity(physical) : "–"}
            unit={unit}
            signal={blocked > 0 ? `+ ${formatQuantity(blocked)} på spärrade platser` : undefined}
            tone={blocked > 0 ? "warn" : "neutral"}
          />
        )}
        {!service && (
          <KpiTile
            label="Disponibelt"
            value={available !== null ? formatQuantity(available) : "–"}
            unit={unit}
            signal={demand !== null && demand > 0 ? `${formatQuantity(demand)} ${unit} i öppna behov` : "Inga öppna behov"}
            tone={available !== null && available < 0 ? "alert" : "neutral"}
          />
        )}
        <KpiTile
          label="Inkommande"
          value={supply !== null ? formatQuantity(supply) : "–"}
          unit={unit}
          signal={supplyRows[0]?.date ? `Första ${supplyRows[0].date}` : supply ? undefined : "Inget på väg"}
        />
        {canSeePrices && (
          <KpiTile
            label="Standardpris"
            value={standardCost !== null ? formatUnitPrice(standardCost) : "–"}
            unit={standardCost !== null ? `kr/${unit}` : undefined}
            signal={stockValue !== null && !service ? `Lagervärde ${formatMoney(stockValue)} kr (standardpris)` : undefined}
          />
        )}
      </KpiRow>

      <div className={styles.columns}>
        {!service && (
          <section>
            <SectionHeading spaced>Saldo per lagerplats</SectionHeading>
            {balances === null ? (
              <p className={styles.muted}>Kunde inte läsa saldot just nu.</p>
            ) : held.length === 0 ? (
              <p className={styles.muted}>Inget i lager.</p>
            ) : (
              <Table<StockBalance & { id: string }>
                columns={[
                  { key: "place", label: "Lagerplats", width: "minmax(120px, 2fr)" },
                  { key: "quantity", label: "Saldo", width: "minmax(70px, 1fr)", align: "right" },
                  { key: "id", label: "", width: "max-content", align: "right" },
                ]}
                rows={held.map((b) => ({ ...b, id: b.locationId ?? "none" }))}
                renderCell={(b, key) => {
                  if (key === "place")
                    return (
                      <>
                        {[b.warehouseName, b.locationName].filter(Boolean).join(" · ") || "Ingen plats"}
                        {b.locationBlocked && <span className={styles.blocked}> Spärrad</span>}
                      </>
                    );
                  if (key === "quantity") return `${formatQuantity(b.quantityOnHand)} ${unit}`;
                  return b.locationId && Number(b.quantityOnHand) > 0 ? (
                    <GatedLink href={`/lager/flytta?from=${b.locationId}&article=${article.id}`}>Flytta</GatedLink>
                  ) : null;
                }}
              />
            )}
          </section>
        )}

        {overview && (
          <section>
            <SectionHeading spaced>Behov och inkommande</SectionHeading>
            {overview.rows.length === 0 ? (
              <p className={styles.muted}>Inga öppna behov eller inkommande.</p>
            ) : (
              <>
                <Table<ArticleOverviewRow>
                  columns={[
                    { key: "date", label: "Datum", width: "minmax(96px, 1fr)" },
                    { key: "document", label: "Dokument", width: "minmax(110px, 2fr)" },
                    { key: "quantity", label: "Antal", width: "minmax(60px, 1fr)", align: "right" },
                    { key: "balance", label: "Saldo efter", width: "minmax(70px, 1fr)", align: "right" },
                  ]}
                  rows={overview.rows.slice(0, OVERVIEW_ROWS)}
                  renderCell={(r, key) => {
                    if (key === "date") return r.date ?? "–";
                    if (key === "document") {
                      const label = `${OVERVIEW_KIND_LABELS[r.kind]} ${r.documentNumber}`;
                      return (
                        <>
                          {r.documentType && r.documentId ? (
                            <GatedLink href={`${DOCUMENT_HREF[r.documentType]}/${r.documentId}`}>{label}</GatedLink>
                          ) : (
                            label
                          )}
                          {r.isDraft && <span className={styles.muted}> Utkast</span>}
                          {r.partner && <div className={styles.sub}>{r.partner}</div>}
                        </>
                      );
                    }
                    if (key === "quantity") return formatQuantity(r.quantity);
                    return <span className={r.balance < 0 ? styles.negative : undefined}>{formatQuantity(r.balance)}</span>;
                  }}
                />
                {overview.rows.length > OVERVIEW_ROWS && (
                  <p className={styles.muted}>
                    {overview.rows.length - OVERVIEW_ROWS} rader till — se Artikelöversikten (knappen bredvid hjälpen).
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </div>

      <dl className={styles.facts}>
        {overview?.primarySupplier && (
          <div>
            <dt>Huvudleverantör</dt>
            <dd>
              <GatedLink href={`/leverantorer/${overview.primarySupplier.supplierId}`}>{overview.primarySupplier.supplierName}</GatedLink>
              {overview.primarySupplier.leadTimeDays != null ? ` · ledtid ${overview.primarySupplier.leadTimeDays} dagar` : ""}
            </dd>
          </div>
        )}
        {overview?.article.reorderPoint != null && (
          <div>
            <dt>Beställningspunkt</dt>
            <dd>
              {formatQuantity(overview.article.reorderPoint)} {unit}
            </dd>
          </div>
        )}
        {overview?.article.orderQuantity != null && (
          <div>
            <dt>Orderkvantitet</dt>
            <dd>
              {formatQuantity(overview.article.orderQuantity)} {unit}
            </dd>
          </div>
        )}
        {canSeePrices && article.salesPrice !== null && (
          <div>
            <dt>Försäljningspris</dt>
            <dd>{formatUnitPrice(article.salesPrice)} kr</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
