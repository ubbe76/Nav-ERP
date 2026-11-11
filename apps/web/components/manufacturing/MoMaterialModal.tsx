"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertQuantityInput, useUnitOptions } from "../ui/UnitSelect";
import { toUnitQuantity } from "../../lib/units";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Article, MOMaterialConsumption, MOMaterialSaveResult, MOOperation } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

interface MoMaterialModalProps {
  open: boolean;
  onClose: () => void;
  orderId: string;
  // The order's own article — it cannot be material on its own order.
  orderArticleId: string;
  operations: MOOperation[];
  // null = add a row; a row = edit it.
  editing: MOMaterialConsumption | null;
  // A report line points at the row (also an undone one): the server keeps
  // the component and refuses Ta bort, as it does for drawn material.
  editingHasReports?: boolean;
  onSaved: (warnings: string[]) => void;
}

export function MoMaterialModal({ open, onClose, ...rest }: MoMaterialModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rest.editing ? `Ändra material ${rest.editing.componentArticleNumber}` : "Lägg till material"}
    >
      {/* The Modal unmounts its children while closed, so the form state
          re-initialises from `editing` on every open. */}
      <MaterialForm {...rest} />
    </Modal>
  );
}

function MaterialForm({
  orderId,
  orderArticleId,
  operations,
  editing,
  editingHasReports = false,
  onSaved,
}: Omit<MoMaterialModalProps, "open" | "onClose">) {
  const [component, setComponent] = useState<Article | null>(null);
  // Ändra starts from the row as saved: its quantity in its own unit, read
  // with the factor the row was saved with (the article's factor may have
  // changed since).
  const initialQuantity = editing ? String(toUnitQuantity(Number(editing.quantityPlanned), editing.unitFactor)) : "1";
  const initialUnitId = editing?.unitId ?? ""; // "" = the component's base unit
  const initialOperationId = editing?.moOperationId ?? "";
  const [quantity, setQuantity] = useState(initialQuantity);
  const [unitId, setUnitId] = useState(initialUnitId);
  const [operationId, setOperationId] = useState(initialOperationId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The article can only be swapped while nothing has been drawn or reported
  // from the row (materialHasConsumption on the server).
  const articleLocked = editing !== null && (Number(editing.quantityConsumed) > 0 || editingHasReports);
  const changedArticle = editing !== null && component !== null && component.id !== editing.componentArticleId;

  // Edit mode fetches the current component so the unit select knows its units.
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    apiFetch<Article>(`/api/v1/articles/${editing.componentArticleId}`)
      .then((article) => {
        if (!cancelled) setComponent((current) => current ?? article);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editing]);

  const unitOptions = useUnitOptions(component);
  // The row's own unit converts with the row's saved factor, any other unit
  // with the article's current one.
  const factorOf = (id: string) =>
    editing && !changedArticle && id === initialUnitId
      ? editing.unitFactor == null
        ? 1
        : Number(editing.unitFactor)
      : (unitOptions.find((o) => o.value === id)?.factor ?? 1);
  const currentFactor = factorOf(unitId);

  // Only pending operations can still draw material; a done operation is offered
  // only when the row already points at it.
  const selectableOperations = operations.filter((op) => op.status === "pending" || op.id === operationId);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing && !component) {
      setError("Välj ett material");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const common = {
        quantity: Number(quantity),
        unitId: unitId === "" ? null : unitId,
        moOperationId: operationId || null,
      };
      let result: MOMaterialSaveResult;
      if (editing) {
        // Only what changed. The server reads a quantity without unitId in
        // the row's own saved factor; sending the unit as well re-resolved it
        // with the article's CURRENT factor (1 st = 5 kg saved, 4 kg now:
        // 50 kg became 40 kg on a change of Operation only), and a factor
        // under 1 drifted on every save (2 st → 0,6667 förp → 2,0001 st).
        const patch: Record<string, unknown> = {};
        if (quantity !== initialQuantity) patch.quantity = Number(quantity);
        if (unitId !== initialUnitId) patch.unitId = unitId === "" ? null : unitId;
        if (operationId !== initialOperationId) patch.moOperationId = operationId || null;
        if (changedArticle) patch.componentArticleId = component!.id;
        if (Object.keys(patch).length === 0) {
          onSaved([]);
          return;
        }
        result = await apiFetch<MOMaterialSaveResult>(
          `/api/v1/manufacturing-orders/${orderId}/materials/${editing.id}`,
          { method: "PATCH", body: JSON.stringify(patch) }
        );
      } else {
        result = await apiFetch<MOMaterialSaveResult>(`/api/v1/manufacturing-orders/${orderId}/materials`, {
          method: "POST",
          body: JSON.stringify({ ...common, componentArticleId: component!.id }),
        });
      }
      onSaved(result.warnings ?? []);
    } catch (err) {
      setError(apiErrorMessage(err, editing ? "Kunde inte spara materialet" : "Kunde inte lägga till materialet"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Material" htmlFor="moMaterialArticle">
        {articleLocked && editing ? (
          <Input
            id="moMaterialArticle"
            value={`${editing.componentArticleNumber} — ${editing.componentName}`}
            disabled
            readOnly
          />
        ) : (
          <ArticlePicker
            id="moMaterialArticle"
            value={
              component ??
              (editing
                ? {
                    id: editing.componentArticleId,
                    articleNumber: editing.componentArticleNumber,
                    name: editing.componentName,
                  }
                : null)
            }
            onChange={(article) => {
              setComponent(article);
              setUnitId("");
            }}
            excludeId={orderArticleId}
          />
        )}
      </Field>
      {articleLocked && (
        <FormHint attached>Material har redan förbrukats eller rapporterats från raden — artikeln kan inte bytas.</FormHint>
      )}

      <FormRow>
        <Field label="Antal" htmlFor="moMaterialQuantity">
          <Input
            id="moMaterialQuantity"
            type="number"
            size="sm"
            min="0"
            step="any"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        {/* Quantity in one of the COMPONENT's units; switching converts. */}
        <Field label="Enhet" htmlFor="moMaterialUnit">
          <UnitSelect
            id="moMaterialUnit"
            options={unitOptions}
            value={unitId}
            onChange={(option) => {
              setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
              setUnitId(option.value);
            }}
          />
        </Field>
      </FormRow>
      <FormHint attached>Antalet är radens totala behov för hela ordern.</FormHint>

      <Field label="Operation" htmlFor="moMaterialOperation">
        <Select id="moMaterialOperation" value={operationId} onChange={(e) => setOperationId(e.target.value)}>
          <option value="">Ingen — dras vid inleverans</option>
          {selectableOperations.map((op) => (
            <option key={op.id} value={op.id}>
              {op.sequenceNo} — {op.description ?? op.workCenterName}
            </option>
          ))}
        </Select>
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : editing ? "Spara ändringar" : "Lägg till material"}
        </Button>
      </FormActions>
    </Form>
  );
}
