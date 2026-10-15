"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { PAYMENT_ITEM_STATUS } from "../../lib/banking";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { SupplierInvoiceDetail } from "../../lib/types";

// Bankfiler: the reference the payment file carries for this invoice, and the
// invoice's history in payment files. Editable in draft/approved unless a live
// batch row reserves the invoice (the server enforces the same).
export function PaymentReferenceSection({ invoice }: { invoice: SupplierInvoiceDetail }) {
  const router = useRouter();
  const can = useCan();
  const reservedIn = invoice.paymentBatches.find((b) => b.itemStatus === "pending" || b.itemStatus === "exported") ?? null;
  const editable = can(["inkop"]) && (invoice.status === "draft" || invoice.status === "approved") && reservedIn === null;
  const [kind, setKind] = useState<"ocr" | "message">(invoice.paymentReferenceKind ?? "ocr");
  const [value, setValue] = useState(invoice.paymentReference ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/supplier-invoices/${invoice.id}/payment-reference`, {
        method: "PATCH",
        body: JSON.stringify({ paymentReference: value.trim() ? { kind, value: value.trim() } : null }),
      });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Betalningsreferensen kunde inte sparas."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={520} style={{ marginBottom: 20 }}>
      <Form onSubmit={save}>
        <FormStack>
          <Field label="Betalningsreferens" htmlFor="paymentReference">
            <SegmentedToggle
              value={kind}
              options={[
                { value: "ocr", label: "OCR" },
                { value: "message", label: "Meddelande" },
              ]}
              onChange={setKind}
              disabled={!editable}
              ariaLabel="Typ av betalningsreferens"
            />
            <Input id="paymentReference" value={value} onChange={(e) => setValue(e.target.value)} disabled={!editable} />
          </Field>
          {reservedIn && <FormHint>Ingår i betalfil {reservedIn.batchNumber}</FormHint>}
          {!reservedIn && <FormHint>Utan referens skickas &quot;Faktura {invoice.invoiceNumber}&quot; (bankkonto: bara fakturanumret).</FormHint>}
          {error && <FormError>{error}</FormError>}
          {editable && (
            <FormActions>
              <Button type="submit" size="small" disabled={pending}>
                Spara referens
              </Button>
            </FormActions>
          )}
          {invoice.paymentBatches.length > 0 && (
            <div>
              {invoice.paymentBatches.map((b) => (
                <div key={b.endToEndId}>
                  <GatedLink href={`/inkop/betalfiler/${b.batchId}`}>Betalfil {b.batchNumber}</GatedLink> · {b.endToEndId} ·{" "}
                  {PAYMENT_ITEM_STATUS[b.itemStatus]?.label ?? b.itemStatus}
                </div>
              ))}
            </div>
          )}
        </FormStack>
      </Form>
    </Card>
  );
}
