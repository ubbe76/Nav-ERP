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
import { operationLabel } from "./operation-label";
import type { Article, BomComponent, RoutingOperation } from "../../lib/types";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";

interface BomComponentModalProps {
  open: boolean;
  onClose: () => void;
  articleId: string;
  // The article's own routing — a component may be tied to one of these, and
  // is then drawn from stock when that operation is reported complete.
  routing: RoutingOperation[];
  // null = the modal adds a new component; a row = it edits that row
  // (quantity/unit/operation — the component article itself is fixed).
  editing: BomComponent | null;
  // Pre-selected operation when opened from an operation's "+ Komponent".
  presetOperationId: string;
  onSaved: () => void;
  // Add mode only: switch over to the "Ny artikel i strukturen" modal.
  onNewArticle: () => void;
}

export function BomComponentModal({
  open,
  onClose,
  articleId,
  routing,
  editing,
  presetOperationId,
  onSaved,
  onNewArticle,
}: BomComponentModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Ändra komponent ${editing.componentArticleNumber}` : "Lägg till komponent"}
    >
      {/* The Modal unmounts its children while closed, so the form state
          re-initialises from `editing`/`presetOperationId` on every open. */}
      <ComponentForm
        articleId={articleId}
        routing={routing}
        editing={editing}
        presetOperationId={presetOperationId}
        onSaved={onSaved}
        onNewArticle={onNewArticle}
      />
    </Modal>
  );
}

function ComponentForm({
  articleId,
  routing,
  editing,
  presetOperationId,
  onSaved,
  onNewArticle,
}: Omit<BomComponentModalProps, "open" | "onClose">) {
  const [component, setComponent] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState(
    editing ? String(toUnitQuantity(Number(editing.quantity), editing.unitFactor)) : "1"
  );
  const [unitId, setUnitId] = useState(editing?.unitId ?? ""); // "" = the component's base unit
  const [operationId, setOperationId] = useState(editing ? (editing.routingOperationId ?? "") : presetOperationId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A Kalkyl operation is never released onto an MO, so material tied to it
  // would never be drawn — the API refuses the link (409) and the select
  // simply doesn't offer it.
  const linkableRouting = routing.filter((op) => !op.costingOnly);

  // In edit mode the component article is fetched so the unit dropdown knows
  // its base + alternative units.
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    apiFetch<Article>(`/api/v1/articles/${editing.componentArticleId}`)
      .then((article) => {
        if (!cancelled) setComponent(article);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editing]);

  const unitOptions = useUnitOptions(component);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing && !component) {
      setError("Välj en komponent");
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (editing) {
        await apiFetch(`/api/v1/articles/${articleId}/bom/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            quantity: Number(quantity),
            unitId: unitId === "" ? null : unitId,
            routingOperationId: operationId || null,
          }),
        });
      } else {
        await apiFetch(`/api/v1/articles/${articleId}/bom`, {
          method: "POST",
          body: JSON.stringify({
            componentArticleId: component!.id,
            quantity: Number(quantity),
            unitId: unitId === "" ? null : unitId,
            routingOperationId: operationId || null,
          }),
        });
      }
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, editing ? "Kunde inte spara komponenten" : "Kunde inte lägga till komponenten"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {editing ? (
        <Field label="Komponent" htmlFor="componentArticleId">
          <Input
            id="componentArticleId"
            value={`${editing.componentArticleNumber} — ${editing.componentName}`}
            disabled
            readOnly
          />
        </Field>
      ) : (
        <Field label="Komponent" htmlFor="componentArticleId">
          <ArticlePicker
            id="componentArticleId"
            value={component}
            onChange={(article) => {
              setComponent(article);
              setUnitId("");
            }}
            excludeId={articleId}
          />
        </Field>
      )}

      <FormRow>
        <Field label="Antal" htmlFor="quantity">
          <Input id="quantity" type="number" size="sm" min="0" step="any" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        {/* Quantity in one of the COMPONENT's units; switching converts. */}
        <Field label="Enhet" htmlFor="bomUnit">
          <UnitSelect
            id="bomUnit"
            options={unitOptions}
            value={unitId}
            onChange={(option) => {
              setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
              setUnitId(option.value);
            }}
          />
        </Field>
      </FormRow>

      {/* Linking to an operation makes the component draw automatically
          when that operation is reported complete. */}
      {linkableRouting.length > 0 && (
        <Field label="Operation (valfritt)" htmlFor="bomOperation">
          <Select id="bomOperation" value={operationId} onChange={(e) => setOperationId(e.target.value)}>
            <option value="">— ingen —</option>
            {linkableRouting.map((op) => (
              <option key={op.id} value={op.id}>
                {operationLabel(op)}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : editing ? "Spara ändringar" : "Lägg till komponent"}
        </Button>
        {!editing && (
          <Button type="button" variant="ghost" onClick={onNewArticle}>
            + Ny artikel
          </Button>
        )}
      </FormActions>
    </Form>
  );
}
