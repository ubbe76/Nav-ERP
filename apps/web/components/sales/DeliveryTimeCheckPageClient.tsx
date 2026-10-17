"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { SearchPicker } from "../ui/SearchPicker";
import { HelpLink } from "../ui/HelpLink";
import { Form, FormActions, FormError, FormHint, FormLineRow, FormLineRowTop, FormRow } from "../ui/Form";
import { ConfigureModal } from "../configurator/ConfigureModal";
import { ConfigurationLineList } from "../configurator/ConfigurationLines";
import { DeliveryTimeCheckResult } from "./DeliveryTimeCheckResult";
import { runDeliveryTimeCheck } from "../../lib/deliveryTimeCheck";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { RowConfigurationDraft } from "../../lib/configurator";
import type { Article, Customer, DeliveryTimeCheckResult as Result } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

interface CheckRow {
  article: Article | null;
  quantity: string;
  // Choices made in Konfigurera; the template stays the row's article (the
  // API resolves a variant or a made-to-order configuration itself, and
  // creates no article).
  configuration: RowConfigurationDraft | null;
}

const emptyRow = (): CheckRow => ({ article: null, quantity: "1", configuration: null });

// Fristående Leveranstidskontroll: arbitrary articles and quantities, optional customer.
export function DeliveryTimeCheckPageClient() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [rows, setRows] = useState<CheckRow[]>([emptyRow()]);
  const [result, setResult] = useState<Result | null>(null);
  // The result belongs to the customer it was computed with.
  const [resultWithCustomer, setResultWithCustomer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateRow(index: number, patch: Partial<CheckRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function handleCheck(e: React.FormEvent) {
    e.preventDefault();
    if (rows.some((r) => r.article === null)) {
      setError("Välj artikel på alla rader");
      return;
    }
    if (rows.some((r) => !(Number(r.quantity) > 0))) {
      setError("Ange antal på alla rader");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const withCustomer = customer !== null;
      const r = await runDeliveryTimeCheck({
        ...(customer ? { customerId: customer.id } : {}),
        rows: rows.map((row) => ({
          articleId: row.article!.id,
          quantity: Number(row.quantity),
          ...(row.configuration ? { configuration: { selection: row.configuration.selection } } : {}),
        })),
      });
      setResult(r);
      setResultWithCustomer(withCustomer);
    } catch (err) {
      setResult(null);
      setError(apiErrorMessage(err, "Kunde inte kontrollera leveranstiden"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Leveranstidskontroll</div>
          <div className={shellStyles.meta}>Tidigaste avsändnings- och leveransdag för valfria artiklar och antal</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="leveranstidskontroll" label="Hjälp om leveranstidskontroll" />
      </div>

      <Card maxWidth={760}>
        <Form onSubmit={handleCheck}>
          <FormError>{error}</FormError>

          <Field label="Kund (valfritt)" htmlFor="dtcCustomer">
            <SearchPicker
              id="dtcCustomer"
              endpoint="/api/v1/customers"
              value={customer}
              onChange={setCustomer}
              formatLabel={(c) => `${c.customerNumber} — ${c.name}`}
              placeholder="Sök kundnummer eller namn…"
              emptyText="Inga kunder matchar sökningen"
            />
          </Field>
          <FormHint attached>Med kund räknas leveransdatumet ut från kundens leveransdagar. Antalen anges i artikelns grundenhet.</FormHint>

          <div>
            <div style={{ fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
              Rader
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
              {rows.map((row, index) => (
                <CheckRowFields
                  key={index}
                  index={index}
                  row={row}
                  customerId={customer?.id ?? null}
                  canRemove={rows.length > 1}
                  onChange={(patch) => updateRow(index, patch)}
                  onRemove={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}
                />
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <Button type="button" variant="secondary" size="small" onClick={() => setRows((prev) => [...prev, emptyRow()])}>
                + Lägg till rad
              </Button>
            </div>
          </div>

          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Kontrollerar…" : "Kontrollera"}
            </Button>
          </FormActions>
        </Form>
      </Card>

      {result && (
        <Card maxWidth={760} style={{ marginTop: 16 }}>
          <DeliveryTimeCheckResult result={result} withCustomer={resultWithCustomer} />
        </Card>
      )}
    </>
  );
}

function CheckRowFields({
  index,
  row,
  customerId,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: CheckRow;
  customerId: string | null;
  canRemove: boolean;
  onChange: (patch: Partial<CheckRow>) => void;
  onRemove: () => void;
}) {
  const [configureTemplate, setConfigureTemplate] = useState<Article | null>(null);
  const [configureKey, setConfigureKey] = useState(0);

  function handleArticleChange(article: Article | null) {
    onChange({ article, configuration: null });
    if (article?.configuratorMode === "variants" || article?.configuratorMode === "to_order") {
      setConfigureKey((k) => k + 1);
      setConfigureTemplate(article);
    }
  }

  return (
    <FormLineRow>
      <FormLineRowTop>
        <Field label="Artikel" htmlFor={`dtcArticle-${index}`}>
          <ArticlePicker orderable configurable id={`dtcArticle-${index}`} value={row.article} onChange={handleArticleChange} />
        </Field>
        <Button type="button" variant="ghost" size="small" aria-label="Ta bort rad" disabled={!canRemove} onClick={onRemove}>
          ✕
        </Button>
      </FormLineRowTop>
      {row.configuration && (
        <>
          <ConfigurationLineList lines={row.configuration.lines} />
          <Button
            type="button"
            size="small"
            variant="ghost"
            onClick={() => {
              setConfigureKey((k) => k + 1);
              setConfigureTemplate(row.article);
            }}
          >
            Konfigurera om
          </Button>
        </>
      )}
      <ConfigureModal
        open={configureTemplate !== null}
        openKey={configureKey}
        template={configureTemplate}
        customerId={customerId}
        showPrice={false}
        quantity={Number(row.quantity) > 0 ? Number(row.quantity) : 1}
        initialSelection={row.configuration?.selection}
        onConfigured={(draft) => {
          setConfigureTemplate(null);
          onChange({ configuration: draft });
        }}
        onCancel={() => {
          setConfigureTemplate(null);
          if (!row.configuration) onChange({ article: null });
        }}
      />
      <FormRow columns={4}>
        <Field label="Antal" htmlFor={`dtcQuantity-${index}`}>
          <Input
            id={`dtcQuantity-${index}`}
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={row.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </Field>
      </FormRow>
    </FormLineRow>
  );
}
