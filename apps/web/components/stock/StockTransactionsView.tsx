"use client";

import { ListExportLink, ListFilterSelect, ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { ArticlePicker } from "../ui/ArticlePicker";
import { GatedLink } from "../ui/GatedLink";
import { Field, Input } from "../ui/Field";
import { Table } from "../ui/Table";
import { useCan } from "../PermissionsProvider";
import {
  STOCK_TRANSACTION_TYPE_LABELS,
  type Paged,
  type StockLocation,
  type StockTransaction,
  type StockTransactionReference,
} from "../../lib/types";

interface Props {
  transactions: Paged<StockTransaction>;
  locations: StockLocation[];
  article: { id: string; articleNumber: string; name: string } | null;
  pageSize: number;
}

const REFERENCE_HREF: Record<string, (id: string) => string> = {
  purchase_order: (id) => `/inkop/ordrar/${id}`,
  sales_order: (id) => `/forsaljning/ordrar/${id}`,
  manufacturing_order: (id) => `/tillverkning/ordrar/${id}`,
  stock_count: (id) => `/lager/inventering/${id}`,
};

function ReferenceCell({ reference, quantityDelta }: { reference: StockTransactionReference | null; quantityDelta: string }) {
  if (!reference) return <>—</>;
  switch (reference.kind) {
    case "manual":
      return <>Manuell</>;
    case "transfer":
      // The negative leg went TO the counterpart, the positive came FROM it.
      return (
        <>
          {Number(quantityDelta) < 0 ? "Flytt till" : "Flytt från"} {reference.counterpartLocation}
        </>
      );
    default:
      return <GatedLink href={REFERENCE_HREF[reference.kind]!(reference.id)}>{reference.number}</GatedLink>;
  }
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const money = (value: string | null) =>
  value === null ? "—" : Number(value).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function StockTransactionsView({ transactions, locations, article, pageSize }: Props) {
  const { params, setFilter } = useListNavigation();
  const can = useCan();
  const showCost = can(["ekonomi"]);
  // Saldo only exists with an article filter (the API sends null otherwise).
  const showBalance = article !== null;

  const columns = [
    { key: "createdAt", label: "Datum", width: "150px" },
    { key: "articleNumber", label: "Artikel", width: "minmax(160px, 1fr)" },
    { key: "locationName", label: "Lagerplats", width: "140px" },
    { key: "transactionType", label: "Typ", width: "170px" },
    { key: "quantityDelta", label: "Mängd", width: "80px", align: "right" as const },
    ...(showBalance ? [{ key: "balance", label: "Saldo", width: "80px", align: "right" as const }] : []),
    { key: "reference", label: "Källa", width: "130px" },
    { key: "createdByName", label: "Vem", width: "120px" },
    ...(showCost
      ? [
          { key: "unitCost", label: "À-pris", width: "90px", align: "right" as const },
          { key: "value", label: "Värde", width: "100px", align: "right" as const },
        ]
      : []),
    { key: "note", label: "Anteckning", width: "minmax(120px, 1fr)" },
  ];

  return (
    <>
      <ListToolbar placeholder="Sök artikelnummer eller benämning…">
        <div style={{ minWidth: 260, flex: "1 1 260px", maxWidth: 360 }}>
          <ArticlePicker
            id="logArticle"
            value={article}
            onChange={(a) => setFilter("article", a ? a.id : null)}
            placeholder="Filtrera på artikel…"
          />
        </div>
        <ListFilterSelect
          param="location"
          allLabel="Alla lagerplatser"
          ariaLabel="Filtrera på lagerplats"
          options={locations.map((l) => ({ value: l.id, label: `${l.warehouseName} — ${l.name}${l.active ? "" : " (inaktiv)"}` }))}
        />
        <ListFilterSelect
          param="type"
          allLabel="Alla typer"
          ariaLabel="Filtrera på typ"
          options={Object.entries(STOCK_TRANSACTION_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ListFilterSelect
          param="direction"
          allLabel="In och ut"
          ariaLabel="Filtrera på riktning"
          options={[
            { value: "in", label: "Inflöden" },
            { value: "out", label: "Utflöden" },
          ]}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Från" htmlFor="logFrom">
            <Input
              id="logFrom"
              type="date"
              size="sm"
              value={params.get("from") ?? ""}
              onChange={(e) => setFilter("from", e.target.value || null)}
            />
          </Field>
          <Field label="Till" htmlFor="logTo">
            <Input
              id="logTo"
              type="date"
              size="sm"
              value={params.get("to") ?? ""}
              onChange={(e) => setFilter("to", e.target.value || null)}
            />
          </Field>
        </div>
        <ListExportLink
          endpoint="/api/v1/stock/transactions/csv"
          renameParams={{ article: "articleId", location: "locationId" }}
        />
      </ListToolbar>

      <Table<StockTransaction>
        columns={columns}
        rows={transactions.rows}
        emptyText="Inga transaktioner matchar filtren"
        renderCell={(row, key) => {
          switch (key) {
            case "createdAt":
              return new Date(row.createdAt).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });
            case "articleNumber":
              return `${row.articleNumber} — ${row.articleName}`;
            case "locationName":
              // Stock can be tracked without locations.
              return row.locationName ? `${row.warehouseName} — ${row.locationName}` : "—";
            case "transactionType":
              return STOCK_TRANSACTION_TYPE_LABELS[row.transactionType];
            case "quantityDelta":
              return signed(Number(row.quantityDelta));
            case "balance":
              return row.balance === null ? "—" : String(Number(row.balance));
            case "reference":
              return <ReferenceCell reference={row.reference} quantityDelta={row.quantityDelta} />;
            case "createdByName":
              return row.createdByName ?? "—";
            case "unitCost":
              return money(row.unitCost);
            case "value":
              return money(row.value);
            case "note":
              return row.note ?? "–";
            default:
              return null;
          }
        }}
      />

      <Pagination total={transactions.total} pageSize={pageSize} />
    </>
  );
}

