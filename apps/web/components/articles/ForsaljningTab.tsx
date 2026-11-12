"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { confirmDelete } from "../../lib/confirm";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { currencyLabel, SEK } from "../../lib/currency";
import { formatQuantity, formatUnitPrice } from "../../lib/format";
import type {
  Article,
  ArticleSalesCustomer,
  ArticleSalesGroupRule,
  ArticleSalesPriceList,
  ArticleSalesPriceStep,
  ArticleSalesPrices,
  ArticleUnit,
  Customer,
} from "../../lib/types";
import { useCan } from "../PermissionsProvider";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { SearchPicker } from "../ui/SearchPicker";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { PriceHistoryButton } from "./PriceHistoryButton";
import formStyles from "./ArticleForm.module.css";
import styles from "./ForsaljningTab.module.css";

const num = (v: string | number | null | undefined) => (v == null ? "" : String(Number(v)));

// Fliken Försäljning: Försäljningsenhet/-pris (moved from Allmänt), the
// customers' own prices and article numbers, the price lists and — read-only —
// the customers' rules on the article's varugrupp. One GET, reloaded after
// every save. Stays mounted once opened and reports unsaved edits to the card.
export function ForsaljningTab({
  article,
  onDirtyChange,
}: {
  article: Article;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const canArticles = can(["artiklar"]);
  const canSell = can(["forsaljning"]);
  const isAdmin = can(["admin"]);

  const [data, setData] = useState<ArticleSalesPrices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [articleUnits, setArticleUnits] = useState<ArticleUnit[]>([]);

  const [salesUnitId, setSalesUnitId] = useState(article.salesUnitId ?? "");
  const [salesPrice, setSalesPrice] = useState(num(article.salesPrice));
  const [saved, setSaved] = useState({ salesUnitId: article.salesUnitId ?? "", salesPrice: num(article.salesPrice) });
  const [savedNote, setSavedNote] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [customerModal, setCustomerModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<ArticleSalesCustomer | null>(null);
  const [listModal, setListModal] = useState(false);
  const [editingList, setEditingList] = useState<ArticleSalesPriceList | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<ArticleSalesPrices>(`/api/v1/articles/${article.id}/sales-prices`));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta försäljningsdata"));
    }
  }, [article.id]);

  useEffect(() => {
    void load();
    apiFetch<ArticleUnit[]>(`/api/v1/articles/${article.id}/units`).then(setArticleUnits).catch(() => setArticleUnits([]));
  }, [article.id, load]);

  // Kalkyl → Sätt försäljningspris changes the article behind our back: follow
  // the new value as long as the field is untouched.
  const propUnit = article.salesUnitId ?? "";
  const propPrice = num(article.salesPrice);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => {
    const prev = savedRef.current;
    if (prev.salesPrice === propPrice && prev.salesUnitId === propUnit) return;
    setSalesPrice((cur) => (cur === prev.salesPrice ? propPrice : cur));
    setSalesUnitId((cur) => (cur === prev.salesUnitId ? propUnit : cur));
    setSaved({ salesPrice: propPrice, salesUnitId: propUnit });
  }, [propPrice, propUnit]);

  const changed: Record<string, unknown> = {};
  if (salesUnitId !== saved.salesUnitId) changed.salesUnitId = salesUnitId === "" ? null : salesUnitId;
  if (salesPrice.trim() !== saved.salesPrice) changed.salesPrice = salesPrice.trim() === "" ? null : Number(salesPrice);
  const dirty = Object.keys(changed).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  async function saveSales(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSavedNote(false);
    if (!dirty) {
      setSavedNote(true);
      return;
    }
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${article.id}`, { method: "PATCH", body: JSON.stringify(changed) });
      setSaved({ salesUnitId, salesPrice: salesPrice.trim() });
      setSavedNote(true);
      router.refresh();
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Kunde inte spara"));
    } finally {
      setPending(false);
    }
  }

  async function removeCustomer(row: ArticleSalesCustomer) {
    if (!(await confirmDelete(`Ta bort kundens priser och artikelnummer för ${row.customerNumber} ${row.customerName}?`))) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/articles/${article.id}/customer-prices/${row.customerId}`, {
        method: "PUT",
        body: JSON.stringify({ customerArticleNumber: null, prices: [] }),
      });
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort kundens priser"));
    }
  }

  async function removeListRows(row: ArticleSalesPriceList) {
    if (!(await confirmDelete(`Ta bort artikeln ur prislistan ${row.code} ${row.name}?`))) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/articles/${article.id}/price-lists/${row.priceListId}`, {
        method: "PUT",
        body: JSON.stringify({ rows: [] }),
      });
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort prislistepriset"));
    }
  }

  const baseUnitCode = article.unit;
  const listsWithArticle = data?.priceLists.filter((l) => l.rows.length > 0) ?? [];
  const listsWithout = data?.priceLists.filter((l) => l.rows.length === 0) ?? [];

  return (
    <div>
      <FormError>{error}</FormError>

      {/* --- Försäljning --- */}
      <Form onSubmit={saveSales}>
        <SectionHeading>Försäljning</SectionHeading>
        <div className={formStyles.grid}>
          <Field label="Försäljningsenhet" htmlFor="salesUnitId">
            <Select
              id="salesUnitId"
              value={salesUnitId}
              disabled={!canArticles}
              onChange={(e) => setSalesUnitId(e.target.value)}
            >
              <option value="">Grundenheten ({baseUnitCode})</option>
              {articleUnits.map((u) => (
                <option key={u.unitId} value={u.unitId}>
                  {u.unitCode} · {u.unitName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Försäljningspris (kr)" htmlFor="salesPrice">
            <Input
              id="salesPrice"
              type="number"
              size="sm"
              min="0"
              step="any"
              disabled={!canArticles}
              value={salesPrice}
              onChange={(e) => setSalesPrice(e.target.value)}
            />
          </Field>
        </div>
        <div className={formStyles.historyAction}>
          <PriceHistoryButton articleId={article.id} kind="salesPrice" />
        </div>
        <FormError>{saveError}</FormError>
        {canArticles && (
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {dirty && !pending && <span>Osparade ändringar</span>}
            {savedNote && !pending && !dirty && <span>Sparat ✓</span>}
          </FormActions>
        )}
      </Form>

      {/* --- Kundpriser --- */}
      <SectionHeading
        spaced
        actions={
          canSell && (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setEditingCustomer(null);
                setCustomerModal(true);
              }}
            >
              + Ny kund
            </Button>
          )
        }
      >
        Kundpriser
      </SectionHeading>
      <Table<ArticleSalesCustomer & { id: string }>
        columns={[
          { key: "customer", label: "Kund", width: "1.4fr" },
          { key: "customerArticleNumber", label: "Kundens art.nr", width: "1fr" },
          { key: "fromQuantity", label: "Från antal", width: "110px", align: "right" },
          { key: "unitPrice", label: "Pris", width: "130px", align: "right" },
          { key: "discountPercent", label: "Rabatt %", width: "100px", align: "right" },
          { key: "setupPrice", label: "Ställpris", width: "120px", align: "right" },
          { key: "actions", label: "", width: "160px", align: "right" },
        ]}
        rows={(data?.customers ?? []).map((c) => ({ ...c, id: c.customerId }))}
        loading={data === null && error === null}
        emptyText="Inga kundpriser eller kundartikelnummer registrerade"
        renderCell={(row, key) => {
          switch (key) {
            case "customer":
              return (
                <GatedLink href={`/kunder/${row.customerId}`}>
                  {row.customerNumber} {row.customerName}
                </GatedLink>
              );
            case "customerArticleNumber":
              return row.customerArticleNumber ?? "–";
            case "fromQuantity":
              return steps(row.prices, (p) => formatQuantity(p.fromQuantity));
            case "unitPrice":
              return steps(row.prices, (p) =>
                p.unitPrice != null ? withCurrency(formatUnitPrice(p.unitPrice), row.currency) : "–"
              );
            case "discountPercent":
              return steps(row.prices, (p) =>
                p.discountPercent != null ? `${Number(p.discountPercent).toLocaleString("sv-SE")} %` : "–"
              );
            case "setupPrice":
              return steps(row.prices, (p) =>
                p.setupPrice != null && Number(p.setupPrice) > 0 ? withCurrency(formatUnitPrice(p.setupPrice), row.currency) : ""
              );
            case "actions":
              return canSell ? (
                <span className={styles.rowActions}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setEditingCustomer(row);
                      setCustomerModal(true);
                    }}
                  >
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removeCustomer(row)}>
                    Ta bort
                  </Button>
                </span>
              ) : null;
            default:
              return null;
          }
        }}
      />

      {/* --- Prislistor --- */}
      {data && data.priceLists.length > 0 && (
        <>
          <SectionHeading
            spaced
            actions={
              isAdmin &&
              listsWithout.length > 0 && (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    setEditingList(null);
                    setListModal(true);
                  }}
                >
                  + Lägg till i prislista
                </Button>
              )
            }
          >
            Prislistor
          </SectionHeading>
          <Table<ArticleSalesPriceList & { id: string }>
            columns={[
              { key: "list", label: "Prislista", width: "1.4fr" },
              { key: "currency", label: "Valuta", width: "90px" },
              { key: "fromQuantity", label: "Från antal", width: "110px", align: "right" },
              { key: "unitPrice", label: "Pris", width: "130px", align: "right" },
              { key: "actions", label: "", width: "160px", align: "right" },
            ]}
            rows={listsWithArticle.map((l) => ({ ...l, id: l.priceListId }))}
            emptyText="Artikeln finns inte i någon prislista"
            renderCell={(row, key) => {
              switch (key) {
                case "list":
                  return `${row.code} ${row.name}`;
                case "currency":
                  return row.currency;
                case "fromQuantity":
                  return steps(row.rows, (r) => formatQuantity(r.fromQuantity));
                case "unitPrice":
                  return steps(row.rows, (r) => formatUnitPrice(r.unitPrice));
                case "actions":
                  return isAdmin ? (
                    <span className={styles.rowActions}>
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        onClick={() => {
                          setEditingList(row);
                          setListModal(true);
                        }}
                      >
                        Ändra
                      </Button>
                      <Button type="button" size="small" variant="danger" onClick={() => removeListRows(row)}>
                        Ta bort
                      </Button>
                    </span>
                  ) : null;
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      {/* --- Kundregler för varugruppen (read-only) --- */}
      {data && data.articleGroup && data.groupRules.length > 0 && (
        <>
          <SectionHeading spaced>
            {`Kundregler för varugruppen ${data.articleGroup.code} ${data.articleGroup.name}`}
          </SectionHeading>
          <Table<ArticleSalesGroupRule & { id: string }>
            columns={[
              { key: "customer", label: "Kund", width: "1.4fr" },
              { key: "fromQuantity", label: "Från antal", width: "110px", align: "right" },
              { key: "unitPrice", label: "Pris", width: "130px", align: "right" },
              { key: "discountPercent", label: "Rabatt %", width: "100px", align: "right" },
              { key: "setupPrice", label: "Ställpris", width: "120px", align: "right" },
            ]}
            rows={data.groupRules.map((r) => ({ ...r, id: r.customerId }))}
            renderCell={(row, key) => {
              switch (key) {
                case "customer":
                  return (
                    <>
                      <GatedLink href={`/kunder/${row.customerId}`}>
                        {row.customerNumber} {row.customerName}
                      </GatedLink>
                      {row.hasArticlePrices && (
                        <div className={styles.notice}>
                          Kunden har egna artikelpriser, de går före gruppregeln från sina antal.
                        </div>
                      )}
                    </>
                  );
                case "fromQuantity":
                  return steps(row.rules, (p) => formatQuantity(p.fromQuantity));
                case "unitPrice":
                  return steps(row.rules, (p) =>
                    p.unitPrice != null ? withCurrency(formatUnitPrice(p.unitPrice), row.currency) : "–"
                  );
                case "discountPercent":
                  return steps(row.rules, (p) =>
                    p.discountPercent != null ? `${Number(p.discountPercent).toLocaleString("sv-SE")} %` : "–"
                  );
                case "setupPrice":
                  return steps(row.rules, (p) =>
                    p.setupPrice != null && Number(p.setupPrice) > 0 ? withCurrency(formatUnitPrice(p.setupPrice), row.currency) : ""
                  );
                default:
                  return null;
              }
            }}
          />
          <FormHint>Gruppreglerna ändras på kundkortets flik Priser.</FormHint>
        </>
      )}

      <Modal
        open={customerModal}
        onClose={() => setCustomerModal(false)}
        title="Kundpris"
        wide
      >
        {customerModal && (
          <CustomerPriceDialog
            articleId={article.id}
            unitCode={article.unit}
            existing={data?.customers ?? []}
            editing={editingCustomer}
            onSuccess={async () => {
              setCustomerModal(false);
              await load();
            }}
          />
        )}
      </Modal>
      <Modal open={listModal} onClose={() => setListModal(false)} title="Prislistepris">
        {listModal && (
          <PriceListDialog
            articleId={article.id}
            unitCode={article.unit}
            lists={data?.priceLists ?? []}
            editing={editingList}
            onSuccess={async () => {
              setListModal(false);
              await load();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function steps<T extends { id: string }>(items: T[], text: (item: T) => string) {
  if (items.length === 0) return "–";
  return (
    <div className={styles.steps}>
      {items.map((item) => (
        <div key={item.id}>{text(item) || " "}</div>
      ))}
    </div>
  );
}

// A staffel field: the grid's header row names the columns on a wide screen;
// on a narrow one the header is hidden and each field shows its own label.
function StepCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.cell}>
      <span className={styles.cellLabel}>{label}</span>
      {children}
    </label>
  );
}

function withCurrency(text: string, currency: string): string {
  return currency === SEK ? text : `${text} ${currency}`;
}

interface StepDraft {
  key: number;
  fromQuantity: string;
  unitPrice: string;
  discountPercent: string;
  setupPrice: string;
}

let stepKey = 0;
const newStep = (init: Partial<StepDraft> = {}): StepDraft => ({
  key: ++stepKey,
  fromQuantity: "",
  unitPrice: "",
  discountPercent: "",
  setupPrice: "",
  ...init,
});

function CustomerPriceDialog({
  articleId,
  unitCode,
  existing,
  editing,
  onSuccess,
}: {
  articleId: string;
  unitCode: string;
  existing: ArticleSalesCustomer[];
  editing: ArticleSalesCustomer | null;
  onSuccess: () => void | Promise<void>;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerArticleNumber, setCustomerArticleNumber] = useState(editing?.customerArticleNumber ?? "");
  const fromRows = (prices: ArticleSalesPriceStep[]): StepDraft[] =>
    prices.length === 0
      ? [newStep({ fromQuantity: "1" })]
      : prices.map((p) =>
          newStep({
            fromQuantity: num(p.fromQuantity),
            unitPrice: num(p.unitPrice),
            discountPercent: num(p.discountPercent),
            setupPrice: p.setupPrice != null && Number(p.setupPrice) > 0 ? num(p.setupPrice) : "",
          })
        );
  const [rows, setRows] = useState<StepDraft[]>(() => fromRows(editing?.prices ?? []));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const currency = editing?.currency ?? customer?.currency ?? SEK;

  // A customer that already has values: load them instead of starting blank.
  function pickCustomer(c: Customer | null) {
    setCustomer(c);
    const found = c ? existing.find((e) => e.customerId === c.id) : undefined;
    if (found) {
      setCustomerArticleNumber(found.customerArticleNumber ?? "");
      setRows(fromRows(found.prices));
    }
  }

  const update = (key: number, patch: Partial<StepDraft>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const target = editing?.customerId ?? customer?.id;
    if (!target) {
      setError("Välj en kund");
      return;
    }
    const seen = new Set<number>();
    for (const r of rows) {
      if (r.fromQuantity.trim() === "") {
        setError("Ange Från antal på varje rad");
        return;
      }
      const hasPrice = r.unitPrice.trim() !== "";
      const hasDiscount = r.discountPercent.trim() !== "";
      if (hasPrice === hasDiscount) {
        setError("Ange antingen Pris eller Rabatt % på varje rad");
        return;
      }
      const q = Number(r.fromQuantity);
      if (seen.has(q)) {
        setError("Från antal måste vara olika på varje rad");
        return;
      }
      seen.add(q);
    }
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/customer-prices/${target}`, {
        method: "PUT",
        body: JSON.stringify({
          customerArticleNumber: customerArticleNumber.trim() === "" ? null : customerArticleNumber.trim(),
          prices: rows.map((r) => ({
            fromQuantity: r.fromQuantity,
            ...(r.unitPrice.trim() !== "" ? { unitPrice: r.unitPrice } : { discountPercent: r.discountPercent }),
            ...(r.setupPrice.trim() !== "" ? { setupPrice: r.setupPrice } : {}),
          })),
        }),
      });
      await onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara kundpriset"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Kund" htmlFor="articleCustomerPrice-customer">
        {editing ? (
          <Input id="articleCustomerPrice-customer" disabled value={`${editing.customerNumber} — ${editing.customerName}`} />
        ) : (
          <SearchPicker
            id="articleCustomerPrice-customer"
            endpoint="/api/v1/customers"
            value={customer}
            onChange={pickCustomer}
            formatLabel={(c) => `${c.customerNumber} — ${c.name}`}
            placeholder="Sök kundnummer eller namn…"
            emptyText="Inga kunder matchar sökningen"
          />
        )}
      </Field>
      <Field label="Kundens artikelnummer" htmlFor="articleCustomerPrice-number">
        <Input
          id="articleCustomerPrice-number"
          maxLength={50}
          value={customerArticleNumber}
          onChange={(e) => setCustomerArticleNumber(e.target.value)}
        />
      </Field>

      <div className={`${styles.stepGrid} ${styles.stepHead}`}>
        <span>Från antal</span>
        <span>Pris ({currencyLabel(currency)})</span>
        <span>Rabatt %</span>
        <span>Ställpris ({currencyLabel(currency)})</span>
        <span />
      </div>
      {rows.map((r) => (
        <div key={r.key} className={styles.stepGrid}>
          <StepCell label="Från antal">
            <Input
              aria-label="Från antal"
              type="number"
              min="0"
              step="any"
              value={r.fromQuantity}
              onChange={(e) => update(r.key, { fromQuantity: e.target.value })}
            />
          </StepCell>
          <StepCell label={`Pris (${currencyLabel(currency)})`}>
            <Input
              aria-label="Pris"
              type="number"
              step="any"
              value={r.unitPrice}
              onChange={(e) => update(r.key, { unitPrice: e.target.value })}
            />
          </StepCell>
          <StepCell label="Rabatt %">
            <Input
              aria-label="Rabatt %"
              type="number"
              step="0.01"
              value={r.discountPercent}
              onChange={(e) => update(r.key, { discountPercent: e.target.value })}
            />
          </StepCell>
          <StepCell label={`Ställpris (${currencyLabel(currency)})`}>
            <Input
              aria-label="Ställpris"
              type="number"
              step="any"
              value={r.setupPrice}
              onChange={(e) => update(r.key, { setupPrice: e.target.value })}
            />
          </StepCell>
          <Button
            type="button"
            size="small"
            variant="ghost"
            aria-label="Ta bort staffelsteg"
            onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
          >
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" size="small" variant="ghost" onClick={() => setRows((prev) => [...prev, newStep()])}>
          + Lägg till staffelsteg
        </Button>
      </div>
      <p className={styles.hint}>
        Priserna gäller per grundenhet ({currencyLabel(currency)}/{unitCode}) i kundens valuta och bara på order i
        kundens valuta. Tomma staffelsteg och tomt artikelnummer tar bort kunden från artikeln.
      </p>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}

function PriceListDialog({
  articleId,
  unitCode,
  lists,
  editing,
  onSuccess,
}: {
  articleId: string;
  unitCode: string;
  lists: ArticleSalesPriceList[];
  editing: ArticleSalesPriceList | null;
  onSuccess: () => void | Promise<void>;
}) {
  const available = lists.filter((l) => l.rows.length === 0);
  const [listId, setListId] = useState(editing?.priceListId ?? "");
  const [rows, setRows] = useState<StepDraft[]>(() =>
    editing && editing.rows.length > 0
      ? editing.rows.map((r) => newStep({ fromQuantity: num(r.fromQuantity), unitPrice: num(r.unitPrice) }))
      : [newStep({ fromQuantity: "1" })]
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const currency = lists.find((l) => l.priceListId === listId)?.currency ?? SEK;

  const update = (key: number, patch: Partial<StepDraft>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (listId === "") {
      setError("Välj en prislista");
      return;
    }
    const seen = new Set<number>();
    for (const r of rows) {
      if (r.fromQuantity.trim() === "" || r.unitPrice.trim() === "") {
        setError("Ange Från antal och Pris på varje rad");
        return;
      }
      const q = Number(r.fromQuantity);
      if (seen.has(q)) {
        setError("Från antal måste vara olika på varje rad");
        return;
      }
      seen.add(q);
    }
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/price-lists/${listId}`, {
        method: "PUT",
        body: JSON.stringify({ rows: rows.map((r) => ({ fromQuantity: r.fromQuantity, unitPrice: r.unitPrice })) }),
      });
      await onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara prislistepriset"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Prislista" htmlFor="articlePriceList-list">
        <Select
          id="articlePriceList-list"
          value={listId}
          disabled={editing !== null}
          onChange={(e) => setListId(e.target.value)}
        >
          <option value="">— Välj prislista —</option>
          {(editing ? lists.filter((l) => l.priceListId === editing.priceListId) : available).map((l) => (
            <option key={l.priceListId} value={l.priceListId}>
              {l.code} {l.name} ({l.currency})
            </option>
          ))}
        </Select>
      </Field>
      <div className={`${styles.stepGrid} ${styles.stepGridTwo} ${styles.stepHead}`}>
        <span>Från antal</span>
        <span>Pris ({currencyLabel(currency)})</span>
        <span />
      </div>
      {rows.map((r) => (
        <div key={r.key} className={`${styles.stepGrid} ${styles.stepGridTwo}`}>
          <StepCell label="Från antal">
            <Input
              aria-label="Från antal"
              type="number"
              min="0"
              step="any"
              value={r.fromQuantity}
              onChange={(e) => update(r.key, { fromQuantity: e.target.value })}
            />
          </StepCell>
          <StepCell label={`Pris (${currencyLabel(currency)})`}>
            <Input
              aria-label="Pris"
              type="number"
              step="any"
              value={r.unitPrice}
              onChange={(e) => update(r.key, { unitPrice: e.target.value })}
            />
          </StepCell>
          <Button
            type="button"
            size="small"
            variant="ghost"
            aria-label="Ta bort staffelsteg"
            onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
          >
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" size="small" variant="ghost" onClick={() => setRows((prev) => [...prev, newStep()])}>
          + Lägg till staffelsteg
        </Button>
      </div>
      <p className={styles.hint}>
        Priserna gäller per grundenhet ({currencyLabel(currency)}/{unitCode}) i prislistans valuta.
      </p>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}
