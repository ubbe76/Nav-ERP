"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type {
  ConfiguratorBomLineDetail,
  ConfiguratorGroupDetail,
  ConfiguratorLineSource,
  ConfiguratorOperationDetail,
} from "../../lib/configurator";
import type { RoutingOperation } from "../../lib/types";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { Field, Input, Select } from "../ui/Field";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";
import { ConditionEditor, fromCondition, toCondition, type ConditionDraft } from "./ConditionEditor";
import { FormulaField } from "./FormulaField";

interface BomLineModalProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  operations: ConfiguratorOperationDetail[];
  /** The template's own routing, for the operation link. */
  routing: RoutingOperation[];
  /** null = a new line. */
  line: ConfiguratorBomLineDetail | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

export function BomLineModal({ open, onClose, line, ...rest }: BomLineModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={line ? "Ändra strukturrad" : "Lägg till strukturrad"} wide>
      <BomLineForm key={line?.id ?? "new"} line={line} onClose={onClose} {...rest} />
    </Modal>
  );
}

const SOURCE_OPTIONS: { value: ConfiguratorLineSource; label: string }[] = [
  { value: "article", label: "Artikel" },
  { value: "group", label: "Från val" },
];

// "r:<id>" = routing operation, "c:<id>" = conditional operation, "" = none.
function linkOf(line: ConfiguratorBomLineDetail | null): string {
  if (line?.routingOperationId) return `r:${line.routingOperationId}`;
  if (line?.configuratorOperationId) return `c:${line.configuratorOperationId}`;
  return "";
}

function BomLineForm({
  articleId,
  groups,
  operations,
  routing,
  line,
  onClose,
  onChanged,
}: Omit<BomLineModalProps, "open">) {
  const [conditions, setConditions] = useState<ConditionDraft[]>(
    line ? line.conditions.map((c, i) => fromCondition(i, c)) : [],
  );
  const [source, setSource] = useState<ConfiguratorLineSource>(line?.source ?? "article");
  const [component, setComponent] = useState<ArticlePickerValue | null>(
    line?.componentArticleId
      ? { id: line.componentArticleId, articleNumber: line.componentArticleNumber ?? "", name: line.componentArticleName ?? "" }
      : null,
  );
  const [groupId, setGroupId] = useState(line?.componentGroupId ?? "");
  const [qtyMode, setQtyMode] = useState<"fixed" | "formula">(line?.quantityFormula != null ? "formula" : "fixed");
  const [quantity, setQuantity] = useState(line?.quantity != null ? String(Number(line.quantity)) : "");
  const [formula, setFormula] = useState(line?.quantityFormula ?? "");
  const [link, setLink] = useState(linkOf(line));
  const [note, setNote] = useState(line?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [formulaError, setFormulaError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const choiceGroups = groups.filter((g) => g.kind === "choice");
  const codes = groups.map((g) => g.code);

  function buildBody(): Record<string, unknown> {
    const built = conditions.map((c) => toCondition(c, groups));
    if (source === "article" && !component) throw new Error("Välj komponentartikel");
    if (source === "group" && !groupId) throw new Error("Välj valgrupp");
    if (qtyMode === "fixed") {
      if (!(Number(quantity) > 0)) throw new Error("Ange ett antal större än 0");
    } else if (formula.trim() === "") {
      throw new Error("Ange en formel");
    }
    const q =
      qtyMode === "fixed"
        ? { quantity: Number(quantity), quantityFormula: null }
        : { quantity: null, quantityFormula: formula.trim() };
    const ops = {
      routingOperationId: link.startsWith("r:") ? link.slice(2) : null,
      configuratorOperationId: link.startsWith("c:") ? link.slice(2) : null,
    };
    const comp = {
      source,
      componentArticleId: source === "article" ? component!.id : null,
      componentGroupId: source === "group" ? groupId : null,
    };
    const noteValue = note.trim() === "" ? null : note.trim();
    if (!line) {
      return { conditions: built, ...comp, ...q, ...ops, note: noteValue };
    }
    // Update: only what changed. The server validates the merged row, so a
    // switch Fast↔Formel (or Artikel↔Från val) sends both sides of the pair.
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(built) !== JSON.stringify(line.conditions)) patch.conditions = built;
    if (
      source !== line.source ||
      comp.componentArticleId !== line.componentArticleId ||
      comp.componentGroupId !== line.componentGroupId
    )
      Object.assign(patch, comp);
    const wasFormula = line.quantityFormula != null;
    if (
      qtyMode === "formula" !== wasFormula ||
      (qtyMode === "fixed" && Number(quantity) !== Number(line.quantity)) ||
      (qtyMode === "formula" && formula.trim() !== line.quantityFormula)
    )
      Object.assign(patch, q);
    if (link !== linkOf(line)) Object.assign(patch, ops);
    if (noteValue !== line.note) patch.note = noteValue;
    return patch;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFormulaError(null);
    let body: Record<string, unknown>;
    try {
      body = buildBody();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (line && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setPending(true);
    try {
      const base = `/api/v1/articles/${articleId}/configurator/bom-lines`;
      await apiFetch(line ? `${base}/${line.id}` : base, {
        method: line ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      await onChanged();
      onClose();
    } catch (err) {
      const message = apiErrorMessage(err, "Kunde inte spara strukturraden");
      if ((err as { code?: string }).code === "invalid-configurator-formula" && message.startsWith("Antal:"))
        setFormulaError(message);
      else setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <ConditionEditor
        conditions={conditions}
        groups={groups}
        onChange={setConditions}
        emptyHint="Utan villkor gäller raden alltid."
      />

      <Field label="Komponent">
        <SegmentedToggle<ConfiguratorLineSource>
          value={source}
          options={SOURCE_OPTIONS}
          ariaLabel="Komponent"
          onChange={setSource}
        />
      </Field>
      {source === "article" ? (
        <Field label="Artikel" htmlFor="cfg-line-article">
          <ArticlePicker id="cfg-line-article" value={component} excludeId={articleId} onChange={setComponent} />
        </Field>
      ) : (
        <Field label="Valgrupp" htmlFor="cfg-line-group">
          <Select id="cfg-line-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">— Välj —</option>
            {choiceGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.code})
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Antal">
        <SegmentedToggle<"fixed" | "formula">
          value={qtyMode}
          options={[
            { value: "fixed", label: "Fast" },
            { value: "formula", label: "Formel" },
          ]}
          ariaLabel="Antal"
          onChange={setQtyMode}
        />
      </Field>
      {qtyMode === "fixed" ? (
        <Field label="Fast antal" htmlFor="cfg-line-qty">
          <Input
            id="cfg-line-qty"
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
      ) : (
        <Field label="Formel" htmlFor="cfg-line-formula">
          <FormulaField id="cfg-line-formula" value={formula} onChange={setFormula} codes={codes} error={formulaError} />
        </Field>
      )}

      <FormRow>
        <Field label="Operation" htmlFor="cfg-line-op">
          <Select id="cfg-line-op" value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">— Ingen —</option>
            {routing.map((op) => (
              <option key={op.id} value={`r:${op.id}`}>
                {op.sequenceNo} {op.description ?? op.workCenterName}
              </option>
            ))}
            {operations.map((op) => (
              <option key={op.id} value={`c:${op.id}`}>
                {op.sequenceNo} {op.description ?? op.workCenterName} (villkorad)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Anteckning" htmlFor="cfg-line-note">
          <Input id="cfg-line-note" value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </FormRow>

      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
