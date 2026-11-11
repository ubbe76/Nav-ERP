"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertQuantityInput, useUnitOptions } from "../ui/UnitSelect";
import { toUnitQuantity } from "../../lib/units";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { operationLabel } from "./operation-label";
import type { Article, BomComponent, RoutingOperation } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { alreadyInStructureText } from "../../lib/bomDuplicates";

interface BomComponentModalProps {
  open: boolean;
  onClose: () => void;
  articleId: string;
  // The article's own routing — a component may be tied to one of these, and
  // is then drawn from stock when that operation is reported complete.
  routing: RoutingOperation[];
  // The structure's current rows — picking a component that is already on
  // one shows a warning (allowed since 0176, never refused).
  bom: BomComponent[];
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
  bom,
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
        bom={bom}
        editing={editing}
        presetOperationId={presetOperationId}
        onSaved={onSaved}
        onNewArticle={onNewArticle}
      />
    </Modal>
  );
}

const checkboxRowStyle = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  fontFamily: "var(--font-body)",
  fontSize: 13,
} as const;

function ComponentForm({
  articleId,
  routing,
  bom,
  editing,
  presetOperationId,
  onSaved,
  onNewArticle,
}: Omit<BomComponentModalProps, "open" | "onClose">) {
  const [component, setComponent] = useState<Article | null>(null);
  // What Ändra opened with: the row's quantity shown with the factor SAVED on
  // the row (its snapshot), and the row's unit. An untouched quantity and unit
  // are never sent back (webbgranskningen 2026-11-11) — the server re-reads
  // the unit's CURRENT factor for a sent unit, so a factor changed since
  // (5 → 6) turned 50 kg = 10 st into 8,3333 st when only Pos. was edited,
  // and a factor under 1 drifted on every save (0,3333 kg → 0,0133 rulle →
  // 0,3325 kg).
  const startQuantity = editing ? String(toUnitQuantity(Number(editing.quantity), editing.unitFactor)) : "1";
  const startUnitId = editing?.unitId ?? "";
  const [quantity, setQuantity] = useState(startQuantity);
  const [unitId, setUnitId] = useState(startUnitId); // "" = the component's base unit
  const [operationId, setOperationId] = useState(editing ? (editing.routingOperationId ?? "") : presetOperationId);
  const [position, setPosition] = useState(editing?.position ?? "");
  const [costingOnly, setCostingOnly] = useState(editing?.costingOnly ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A Kalkyl operation is never released onto an MO, so an ordinary row tied
  // to it would never be drawn — the API refuses that link; only a Kalkyl row
  // may link to a Kalkyl operation.
  const linkableRouting = routing.filter((op) => costingOnly || !op.costingOnly);

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
  const alreadyInStructure = !editing && component ? alreadyInStructureText(bom, component.id) : null;
  // The factor the shown quantity is expressed in: the row's own snapshot
  // until the unit is switched (the unit's current factor may differ).
  const currentFactor =
    editing && unitId === startUnitId
      ? (editing.unitFactor !== null && editing.unitFactor !== undefined ? Number(editing.unitFactor) : 1)
      : (unitOptions.find((o) => o.value === unitId)?.factor ?? 1);

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
        const unitChanged = unitId !== startUnitId;
        await apiFetch(`/api/v1/articles/${articleId}/bom/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            // The quantity is in the shown unit; with a changed unit the
            // server converts with that unit's current factor, as intended.
            ...(unitChanged || quantity !== startQuantity ? { quantity: Number(quantity) } : {}),
            ...(unitChanged ? { unitId: unitId === "" ? null : unitId } : {}),
            routingOperationId: operationId || null,
            position: position.trim(),
            costingOnly,
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
            position: position.trim(),
            costingOnly,
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
      {alreadyInStructure && <FormNotice>{alreadyInStructure}</FormNotice>}

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

      <Field label="Pos. (valfritt)" htmlFor="bomPosition">
        <Input
          id="bomPosition"
          size="sm"
          maxLength={20}
          placeholder="Ritningsposition"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
        />
      </Field>

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

      <label style={checkboxRowStyle}>
        <Checkbox
          id="bomCostingOnly"
          checked={costingOnly}
          onChange={(e) => {
            setCostingOnly(e.target.checked);
            // An ordinary row cannot keep a link to a Kalkyl operation.
            if (!e.target.checked && routing.find((op) => op.id === operationId)?.costingOnly) setOperationId("");
          }}
        />
        Kalkyl
      </label>
      <FormHint attached>
        Raden räknas i kalkylen men dras inte vid tillverkning och ger inget behov i behovsberäkningen.
      </FormHint>

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
