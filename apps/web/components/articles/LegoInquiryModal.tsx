"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { createLegoInquiries } from "../../lib/legoInquiries";
import { SupplierCheckboxList } from "../purchase/SupplierCheckboxList";
import { CreatedInquiriesPanel } from "../purchase/CreatedInquiriesPanel";
import type { CreatedInquiry, Paged, RoutingOperation, Supplier } from "../../lib/types";

interface LegoInquiryModalProps {
  open: boolean;
  onClose: () => void;
  articleId: string;
  articleNumber: string;
  operation: RoutingOperation;
}

type LegoInquiryResult = {
  created: CreatedInquiry[];
  errors: { supplierName: string; articleNumbers: string[]; message: string }[];
};

// "Skicka förfrågan" for a single lego (subcontract) operation, opened from
// its row in BeredningView. Same createLegoInquiries used by the
// behovsberäkning page's lego flow, but with exactly one proposal row — this
// operation, at the entered Antal — sent as a TO-less price inquiry
// (routingOperationId, no moOperationId).
export function LegoInquiryModal({ open, onClose, articleId, articleNumber, operation }: LegoInquiryModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Skicka förfrågan – Op ${operation.sequenceNo} · ${operation.description ?? operation.workCenterName}`}
    >
      <LegoInquiryForm articleId={articleId} articleNumber={articleNumber} operation={operation} onClose={onClose} />
    </Modal>
  );
}

function LegoInquiryForm({ articleId, articleNumber, operation, onClose }: Omit<LegoInquiryModalProps, "open">) {
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<LegoInquiryResult | null>(null);

  // The Modal unmounts this component while closed, so this fetch and all
  // the state above re-initialise fresh on every open.
  useEffect(() => {
    apiFetch<Paged<Supplier>>("/api/v1/suppliers?limit=1000")
      .then((res) => setSuppliers(res.rows))
      .catch(() => setSuppliers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per open
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (supplierIds.length === 0) {
      setError("Välj minst en leverantör");
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Ange ett antal");
      return;
    }

    setPending(true);
    try {
      const selectedSuppliers = suppliers
        .filter((s) => supplierIds.includes(s.id))
        .map((s) => ({ id: s.id, name: s.name }));
      const res = await createLegoInquiries({
        suppliers: selectedSuppliers,
        rows: [{ articleId, articleNumber, quantity: qty, routingOperationId: operation.id }],
        note: note.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Förfrågan kunde inte skapas");
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <>
        <CreatedInquiriesPanel result={result} />
        <FormActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Stäng
          </Button>
        </FormActions>
      </>
    );
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Antal" htmlFor="quantity">
        <Input
          id="quantity"
          type="number"
          min="0"
          step="any"
          required
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </Field>

      <Field label="Anteckning (valfritt)" htmlFor="note">
        <Textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <SupplierCheckboxList
        value={supplierIds}
        onChange={setSupplierIds}
        preselect={operation.subcontractSupplierId ? [operation.subcontractSupplierId] : []}
        suppliers={suppliers.length > 0 ? suppliers : undefined}
      />

      <FormHint>En förfrågan per leverantör. Ställpriset förifylls från operationen; priset frågas.</FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa förfrågan"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
