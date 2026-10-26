"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import { useCan } from "../PermissionsProvider";
import { NewQuoteForm } from "../sales/NewQuoteForm";
import { NewPurchaseOrderForm } from "../purchase/NewPurchaseOrderForm";
import { NewManufacturingOrderForm } from "../manufacturing/NewManufacturingOrderForm";
import { RefPicker } from "./DeviationFields";
import type { Ref } from "./deviationDraft";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  DEVIATION_LINK_DOCUMENT_LABELS,
  DEVIATION_LINK_DOCUMENT_TYPES_BY_CASE,
  linkedDocumentHref,
  linkedDocumentStatusLabel,
  type Deviation,
  type DeviationLink,
  type DeviationLinkDocumentType,
} from "../../lib/quality";
import { formatStockholmDateTime } from "../../lib/date";
import type { Article, Customer, InvoiceDetail, Supplier } from "../../lib/types";
import styles from "./Deviations.module.css";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

// Where Koppla dokument searches, per document type. The motpart narrows the
// lists that have a filter for it.
function pickerEndpoint(type: DeviationLinkDocumentType, deviation: Deviation): string {
  switch (type) {
    case "credit_invoice":
      return deviation.customerId ? `/api/v1/invoices?type=credit&customerId=${deviation.customerId}` : "/api/v1/invoices?type=credit";
    case "sales_order":
      return "/api/v1/sales-orders?kind=order";
    case "purchase_order":
      return deviation.supplierId ? `/api/v1/purchase-orders?supplierId=${deviation.supplierId}` : "/api/v1/purchase-orders";
    case "manufacturing_order":
      return "/api/v1/manufacturing-orders";
    case "supplier_invoice":
      return deviation.supplierId ? `/api/v1/supplier-invoices?supplierId=${deviation.supplierId}` : "/api/v1/supplier-invoices";
  }
}

function formatPickerItem(type: DeviationLinkDocumentType, item: Record<string, unknown>): string {
  switch (type) {
    case "credit_invoice":
      return `${str(item.invoiceNumber) || "Utkast"} — ${str(item.customerName)}`;
    case "sales_order":
      return `${str(item.orderNumber)} — ${str(item.customerName)}`;
    case "purchase_order":
      return `${str(item.orderNumber)} — ${str(item.supplierName)}`;
    case "manufacturing_order":
      return `${str(item.orderNumber)} — ${str(item.articleNumber)} ${str(item.articleName)}`;
    case "supplier_invoice":
      return `${str(item.registrationNumber)} — ${str(item.supplierName)} (${str(item.invoiceNumber)})`;
  }
}

// A record fetched when a modal opens (the shortcut forms want the whole
// customer/supplier/article, the card only holds ids and names).
function useEntity<T>(url: string | null): { data: T | null; failed: boolean; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; failed: boolean; loading: boolean }>({
    data: null,
    failed: false,
    loading: url !== null,
  });
  useEffect(() => {
    if (!url) {
      setState({ data: null, failed: false, loading: false });
      return;
    }
    let cancelled = false;
    setState({ data: null, failed: false, loading: true });
    apiFetch<T>(url)
      .then((data) => {
        if (!cancelled) setState({ data, failed: false, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, failed: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}

// Shows the children once the records the shortcut form needs have loaded.
function ShortcutBody({ loading, failed, children }: { loading: boolean; failed: boolean; children: ReactNode }) {
  if (failed) return <FormError>Kunde inte hämta uppgifterna — försök igen.</FormError>;
  if (loading) return <FormHint>Hämtar uppgifter…</FormHint>;
  return <>{children}</>;
}

type Shortcut = "salesOrder" | "purchaseOrder" | "manufacturingOrder";

// Kopplade dokument: what the case led to, the shortcuts that create it, and
// Koppla dokument for follow-ups made some other way.
export function DeviationLinksSection({ deviation, canEdit }: { deviation: Deviation; canEdit: boolean }) {
  const router = useRouter();
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [modal, setModal] = useState<"link" | Shortcut | null>(null);

  // Skapa kreditfaktura needs an issued/paid invoice on the case.
  const invoice = useEntity<InvoiceDetail>(canEdit && deviation.invoiceId ? `/api/v1/invoices/${deviation.invoiceId}` : null);
  const creditable = invoice.data !== null && invoice.data.type === "invoice" && (invoice.data.status === "issued" || invoice.data.status === "paid");

  const { type } = deviation;
  const canCredit = type === "customer" && creditable && can(["forsaljning"]);
  const canReplacementOrder = type === "customer" && can(["forsaljning"]);
  const canPurchaseOrder = type === "supplier" && can(["inkop"]);
  const canManufacturingOrder = (type === "customer" || type === "internal") && can(["tillverkning"]);

  async function createCredit() {
    if (!deviation.invoiceId) return;
    if (
      !(await confirmDialog(
        `Skapa en kreditfaktura mot faktura ${deviation.invoiceNumber ?? ""} för ${deviation.deviationNumber}?`,
        { confirmLabel: "Skapa kreditfaktura" }
      ))
    ) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      const credit = await apiFetch<InvoiceDetail>(`/api/v1/invoices/${deviation.invoiceId}/credit`, {
        method: "POST",
        body: JSON.stringify({ deviationId: deviation.id }),
      });
      router.push(`/forsaljning/fakturor/${credit.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa kreditfakturan"));
      setPending(false);
    }
  }

  async function unlink(link: DeviationLink) {
    const name = `${DEVIATION_LINK_DOCUMENT_LABELS[link.documentType].toLowerCase()} ${link.documentNumber ?? ""}`.trim();
    if (!(await confirmDelete(`Ta bort kopplingen till ${name}? Dokumentet finns kvar.`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviation.id}/links/${link.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort kopplingen"));
    } finally {
      setPending(false);
    }
  }

  const article = useEntity<Article>(modal && modal !== "link" && deviation.articleId ? `/api/v1/articles/${deviation.articleId}` : null);
  const customer = useEntity<Customer>(modal === "salesOrder" && deviation.customerId ? `/api/v1/customers/${deviation.customerId}` : null);
  const supplier = useEntity<Supplier>(modal === "purchaseOrder" && deviation.supplierId ? `/api/v1/suppliers/${deviation.supplierId}` : null);
  const shortcutDeviation = { id: deviation.id, number: deviation.deviationNumber, article: article.data, quantity: deviation.quantity };

  return (
    <div className={styles.section}>
      <SectionHeading>Kopplade dokument</SectionHeading>
      <FormHint>
        Dokument avvikelsen ledde till: kreditfakturan, ersättningsordern, inköpsordern eller tillverkningsordern. De
        skapas med knapparna nedan eller kopplas för hand med Koppla dokument.
      </FormHint>
      <FormError>{error}</FormError>

      {deviation.links.length > 0 ? (
        <Table<DeviationLink>
          columns={[
            { key: "documentType", label: "Dokument", width: "160px" },
            { key: "documentNumber", label: "Nummer", width: "minmax(120px, 1fr)" },
            { key: "documentStatus", label: "Status", width: "140px" },
            { key: "createdAt", label: "Kopplad", width: "150px" },
            ...(canEdit ? [{ key: "id", label: "", width: "140px", align: "right" as const }] : []),
          ]}
          rows={deviation.links}
          renderCell={(link, key) => {
            switch (key) {
              case "documentType":
                return DEVIATION_LINK_DOCUMENT_LABELS[link.documentType];
              case "documentNumber":
                return link.deleted ? (
                  <span className={styles.muted}>borttaget</span>
                ) : (
                  <GatedLink href={linkedDocumentHref(link.documentType, link.documentId)} className={styles.photoLink}>
                    {link.documentNumber ?? "–"}
                  </GatedLink>
                );
              case "documentStatus":
                return link.deleted ? "–" : linkedDocumentStatusLabel(link.documentType, link.documentStatus);
              case "createdAt":
                return formatStockholmDateTime(link.createdAt);
              case "id":
                return (
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => unlink(link)}>
                    Ta bort koppling
                  </Button>
                );
              default:
                return null;
            }
          }}
        />
      ) : (
        <p>Inga dokument kopplade.</p>
      )}

      {canEdit && (
        <div className={styles.buttonRow}>
          {canCredit && (
            <Button type="button" variant="secondary" disabled={pending} onClick={createCredit}>
              Skapa kreditfaktura
            </Button>
          )}
          {canReplacementOrder && (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setModal("salesOrder")}>
              Skapa ersättningsorder
            </Button>
          )}
          {canPurchaseOrder && (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setModal("purchaseOrder")}>
              Skapa inköpsorder
            </Button>
          )}
          {canManufacturingOrder && (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setModal("manufacturingOrder")}>
              Skapa tillverkningsorder
            </Button>
          )}
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setModal("link")}>
            Koppla dokument
          </Button>
        </div>
      )}

      <Modal open={modal === "link"} onClose={() => setModal(null)} title="Koppla dokument">
        <LinkDocumentForm
          deviation={deviation}
          onDone={() => {
            setModal(null);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={modal === "salesOrder"} onClose={() => setModal(null)} title="Skapa ersättningsorder" wide>
        <ShortcutBody loading={article.loading || customer.loading} failed={article.failed || customer.failed}>
          {customer.data ? (
            <>
              <FormHint>
                Kundordern skapas för {customer.data.name} med artikeln och antalet från avvikelsen till à-pris 0 och
                kopplas till {deviation.deviationNumber}.
              </FormHint>
              <NewQuoteForm mode="order" lockedCustomer={customer.data} deviation={shortcutDeviation} />
            </>
          ) : (
            <FormError>Avvikelsen saknar kund.</FormError>
          )}
        </ShortcutBody>
      </Modal>

      <Modal open={modal === "purchaseOrder"} onClose={() => setModal(null)} title="Skapa inköpsorder">
        <ShortcutBody loading={article.loading || supplier.loading} failed={article.failed || supplier.failed}>
          {supplier.data ? (
            <>
              <FormHint>
                Inköpsordern skapas hos {supplier.data.name} med artikeln och antalet från avvikelsen och kopplas till{" "}
                {deviation.deviationNumber}.
              </FormHint>
              <NewPurchaseOrderForm lockedSupplier={supplier.data} deviation={shortcutDeviation} />
            </>
          ) : (
            <FormError>Avvikelsen saknar leverantör.</FormError>
          )}
        </ShortcutBody>
      </Modal>

      <Modal open={modal === "manufacturingOrder"} onClose={() => setModal(null)} title="Skapa tillverkningsorder">
        <ShortcutBody loading={article.loading} failed={article.failed}>
          <FormHint>
            Tillverkningsordern — omarbete eller ersättning — skapas på artikeln och antalet från avvikelsen och kopplas
            till {deviation.deviationNumber}.
          </FormHint>
          <NewManufacturingOrderForm deviation={shortcutDeviation} />
        </ShortcutBody>
      </Modal>
    </div>
  );
}

function LinkDocumentForm({ deviation, onDone }: { deviation: Deviation; onDone: () => void }) {
  const types = DEVIATION_LINK_DOCUMENT_TYPES_BY_CASE[deviation.type];
  const [documentType, setDocumentType] = useState<DeviationLinkDocumentType>(types[0]!);
  const [document, setDocument] = useState<Ref | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!document) {
      setError("Välj ett dokument.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviation.id}/links`, {
        method: "POST",
        body: JSON.stringify({ documentType, documentId: document.id }),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte koppla dokumentet"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Dokumenttyp" htmlFor="linkType">
        <Select
          id="linkType"
          value={documentType}
          onChange={(e) => {
            setDocumentType(e.target.value as DeviationLinkDocumentType);
            setDocument(null);
          }}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {DEVIATION_LINK_DOCUMENT_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Dokument" htmlFor="linkDocument">
        <RefPicker
          key={documentType}
          id="linkDocument"
          endpoint={pickerEndpoint(documentType, deviation)}
          value={document}
          onChange={(ref) => setDocument(ref)}
          formatItem={(item) => formatPickerItem(documentType, item)}
          placeholder="Sök nummer…"
          emptyText="Inga dokument matchar sökningen"
        />
      </Field>
      <FormHint>Dokumentet måste höra till samma kund eller leverantör som avvikelsen.</FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Kopplar…" : "Koppla"}
        </Button>
      </FormActions>
    </Form>
  );
}
