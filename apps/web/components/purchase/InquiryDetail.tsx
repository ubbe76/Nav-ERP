"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { DocumentHeaderCard } from "../documents/DocumentHeaderCard";
import { DocumentActionBar } from "../documents/DocumentActionBar";
import { TermsFields, termsFrom, termsLabel, termsPayload, type TermsRegisters, type TermsValue } from "../documents/TermsFields";
import { toUnitPrice, toUnitQuantity } from "../../lib/units";
import { formatMoney } from "../../lib/format";
import { apiFetch } from "../../lib/api";
import {
  INQUIRY_STATUS_PILL,
  type Article,
  type Inquiry,
  type InquiryRow,
  type LegoOperationOption,
  type PurchaseOrder,
} from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";

interface InquiryDetailProps {
  inquiry: Inquiry;
  rows: InquiryRow[];
  registers: TermsRegisters;
}

// A row bought from a subcontractor against one of the article's own
// operations (MO or routing) rather than a plain purchase.
function isLegoRow(row: InquiryRow): boolean {
  return row.moOperationId !== null || row.routingOperationId !== null;
}

// Förfrågansdetalj — rows stay editable through "answered" (that's when
// supplier prices are filled in); ordered/cancelled inquiries are frozen.
export function InquiryDetail({ inquiry, rows, registers }: InquiryDetailProps) {
  const router = useRouter();
  const pill = INQUIRY_STATUS_PILL[inquiry.status];
  const editable = inquiry.status === "draft" || inquiry.status === "sent" || inquiry.status === "answered";

  const [modal, setModal] = useState<"header" | "addRow" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Info banner for "Uppdatera beredningens legopris" — a success message
  // rather than a router.refresh()-worthy new view.
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  // Row being edited, and its drafts. Quantities/prices are edited in the
  // row's unit; the article is fetched so the unit dropdown knows the
  // base + alternative units.
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editUnitId, setEditUnitId] = useState("");
  // Ställpris — only edited on lego rows, see the setupPrice column below.
  const [editSetupPrice, setEditSetupPrice] = useState("");
  const [editArticle, setEditArticle] = useState<Article | null>(null);
  const editUnitOptions = useUnitOptions(editArticle);
  const editFactor = editUnitOptions.find((o) => o.value === editUnitId)?.factor ?? 1;

  // Unanswered rows have no price yet, so the total only covers the answered
  // ones — the footer label says so rather than passing it off as the whole
  // inquiry. Quantity and price are both in the article's base unit, so the
  // line amount is unit-agnostic. A lego row's ställpris is a one-off charge
  // added once per row (PO parity).
  const priced = rows.filter((r) => r.unitPrice !== null);
  const total = priced.reduce(
    (sum, r) => sum + Number(r.quantity) * Number(r.unitPrice) + (r.setupPrice !== null ? Number(r.setupPrice) : 0),
    0
  );

  function refresh() {
    setModal(null);
    router.refresh();
  }

  function startEditRow(row: InquiryRow) {
    setEditingRowId(row.id);
    setEditQuantity(String(toUnitQuantity(Number(row.quantity), row.unitFactor)));
    setEditPrice(row.unitPrice !== null ? String(toUnitPrice(Number(row.unitPrice), row.unitFactor)) : "");
    setEditUnitId(row.unitId ?? "");
    setEditSetupPrice(row.setupPrice !== null ? String(Number(row.setupPrice)) : "");
    setEditArticle(null);
    apiFetch<Article>(`/api/v1/articles/${row.articleId}`).then(setEditArticle).catch(() => {});
  }

  function switchEditUnit(option: UnitOption) {
    setEditQuantity((q) => convertQuantityInput(q, editFactor, option.factor));
    setEditPrice((p) => convertPriceInput(p, editFactor, option.factor));
    setEditUnitId(option.value);
  }

  async function action(path: string, after?: (result: unknown) => void) {
    setError(null);
    setInfoMessage(null);
    setPending(true);
    try {
      const result = await apiFetch(`/api/v1/inquiries/${inquiry.id}/${path}`, { method: "POST" });
      if (after) after(result);
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Åtgärden misslyckades");
    } finally {
      setPending(false);
    }
  }

  // Writes styckpris/ställpris/leverantör from the answered lego row to the
  // routing operation — only meaningful once the price actually applies.
  async function applyPriceToRouting(row: InquiryRow) {
    if (!(await confirmDialog(`Skriv styckpris, ställpris och leverantör till beredningens operation Op ${row.legoSequenceNo}?`))) {
      return;
    }
    action(`rows/${row.id}/apply-price-to-routing`, () => {
      setInfoMessage("Legopriset är uppdaterat på beredningens operation.");
      router.refresh();
    });
  }

  async function saveRow(row: InquiryRow) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/inquiries/${inquiry.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          quantity: Number(editQuantity),
          unitPrice: editPrice.trim() === "" ? null : Number(editPrice),
          unitId: editUnitId === "" ? null : editUnitId,
          ...(isLegoRow(row) ? { setupPrice: editSetupPrice.trim() === "" ? null : Number(editSetupPrice) } : {}),
        }),
      });
      setEditingRowId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara raden");
    } finally {
      setPending(false);
    }
  }

  async function removeRow(row: InquiryRow) {
    if (!(await confirmDelete(`Ta bort ${row.articleNumber} ur förfrågan?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/inquiries/${inquiry.id}/rows/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort raden");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <DocumentHeaderCard
        pill={pill}
        meta={
          inquiry.purchaseOrderId && inquiry.purchaseOrderNumber ? (
            <>
              Beställd som <Link href={`/inkop/ordrar/${inquiry.purchaseOrderId}`}>{inquiry.purchaseOrderNumber}</Link>
            </>
          ) : undefined
        }
        fields={[
          { label: "Leverantör", value: inquiry.supplierName, href: `/leverantorer/${inquiry.supplierId}` },
          { label: "Önskad leverans", value: inquiry.expectedDeliveryDate },
          { label: "Frakt på vårt konto", value: inquiry.freightPaidByUs ? "Ja" : "Nej" },
          { label: "Leveransvillkor", value: termsLabel(inquiry.deliveryTermCode, inquiry.deliveryTermName) },
          { label: "Betalningsvillkor", value: termsLabel(inquiry.paymentTermCode, inquiry.paymentTermName) },
          { label: "Speditör", value: termsLabel(inquiry.carrierCode, inquiry.carrierName) },
        ]}
        note={inquiry.note}
        onEdit={editable ? () => setModal("header") : undefined}
      />

      <FormError margin="below">{error}</FormError>
      {infoMessage && <FormSaved>{infoMessage}</FormSaved>}

      {rows.length > 0 ? (
        <Table<InquiryRow>
          columns={[
            { key: "articleNumber", label: "Artikel", width: "1fr" },
            { key: "quantity", label: "Antal", width: "140px", align: "right" },
            { key: "unitCode", label: "Enhet", width: "90px" },
            { key: "unitPrice", label: "Á-pris", width: "160px", align: "right" },
            { key: "setupPrice", label: "Ställpris", width: "130px", align: "right" },
            { key: "lineAmount", label: "Belopp", width: "140px", align: "right" },
            { key: "id", label: "", width: "180px", align: "right" },
          ]}
          rows={rows}
          footer={
            priced.length > 0
              ? {
                  unitPrice: priced.length === rows.length ? "Summa" : "Summa besvarade",
                  lineAmount: formatMoney(total),
                }
              : undefined
          }
          renderCell={(row, key) => {
            switch (key) {
              case "articleNumber": {
                // Lego rows show which operation they buy under the article
                // name — moOrderNumber is set once the operation is a TO,
                // otherwise it's still just the article's routing.
                const opLabel = `Op ${row.legoSequenceNo}${row.legoDescription ? ` · ${row.legoDescription}` : ""}`;
                const legoLine =
                  row.legoSequenceNo !== null
                    ? row.moOrderNumber
                      ? `Lego för ${row.moOrderNumber} · ${opLabel}`
                      : `Lego · ${opLabel}`
                    : null;
                return (
                  <>
                    {`${row.articleNumber} — ${row.articleName}`}
                    {legoLine && (
                      <div style={{ color: "var(--color-text-muted)", fontSize: 12 }}>{legoLine}</div>
                    )}
                  </>
                );
              }
              case "quantity":
                // Displayed/edited in the row's unit — stored in the base unit.
                return editingRowId === row.id ? (
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    size="sm"
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(e.target.value)}
                    autoFocus
                  />
                ) : (
                  toUnitQuantity(Number(row.quantity), row.unitFactor)
                );
              case "unitCode":
                return editingRowId === row.id ? (
                  <UnitSelect id={`rowUnit-${row.id}`} options={editUnitOptions} value={editUnitId} onChange={switchEditUnit} />
                ) : (
                  row.unitCode
                );
              case "unitPrice":
                return editingRowId === row.id ? (
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    size="sm"
                    value={editPrice}
                    onChange={(e) => setEditPrice(e.target.value)}
                  />
                ) : row.unitPrice !== null ? (
                  formatMoney(toUnitPrice(Number(row.unitPrice), row.unitFactor))
                ) : (
                  "–"
                );
              case "setupPrice":
                if (!isLegoRow(row)) return "–";
                return editingRowId === row.id ? (
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    size="sm"
                    value={editSetupPrice}
                    onChange={(e) => setEditSetupPrice(e.target.value)}
                  />
                ) : row.setupPrice !== null ? (
                  formatMoney(Number(row.setupPrice))
                ) : (
                  "–"
                );
              case "lineAmount":
                return row.unitPrice !== null
                  ? formatMoney(Number(row.quantity) * Number(row.unitPrice) + (row.setupPrice !== null ? Number(row.setupPrice) : 0))
                  : "–";
              case "id": {
                if (editingRowId === row.id) {
                  return (
                    <span style={{ display: "inline-flex", gap: 8 }}>
                      <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => saveRow(row)}>
                        Spara
                      </Button>
                      <Button type="button" size="small" variant="ghost" onClick={() => setEditingRowId(null)}>
                        Avbryt
                      </Button>
                    </span>
                  );
                }
                // Prisåterföring is available on answered/ordered lego rows
                // with a supplier price — independent of whether the row is
                // otherwise editable (an ordered inquiry is frozen but its
                // lego price can still be pushed to the routing).
                const canApplyPrice =
                  isLegoRow(row) &&
                  row.unitPrice !== null &&
                  row.routingOperationId !== null &&
                  row.legoSequenceNo !== null &&
                  (inquiry.status === "answered" || inquiry.status === "ordered");
                if (!editable && !canApplyPrice) return null;
                return (
                  <span style={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
                    {editable && (
                      <>
                        <Button type="button" size="small" variant="ghost" onClick={() => startEditRow(row)}>
                          Ändra
                        </Button>
                        <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => removeRow(row)}>
                          Ta bort
                        </Button>
                      </>
                    )}
                    {canApplyPrice && (
                      <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void applyPriceToRouting(row)}>
                        Uppdatera beredningens legopris
                      </Button>
                    )}
                  </span>
                );
              }
              default:
                return null;
            }
          }}
        />
      ) : (
        <p>Inga rader tillagda än.</p>
      )}

      <DocumentActionBar>
        {editable && (
          <Button type="button" variant="secondary" onClick={() => setModal("addRow")}>
            Lägg till rad
          </Button>
        )}

        {inquiry.status === "draft" && (
          <Button type="button" variant="primary" disabled={pending} onClick={() => action("send")}>
            Skicka förfrågan
          </Button>
        )}

        {inquiry.status === "sent" && (
          <Button type="button" variant="primary" disabled={pending} onClick={() => action("mark-answered")}>
            Markera besvarad
          </Button>
        )}

        {(inquiry.status === "sent" || inquiry.status === "answered") && (
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={() =>
              action("convert-to-order", (result) => {
                const order = result as PurchaseOrder;
                router.push(`/inkop/ordrar/${order.id}`);
              })
            }
          >
            Gör till inköpsorder
          </Button>
        )}

        {editable && (
          <Button type="button" variant="danger" disabled={pending} onClick={() => action("cancel")}>
            Avbryt förfrågan
          </Button>
        )}

        {!editable && !inquiry.purchaseOrderId && <FormHint>Inga åtgärder tillgängliga.</FormHint>}
      </DocumentActionBar>

      <Modal open={modal === "header"} onClose={() => setModal(null)} title="Ändra villkor och frakt">
        <EditHeaderForm inquiry={inquiry} registers={registers} onDone={refresh} onCancel={() => setModal(null)} />
      </Modal>

      <Modal open={modal === "addRow"} onClose={() => setModal(null)} title="Lägg till rad">
        <AddInquiryRowForm inquiryId={inquiry.id} onDone={refresh} onCancel={() => setModal(null)} />
      </Modal>
    </div>
  );
}

// --- Villkor + "Frakt på vårt konto" ---
// One PATCH /inquiries/:id, no revision question — inquiries have no
// revision. Freight prints our carrier customer number on the förfrågan PDF
// and carries to the purchase order on convert.

function EditHeaderForm({
  inquiry,
  registers,
  onDone,
  onCancel,
}: {
  inquiry: Inquiry;
  registers: TermsRegisters;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [terms, setTerms] = useState<TermsValue>(termsFrom(inquiry));
  const [freightPaidByUs, setFreightPaidByUs] = useState(inquiry.freightPaidByUs);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/inquiries/${inquiry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...termsPayload(terms), freightPaidByUs }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={save}>
      <FormError>{error}</FormError>

      <TermsFields registers={registers} value={terms} onChange={setTerms} />

      <Field label="Frakt på vårt konto" htmlFor="inquiryFreightPaidByUs">
        <Toggle
          id="inquiryFreightPaidByUs"
          checked={freightPaidByUs}
          onChange={(e) => setFreightPaidByUs(e.target.checked)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

function AddInquiryRowForm({
  inquiryId,
  onDone,
  onCancel,
}: {
  inquiryId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [unitId, setUnitId] = useState(""); // "" = the article's base unit
  // Legooperation the row buys, if any — "" = ordinary purchase row.
  const [legoOptions, setLegoOptions] = useState<LegoOperationOption[]>([]);
  const [legoOptionKey, setLegoOptionKey] = useState("");
  const [setupPrice, setSetupPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;
  const legoOption = legoOptions.find((o) => o.key === legoOptionKey) ?? null;

  // Picking an article pre-selects its purchase unit and fetches the
  // article's lego operations (MO/routing) it could be quoted against;
  // switching article resets any previously chosen legooperation.
  function handleArticleChange(next: Article | null) {
    setArticle(next);
    setUnitId(next?.purchaseUnitId ?? "");
    setLegoOptions([]);
    setLegoOptionKey("");
    setSetupPrice("");
    if (next) {
      apiFetch<LegoOperationOption[]>(`/api/v1/articles/${next.id}/lego-operations`)
        .then(setLegoOptions)
        .catch(() => setLegoOptions([]));
    }
  }

  function handleUnitChange(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
  }

  function handleLegoOptionChange(key: string) {
    setLegoOptionKey(key);
    const option = legoOptions.find((o) => o.key === key) ?? null;
    setSetupPrice(option?.setupPrice ?? "");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!article) {
      setError("Välj en artikel");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/inquiries/${inquiryId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          unitPrice: unitPrice.trim() === "" ? undefined : Number(unitPrice),
          unitId: unitId === "" ? null : unitId,
          ...(legoOption?.kind === "routing" ? { routingOperationId: legoOption.routingOperationId } : {}),
          ...(legoOption?.kind === "mo" ? { moOperationId: legoOption.moOperationId } : {}),
          ...(legoOption ? { setupPrice: setupPrice.trim() === "" ? undefined : Number(setupPrice) } : {}),
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte lägga till raden");
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Artikel" htmlFor="inquiryRowArticle">
        <ArticlePicker orderable id="inquiryRowArticle" value={article} onChange={handleArticleChange} />
      </Field>

      <FormRow columns={3}>
        <Field label="Antal" htmlFor="inquiryRowQuantity">
          <Input
            id="inquiryRowQuantity"
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field label="Enhet" htmlFor="inquiryRowUnit">
          <UnitSelect id="inquiryRowUnit" options={unitOptions} value={unitId} onChange={handleUnitChange} />
        </Field>
        <Field label={unitCode ? `Á-pris (kr/${unitCode})` : "Á-pris (valfritt)"} htmlFor="inquiryRowPrice">
          <Input
            id="inquiryRowPrice"
            type="number"
            min="0"
            step="0.01"
            size="sm"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </Field>
      </FormRow>

      {legoOptions.length > 0 && (
        <FormRow>
          <Field label="Legooperation" htmlFor="inquiryRowLegoOperation">
            <Select
              id="inquiryRowLegoOperation"
              value={legoOptionKey}
              onChange={(e) => handleLegoOptionChange(e.target.value)}
            >
              <option value="">Ingen (vanlig rad)</option>
              {legoOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          {legoOption && (
            <Field label="Ställpris" htmlFor="inquiryRowSetupPrice">
              <Input
                id="inquiryRowSetupPrice"
                type="number"
                min="0"
                step="0.01"
                size="sm"
                value={setupPrice}
                onChange={(e) => setSetupPrice(e.target.value)}
              />
            </Field>
          )}
        </FormRow>
      )}
      {legoOptions.length > 0 && (
        <FormHint>
          Förfrågans leverantör används — operationens egen leverantör ändras inte förrän du klickar Uppdatera
          beredningens legopris.
        </FormHint>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Lägger till…" : "Lägg till rad"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
