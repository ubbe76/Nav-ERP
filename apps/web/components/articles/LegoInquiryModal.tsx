"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { createLegoInquiries, type LegoInquiryResult } from "../../lib/legoInquiries";
import { SupplierCheckboxList } from "../purchase/SupplierCheckboxList";
import { CreatedInquiriesPanel } from "../purchase/CreatedInquiriesPanel";
import type { CreatedInquiry, MOOperation, Paged, RoutingOperation, Supplier } from "../../lib/types";
import { apiErrorMessage } from "../../lib/errorMessages";

// What the förfrågan asks a price for: the beredning's routing operation (a
// TO-less price inquiry) or one TO's lego operation — the row is then linked
// to it (moOperationId), so Gör till inköpsorder keeps the operation and the
// inleverans reports it, exactly like the behovsberäkning's Skapa förfrågan.
export type LegoInquiryTarget =
  | { kind: "routing"; operation: RoutingOperation }
  | { kind: "mo"; operation: MOOperation; orderNumber: string; defaultQuantity: number | null };

interface LegoInquiryModalProps {
  open: boolean;
  onClose: () => void;
  articleId: string;
  articleNumber: string;
  target: LegoInquiryTarget;
  // After the förfrågningar are created (the TO card refreshes its links).
  onCreated?: () => void;
}

// "Skicka förfrågan" for a single lego (subcontract) operation — from its row
// in BeredningView (TO-less, routingOperationId) or on the TO card (linked,
// moOperationId). Same createLegoInquiries as the behovsberäkning page's
// lego flow, with exactly one row at the entered Antal.
export function LegoInquiryModal({ open, onClose, articleId, articleNumber, target, onCreated }: LegoInquiryModalProps) {
  const op = target.operation;
  const label = `Op ${op.sequenceNo} · ${op.description ?? op.workCenterName}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={target.kind === "mo" ? `Skapa förfrågan – ${target.orderNumber} · ${label}` : `Skicka förfrågan – ${label}`}
    >
      <LegoInquiryForm articleId={articleId} articleNumber={articleNumber} target={target} onClose={onClose} onCreated={onCreated} />
    </Modal>
  );
}

function LegoInquiryForm({ articleId, articleNumber, target, onClose, onCreated }: Omit<LegoInquiryModalProps, "open">) {
  const operation = target.operation;
  const [quantity, setQuantity] = useState(
    target.kind === "mo" ? (target.defaultQuantity !== null && target.defaultQuantity > 0 ? String(target.defaultQuantity) : "") : "1"
  );
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
        rows: [
          {
            articleId,
            articleNumber,
            quantity: qty,
            ...(target.kind === "mo" ? { moOperationId: operation.id } : { routingOperationId: operation.id }),
          },
        ],
        note: note.trim() || undefined,
      });
      setResult(res);
      if (res.created.length > 0) onCreated?.();
    } catch (err) {
      setError(apiErrorMessage(err, "Förfrågan kunde inte skapas"));
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

      <FormHint>
        En förfrågan per leverantör. Ställpriset förifylls från operationen; priset frågas.
        {target.kind === "mo" &&
          ` Raden kopplas till ${target.orderNumber} · Op ${operation.sequenceNo}, så Gör till inköpsorder tar med kopplingen.`}
      </FormHint>

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
