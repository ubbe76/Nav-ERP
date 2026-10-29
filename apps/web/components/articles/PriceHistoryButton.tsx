"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";
import { FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { formatStockholmDateTime } from "../../lib/date";
import type { ArticlePriceHistory, ArticlePriceHistoryRow } from "../../lib/types";

const TITLES: Record<keyof ArticlePriceHistory, string> = {
  standardCost: "Historik för standardkostnad",
  salesPrice: "Historik för försäljningspris",
};

// Prishistorik for one of the article's own prices, newest first. Fetched
// when opened, so a price saved a moment ago is in the list.
export function PriceHistoryButton({ articleId, kind }: { articleId: string; kind: keyof ArticlePriceHistory }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ArticlePriceHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    setRows(null);
    setError(null);
    try {
      const history = await apiFetch<ArticlePriceHistory>(`/api/v1/articles/${articleId}/price-history`);
      setRows(history[kind]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta historiken");
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" size="small" onClick={() => void show()}>
        Historik
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={TITLES[kind]} compact>
        <FormError>{error}</FormError>
        {rows === null && !error && <p>Hämtar historiken…</p>}
        {rows !== null && (
          <>
            <Table<ArticlePriceHistoryRow & { id: string }>
              columns={[
                { key: "validFrom", label: "Från och med", width: "1fr" },
                { key: "value", label: kind === "salesPrice" ? "Pris" : "Kostnad", width: "140px", align: "right" },
              ]}
              rows={rows.map((row, i) => ({ ...row, id: String(i) }))}
              emptyText="Ingen historik ännu"
              renderCell={(row, key) => {
                if (key === "validFrom") return formatStockholmDateTime(row.validFrom);
                if (row.value === null) return "inget pris";
                return `${Number(row.value).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} kr`;
              }}
            />
            <FormHint>Historiken börjar när funktionen infördes — tidigare värden är okända.</FormHint>
          </>
        )}
      </Modal>
    </>
  );
}
