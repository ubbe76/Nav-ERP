// F2: CSV columns for GET /articles/csv — mirrors ArticlesPageClient.tsx's
// Table column order/labels exactly (apps/web/components/articles/ArticlesPageClient.tsx).
// Ytbehandling/Färg are export-only — the web table itself has no column for
// them (article card fields, not list columns).
import type { ArticleType } from "@navet/shared";
import { type CsvColumn } from "@navet/shared";

// Server-side mirror of the web's ARTICLE_TYPE_LABELS (apps/web/lib/types.ts)
// — the API has no reason to import from the web app, so the tiny map is
// duplicated rather than shared.
const ARTICLE_TYPE_LABELS: Record<ArticleType, string> = {
  manufactured: "Tillverkad",
  purchased: "Köpt",
  service: "Tjänst",
};

export interface ArticleExportRow {
  articleNumber: string;
  name: string;
  type: ArticleType;
  isPhantom: boolean;
  groupName: string | null;
  articleCodeName: string | null;
  unit: string;
  standardCost: string | number | null;
  surfaceTreatment: string | null;
  colour: string | null;
  active: boolean;
}

export const articleExportColumns: CsvColumn<ArticleExportRow>[] = [
  { label: "Artikelnummer", value: (r) => r.articleNumber },
  { label: "Benämning", value: (r) => r.name },
  { label: "Typ", value: (r) => `${ARTICLE_TYPE_LABELS[r.type]}${r.isPhantom ? " · Fantom" : ""}` },
  { label: "Varugrupp", value: (r) => r.groupName },
  { label: "Artikelkod", value: (r) => r.articleCodeName },
  { label: "Enhet", value: (r) => r.unit },
  { label: "Standardkostnad", value: (r) => r.standardCost, format: "money" },
  { label: "Status", value: (r) => (r.active ? "Aktiv" : "Inaktiv") },
  { label: "Ytbehandling", value: (r) => r.surfaceTreatment },
  { label: "Färg", value: (r) => r.colour },
];
