"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ConfiguratorGroupDetail, ConfiguratorOperationDetail } from "../../lib/configurator";
import type { WorkCenter } from "../../lib/types";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { ConditionEditor, fromCondition, toCondition, type ConditionDraft } from "./ConditionEditor";
import { FormulaField } from "./FormulaField";

interface OperationModalProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  /** null = a new operation. */
  operation: ConfiguratorOperationDetail | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

export function OperationModal({ open, onClose, operation, ...rest }: OperationModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={operation ? "Ändra operation" : "Lägg till operation"} wide>
      <OperationForm key={operation?.id ?? "new"} operation={operation} onClose={onClose} {...rest} />
    </Modal>
  );
}

type Mode = "fixed" | "formula";
const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "fixed", label: "Fast" },
  { value: "formula", label: "Formel" },
];

const trim = (v: string | null | undefined) => (v == null ? "" : String(Number(v)));

function OperationForm({ articleId, groups, operation, onClose, onChanged }: Omit<OperationModalProps, "open">) {
  const [conditions, setConditions] = useState<ConditionDraft[]>(
    operation ? operation.conditions.map((c, i) => fromCondition(i, c)) : [],
  );
  const [sequenceNo, setSequenceNo] = useState(operation ? String(operation.sequenceNo) : "");
  const [workCenterId, setWorkCenterId] = useState(operation?.workCenterId ?? "");
  const [description, setDescription] = useState(operation?.description ?? "");
  const [setupMode, setSetupMode] = useState<Mode>(operation?.setupFormula != null ? "formula" : "fixed");
  const [setupTime, setSetupTime] = useState(operation?.setupTime != null ? trim(operation.setupTime) : "0");
  const [setupFormula, setSetupFormula] = useState(operation?.setupFormula ?? "");
  const [runMode, setRunMode] = useState<Mode>(operation?.runFormula != null ? "formula" : "fixed");
  const [runTime, setRunTime] = useState(operation?.runTimePerUnit != null ? trim(operation.runTimePerUnit) : "0");
  const [runFormula, setRunFormula] = useState(operation?.runFormula ?? "");
  const [setupPrice, setSetupPrice] = useState(trim(operation?.setupPrice));
  const [unitPrice, setUnitPrice] = useState(trim(operation?.unitPrice));
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [setupFormulaError, setSetupFormulaError] = useState<string | null>(null);
  const [runFormulaError, setRunFormulaError] = useState<string | null>(null);
  const [centersLoaded, setCenters] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<WorkCenter[]>("/api/v1/work-centers")
      .then((rows) => {
        if (!cancelled) {
          setWorkCenters(rows);
          setCenters(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Kunde inte hämta resurser"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = workCenters.find((w) => w.id === workCenterId);
  const isLego = selected?.type === "subcontract";
  const wasLego = operation ? operation.setupPrice != null || operation.unitPrice != null : false;
  const codes = groups.map((g) => g.code);

  function buildBody(): Record<string, unknown> {
    const built = conditions.map((c) => toCondition(c, groups));
    const seq = Number(sequenceNo);
    if (!Number.isInteger(seq) || seq < 1) throw new Error("Ange ett operationsnummer");
    if (!workCenterId) throw new Error("Välj resurs");
    if (setupMode === "fixed" ? setupTime.trim() === "" : setupFormula.trim() === "")
      throw new Error("Ange ställtid eller formel");
    if (runMode === "fixed" ? runTime.trim() === "" : runFormula.trim() === "")
      throw new Error("Ange stycktid eller formel");
    const setup =
      setupMode === "fixed"
        ? { setupTime: Number(setupTime), setupFormula: null }
        : { setupTime: null, setupFormula: setupFormula.trim() };
    const run =
      runMode === "fixed"
        ? { runTimePerUnit: Number(runTime), runFormula: null }
        : { runTimePerUnit: null, runFormula: runFormula.trim() };
    const descValue = description.trim() === "" ? null : description.trim();
    const prices = isLego
      ? {
          setupPrice: setupPrice.trim() === "" ? null : Number(setupPrice),
          unitPrice: unitPrice.trim() === "" ? null : Number(unitPrice),
        }
      : { setupPrice: null, unitPrice: null };
    if (!operation) {
      return {
        conditions: built,
        sequenceNo: seq,
        workCenterId,
        description: descValue,
        ...setup,
        ...run,
        ...(isLego ? prices : {}),
      };
    }
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(built) !== JSON.stringify(operation.conditions)) patch.conditions = built;
    if (seq !== operation.sequenceNo) patch.sequenceNo = seq;
    if (workCenterId !== operation.workCenterId) patch.workCenterId = workCenterId;
    if (descValue !== operation.description) patch.description = descValue;
    if (
      (setupMode === "formula") !== (operation.setupFormula != null) ||
      (setupMode === "fixed" && Number(setupTime) !== Number(operation.setupTime)) ||
      (setupMode === "formula" && setupFormula.trim() !== operation.setupFormula)
    )
      Object.assign(patch, setup);
    if (
      (runMode === "formula") !== (operation.runFormula != null) ||
      (runMode === "fixed" && Number(runTime) !== Number(operation.runTimePerUnit)) ||
      (runMode === "formula" && runFormula.trim() !== operation.runFormula)
    )
      Object.assign(patch, run);
    const priceChanged =
      prices.setupPrice !== (operation.setupPrice == null ? null : Number(operation.setupPrice)) ||
      prices.unitPrice !== (operation.unitPrice == null ? null : Number(operation.unitPrice));
    // Leaving a subcontract resource clears its prices.
    // Only when the resource changed or its type is known: an unloaded list must never wipe prices.
    if (priceChanged && (isLego || wasLego) && (workCenterId !== operation.workCenterId || centersLoaded))
      Object.assign(patch, prices);
    return patch;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSetupFormulaError(null);
    setRunFormulaError(null);
    let body: Record<string, unknown>;
    try {
      body = buildBody();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (operation && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setPending(true);
    try {
      const base = `/api/v1/articles/${articleId}/configurator/operations`;
      await apiFetch(operation ? `${base}/${operation.id}` : base, {
        method: operation ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      await onChanged();
      onClose();
    } catch (err) {
      const message = apiErrorMessage(err, "Kunde inte spara operationen");
      const isFormula = (err as { code?: string }).code === "invalid-configurator-formula";
      if (isFormula && message.startsWith("Ställtid:")) setSetupFormulaError(message);
      else if (isFormula && message.startsWith("Stycktid:")) setRunFormulaError(message);
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
        emptyHint="Utan villkor gäller operationen alltid."
      />

      <FormRow>
        <Field label="Nr" htmlFor="cfg-op-seq">
          <Input
            id="cfg-op-seq"
            type="number"
            min="1"
            step="1"
            value={sequenceNo}
            onChange={(e) => setSequenceNo(e.target.value)}
          />
        </Field>
        <Field label="Resurs" htmlFor="cfg-op-wc">
          <Select id="cfg-op-wc" value={workCenterId} onChange={(e) => setWorkCenterId(e.target.value)}>
            <option value="">— Välj —</option>
            {workCenters
              .filter((w) => w.active || w.id === workCenterId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} {w.name}
                </option>
              ))}
          </Select>
        </Field>
      </FormRow>
      <Field label="Beskrivning" htmlFor="cfg-op-desc">
        <Input id="cfg-op-desc" value={description} maxLength={255} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <Field label="Ställtid">
        <SegmentedToggle<Mode> value={setupMode} options={MODE_OPTIONS} ariaLabel="Ställtid" onChange={setSetupMode} />
      </Field>
      {setupMode === "fixed" ? (
        <Field label="Ställtid (min)" htmlFor="cfg-op-setup">
          <Input
            id="cfg-op-setup"
            type="number"
            min="0"
            step="any"
            value={setupTime}
            onChange={(e) => setSetupTime(e.target.value)}
          />
        </Field>
      ) : (
        <Field label="Formel för ställtid" htmlFor="cfg-op-setup-formula">
          <FormulaField
            id="cfg-op-setup-formula"
            value={setupFormula}
            onChange={setSetupFormula}
            codes={codes}
            error={setupFormulaError}
          />
        </Field>
      )}

      <Field label="Stycktid">
        <SegmentedToggle<Mode> value={runMode} options={MODE_OPTIONS} ariaLabel="Stycktid" onChange={setRunMode} />
      </Field>
      {runMode === "fixed" ? (
        <Field label="Stycktid (min/st)" htmlFor="cfg-op-run">
          <Input
            id="cfg-op-run"
            type="number"
            min="0"
            step="any"
            value={runTime}
            onChange={(e) => setRunTime(e.target.value)}
          />
        </Field>
      ) : (
        <Field label="Formel för stycktid" htmlFor="cfg-op-run-formula">
          <FormulaField
            id="cfg-op-run-formula"
            value={runFormula}
            onChange={setRunFormula}
            codes={codes}
            error={runFormulaError}
          />
        </Field>
      )}

      {isLego && (
        <>
          <FormRow>
            <Field label="Ställpris (kr)" htmlFor="cfg-op-setup-price">
              <Input
                id="cfg-op-setup-price"
                type="number"
                min="0"
                step="0.01"
                value={setupPrice}
                onChange={(e) => setSetupPrice(e.target.value)}
              />
            </Field>
            <Field label="Styckpris (kr/st)" htmlFor="cfg-op-unit-price">
              <Input
                id="cfg-op-unit-price"
                type="number"
                min="0"
                step="any"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
              />
            </Field>
          </FormRow>
          <FormHint>Priserna för legoresursen räknas in i förkalkylen.</FormHint>
        </>
      )}

      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" disabled={pending || !centersLoaded}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
