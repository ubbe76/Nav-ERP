"use client";

import { useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, formatQuantity } from "../../lib/format";
import type { MOOperation, PlanningOrdersResult } from "../../lib/types";

interface LegoPurchaseOrderModalProps {
  open: boolean;
  onClose: () => void;
  orderNumber: string;
  articleId: string;
  unitCode: string | null;
  operation: MOOperation;
  orderQuantity: number;
  // Already bought of the operation (GET …/lego-purchases — the same figure
  // the behovsberäkning deducts).
  orderedQuantity: number;
  onCreated: () => void;
}

// Skapa inköpsorder on a TO's lego operation: the behovsberäkning's Skapa
// ordrar for exactly this one operation (POST /planning/orders with a
// subcontract proposal), so the rules are the same — a draft IO at the
// operation's supplier, its styckpris as à-pris, ställpris + transportkostnad
// on the row, the Önskat leveransdatum backward from the TO's färdigdatum,
// supplier and prices reloaded server-side.
export function LegoPurchaseOrderModal(props: LegoPurchaseOrderModalProps) {
  const op = props.operation;
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={`Skapa inköpsorder – ${props.orderNumber} · Op ${op.sequenceNo} · ${op.description ?? op.workCenterName}`}
    >
      <LegoPurchaseOrderForm {...props} />
    </Modal>
  );
}

function LegoPurchaseOrderForm({
  onClose,
  articleId,
  unitCode,
  operation,
  orderQuantity,
  orderedQuantity,
  onCreated,
}: LegoPurchaseOrderModalProps) {
  const remaining = Math.max(orderQuantity - orderedQuantity, 0);
  const [quantity, setQuantity] = useState(remaining > 0 ? String(remaining) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PlanningOrdersResult | null>(null);
  const unit = unitCode ?? "st";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Ange ett antal större än 0");
      return;
    }
    setPending(true);
    try {
      const res = await apiFetch<PlanningOrdersResult>("/api/v1/planning/orders", {
        method: "POST",
        body: JSON.stringify({
          proposals: [{ articleId, quantity: qty, kind: "subcontract", moOperationId: operation.id }],
        }),
      });
      setResult(res);
      if (res.purchaseOrders.length > 0) onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa inköpsordern"));
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <>
        {result.purchaseOrders.map((po) => (
          <FormNotice key={po.id} role="status">
            Inköpsordern{" "}
            <GatedLink href={`/inkop/ordrar/${po.id}`}>
              <strong>{po.orderNumber}</strong>
            </GatedLink>{" "}
            är skapad som utkast hos {po.supplierName}. Skicka den från inköpsorderkortet.
          </FormNotice>
        ))}
        {result.warnings.map((w, i) => (
          <FormNotice key={`w${i}`} style={{ marginTop: 8 }}>
            {w.orderNumber}: {w.message}
          </FormNotice>
        ))}
        {result.errors.map((err, i) => (
          <FormError key={`e${i}`}>{err.message}</FormError>
        ))}
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
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", margin: 0 }}>
        <dt>Leverantör</dt>
        <dd style={{ margin: 0 }}>{operation.subcontractSupplierName ?? "–"}</dd>
        {operation.unitPrice != null && (
          <>
            <dt>Styckpris</dt>
            <dd style={{ margin: 0 }}>{formatMoney(Number(operation.unitPrice))} kr/{unit}</dd>
          </>
        )}
        {(operation.setupPrice != null || operation.transportPrice != null) && (
          <>
            <dt>Ställpris</dt>
            <dd style={{ margin: 0 }}>
              {formatMoney(Number(operation.setupPrice ?? 0) + Number(operation.transportPrice ?? 0))} kr
              {operation.transportPrice != null && " (inkl. transportkostnad)"}
            </dd>
          </>
        )}
        <dt>Redan beställt</dt>
        <dd style={{ margin: 0 }}>
          {formatQuantity(orderedQuantity)} av {formatQuantity(orderQuantity)} {unit}
        </dd>
      </dl>
      {remaining === 0 && (
        <FormNotice>Hela orderantalet är redan beställt. Ange ett antal om operationen ska köpas en gång till.</FormNotice>
      )}
      <Field label={`Antal (${unit})`} htmlFor="legoPoQuantity">
        <Input
          id="legoPoQuantity"
          type="number"
          min="0"
          step="any"
          required
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </Field>
      <FormHint>
        Inköpsordern skapas som utkast hos operationens leverantör, med samma regler som Skapa ordrar i
        behovsberäkningen: styckpriset som à-pris, ställpriset på raden och önskat leveransdatum när operationen
        måste vara tillbaka för att tillverkningsordern ska bli klar till färdigdatumet.
      </FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa inköpsorder"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
