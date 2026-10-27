"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type { Article, StockBalance } from "../../lib/types";

interface RowWithId extends StockBalance {
  id: string;
}

// Lager-fliken: a Planering section (behovsberäkning input, E1) above the
// read-only saldo table.
export function LagerTab({ article, balances }: { article: Article; balances: StockBalance[] }) {
  const router = useRouter();
  const [reorderPoint, setReorderPoint] = useState(article.reorderPoint ?? "");
  const [safetyStock, setSafetyStock] = useState(article.safetyStock ?? "");
  const [stockControlled, setStockControlled] = useState(article.stockControlled ? "stock" : "order");
  const [orderQuantity, setOrderQuantity] = useState(article.orderQuantity ?? "");
  const [rounding, setRounding] = useState(article.rounding ?? "");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function savePlanning(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${article.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          reorderPoint: reorderPoint.trim() === "" ? null : Number(reorderPoint),
          safetyStock: safetyStock.trim() === "" ? null : Number(safetyStock),
          stockControlled: stockControlled === "stock",
          orderQuantity: orderQuantity.trim() === "" ? null : Number(orderQuantity),
          rounding: rounding.trim() === "" ? null : Number(rounding),
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  const rows: RowWithId[] = balances.map((b) => ({ ...b, id: `${b.articleId}-${b.locationId}` }));

  return (
    <div>
      <Card maxWidth={640} style={{ marginBottom: 20 }}>
        <SectionHeading>Planering</SectionHeading>
        <Form onSubmit={savePlanning}>
          <FormError>{error}</FormError>
          <FormRow columns={2}>
            <Field label="Styrning" htmlFor="stockControlled">
              <Select
                id="stockControlled"
                value={stockControlled}
                onChange={(e) => setStockControlled(e.target.value)}
              >
                <option value="order">Orderstyrd</option>
                <option value="stock">Lagerstyrd</option>
              </Select>
            </Field>
            <Field label="Säkerhetslager" htmlFor="safetyStock">
              <Input
                id="safetyStock"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={safetyStock}
                onChange={(e) => setSafetyStock(e.target.value)}
              />
            </Field>
          </FormRow>
          <FormRow columns={3}>
            <Field label="Beställningspunkt" htmlFor="reorderPoint">
              <Input
                id="reorderPoint"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={reorderPoint}
                onChange={(e) => setReorderPoint(e.target.value)}
              />
            </Field>
            <Field label="Orderkvantitet" htmlFor="orderQuantity">
              <Input
                id="orderQuantity"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={orderQuantity}
                onChange={(e) => setOrderQuantity(e.target.value)}
              />
            </Field>
            {/* Positive with at most 3 decimals — the server validates; step
                0.001 only sets the browser's stepping, min="0" keeps the step
                base whole (Firefox steps from min). */}
            <Field label="Avrundning" htmlFor="rounding">
              <Input
                id="rounding"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={rounding}
                onChange={(e) => setRounding(e.target.value)}
              />
            </Field>
          </FormRow>
          <FormHint attached>
            Används av behovsberäkningen. Beställningspunkt och Säkerhetslager jämförs mot projicerat saldo — det större av dem är golvet, och
            förslaget fyller upp till det. Styrning (Orderstyrd/Lagerstyrd) är bara information. Förslag avrundas upp till
            närmaste multipel av orderkvantiteten. Avrundning avrundar därefter förslag och orderrader (inköp,
            förfrågan, kundorder, tillverkningsorder) uppåt till närmaste multipel i grundenheten — 1 ger hela tal, 5
            ger 5, 10, 15 …, 7,38 ger hela stänger om 7,38 kg. Högst 3 decimaler.
          </FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && !pending && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>

      <p style={{ margin: "0 0 12px" }}>
        <GatedLink href={`/lager/transaktioner?article=${article.id}`} style={{ color: "var(--accent-fg)" }}>
          Visa lagerlogg
        </GatedLink>
      </p>

      {balances.length === 0 ? (
        <p>Inget saldo registrerat för denna artikel.</p>
      ) : (
        <Table<RowWithId>
          columns={[
            { key: "warehouseName", label: "Lager", width: "1fr" },
            { key: "locationName", label: "Lagerplats", width: "1fr" },
            { key: "quantityOnHand", label: "Saldo", width: "140px", align: "right" },
          ]}
          rows={rows}
          renderCell={(row, key) => {
            if (key === "quantityOnHand") return Number(row.quantityOnHand);
            // Stock can be tracked without locations — those rows show "—".
            if (key === "warehouseName" || key === "locationName") return row[key as keyof RowWithId] ?? "—";
            return row[key as keyof RowWithId];
          }}
        />
      )}
    </div>
  );
}
