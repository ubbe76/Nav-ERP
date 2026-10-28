"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Modal } from "../ui/Modal";
import { useCanOpen } from "../PermissionsProvider";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import fieldStyles from "../ui/Field.module.css";
import styles from "./OperationModal.module.css";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { OPERATION_TIME_UNIT_LABELS, runTimeInUnit, runTimeToMinutes, type OperationTimeUnit } from "../../lib/units";
import type { MOOperation, Paged, RoutingOperation, Supplier, WorkCenter } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

interface OperationModalProps {
  open: boolean;
  onClose: () => void;
  // The article whose routing is edited (routing mode only).
  articleId?: string;
  workCenters: WorkCenter[];
  // null = the modal creates a new operation; a row = it edits that row.
  editing: RoutingOperation | MOOperation | null;
  // Manufacturing-order mode: the form saves through this callback instead of
  // the article's routing endpoints, and hides the routing-only fields
  // (Kalkyl, the lego drawing upload). Absent = the beredning's behaviour.
  onSubmit?: (payload: OperationPayload) => Promise<void>;
  // Suggested Sekvensnr for a new operation (last + 10).
  defaultSequenceNo: number;
  onSaved: () => void;
}

// What the form sends — the fields the routing and the MO operation share, plus
// the routing-only costingOnly/useArticleDrawing (omitted in MO mode).
export interface OperationPayload {
  sequenceNo: number;
  description: string;
  workCenterId: string;
  setupTime: number;
  runTimePerUnit: number;
  // Routing only (an MO operation has no Cykeltid yet) — minutes per unit,
  // null = not set.
  cycleTimePerUnit?: number | null;
  timeUnit: OperationTimeUnit;
  costingOnly?: boolean;
  comment: string;
  printOnWorkCard: boolean;
  packingInstructions: string;
  subcontractSupplierId: string | null;
  setupPrice: number | null;
  unitPrice: number | null;
  transportPrice: number | null;
  showNetWeight: boolean;
  useArticleDrawing?: boolean;
}

export function OperationModal({
  open,
  onClose,
  articleId,
  workCenters,
  editing,
  defaultSequenceNo,
  onSaved,
  onSubmit,
}: OperationModalProps) {
  // Resources are a Tillverkning register; an Artiklar-only user gets the
  // explanation without a button into a page they can't open.
  const canOpenResources = useCanOpen()("/tillverkning/resurser");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Ändra operation ${editing.sequenceNo}` : "Ny operation"}
    >
      {workCenters.length === 0 ? (
        <div>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 13.5 }}>
            Det finns inga resurser än. Skapa en resurs innan du kan lägga till en operation.
          </p>
          {canOpenResources && (
            <FormActions>
              <Link href="/tillverkning/resurser">
                <Button type="button" variant="primary">
                  Till resurser
                </Button>
              </Link>
            </FormActions>
          )}
        </div>
      ) : (
        // The Modal unmounts its children while closed, so the form state
        // below re-initialises from `editing` on every open.
        <OperationForm
          articleId={articleId}
          workCenters={workCenters}
          editing={editing}
          defaultSequenceNo={defaultSequenceNo}
          onSaved={onSaved}
          onSubmit={onSubmit}
        />
      )}
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

function OperationForm({
  articleId,
  workCenters,
  editing,
  defaultSequenceNo,
  onSaved,
  onSubmit,
}: Omit<OperationModalProps, "open" | "onClose">) {
  // MO mode: an order's operation has no Kalkyl flag and no routing file.
  const moMode = onSubmit !== undefined;
  // Routing-only fields exist on the beredning's row, not on an MO operation.
  const routingEditing = editing && "costingOnly" in editing ? editing : null;
  // The resource picker splits ordinary resources from legoresurser — a lego
  // operation is bought (supplier + prices), not timed.
  const standardCenters = workCenters.filter((wc) => wc.type !== "subcontract");
  const legoCenters = workCenters.filter((wc) => wc.type === "subcontract");

  const [sequenceNo, setSequenceNo] = useState(String(editing ? editing.sequenceNo : defaultSequenceNo));
  const [description, setDescription] = useState(editing?.description ?? "");
  const [workCenterId, setWorkCenterId] = useState(
    editing?.workCenterId ?? standardCenters[0]?.id ?? workCenters[0]?.id ?? ""
  );
  const [setupTime, setSetupTime] = useState(editing ? String(Number(editing.setupTime)) : "0");
  // Display preference — see packages/shared/src/units.ts. The initial
  // Tid/enhet text is shown in whichever unit the operation was saved with,
  // never the raw stored minutes, so editing an st/h operation doesn't
  // silently flip it back to minutes on open.
  const [timeUnit, setTimeUnit] = useState<OperationTimeUnit>(editing?.timeUnit ?? "minutes_per_unit");
  // Guard: 0 (or less) has no meaningful st/h conversion (division by
  // zero/negative) — show it as-is regardless of the stored unit.
  const shownInUnit = (minutes: number, unit: OperationTimeUnit) =>
    unit === "units_per_hour" && !(minutes > 0) ? String(minutes) : String(runTimeInUnit(minutes, unit));
  const [runTimePerUnit, setRunTimePerUnit] = useState(() =>
    editing ? shownInUnit(Number(editing.runTimePerUnit), editing.timeUnit) : "0"
  );
  // Cykeltid — typed in the SAME unit as Tid/enhet; "" = not set.
  const [cycleTime, setCycleTime] = useState(() => {
    const stored = routingEditing?.cycleTimePerUnit;
    if (stored == null) return "";
    return shownInUnit(Number(stored), editing?.timeUnit ?? "minutes_per_unit");
  });
  const [costingOnly, setCostingOnly] = useState(routingEditing?.costingOnly ?? false);
  const [comment, setComment] = useState(editing?.comment ?? "");
  const [printOnWorkCard, setPrintOnWorkCard] = useState(editing?.printOnWorkCard ?? false);
  const [packingInstructions, setPackingInstructions] = useState(editing?.packingInstructions ?? "");
  // --- Lego fields (sent only when the chosen resource is a legoresurs) ---
  const [subcontractSupplierId, setSubcontractSupplierId] = useState(editing?.subcontractSupplierId ?? "");
  const [setupPrice, setSetupPrice] = useState(editing?.setupPrice != null ? String(Number(editing.setupPrice)) : "");
  const [unitPrice, setUnitPrice] = useState(editing?.unitPrice != null ? String(Number(editing.unitPrice)) : "");
  const [transportPrice, setTransportPrice] = useState(
    editing?.transportPrice != null ? String(Number(editing.transportPrice)) : "",
  );
  const [showNetWeight, setShowNetWeight] = useState(editing?.showNetWeight ?? false);
  const [useArticleDrawing, setUseArticleDrawing] = useState(routingEditing?.useArticleDrawing ?? true);
  const [hasFile, setHasFile] = useState(routingEditing?.hasFile ?? false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedCenter = workCenters.find((wc) => wc.id === workCenterId);
  const isLego = selectedCenter?.type === "subcontract";

  // Suppliers for the lego operation's Leverantör select — fetched once, and
  // only when the routing can have lego operations at all.
  useEffect(() => {
    if (legoCenters.length === 0) return;
    apiFetch<Paged<Supplier>>("/api/v1/suppliers?limit=1000")
      .then((res) => setSuppliers(res.rows))
      .catch(() => setSuppliers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per open
  }, []);

  // Converts the currently typed Tid/enhet value in place so the number
  // shown always matches the active unit — the field never silently jumps to
  // a different-looking value on toggle. A 0/invalid value is left alone
  // (st/h has no meaningful conversion for it); the >0 validation on submit
  // catches that case.
  function handleTimeUnitChange(next: OperationTimeUnit) {
    if (next === timeUnit) return;
    // Via minutes, so any pair of units converts the same way.
    const convert = (value: number) => String(runTimeInUnit(runTimeToMinutes(value, timeUnit), next));
    const current = Number(runTimePerUnit);
    if (Number.isFinite(current) && current > 0) setRunTimePerUnit(convert(current));
    // Cykeltid follows the same unit as Tid/enhet.
    const currentCycle = Number(cycleTime);
    if (cycleTime.trim() !== "" && Number.isFinite(currentCycle) && currentCycle > 0) setCycleTime(convert(currentCycle));
    setTimeUnit(next);
  }

  function handleWorkCenterChange(id: string) {
    setWorkCenterId(id);
    const center = workCenters.find((wc) => wc.id === id);
    if (center?.type === "subcontract") {
      // Default the operation's supplier from the resource — but never
      // overwrite a supplier already chosen on the row being edited.
      setSubcontractSupplierId((current) => current || (center.supplierId ?? ""));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // 0 st/h has no meaning (a user wanting 0 stycktid flips to min/st) — the
    // server stores minutes regardless, so this must be caught client-side.
    if (!isLego && timeUnit === "units_per_hour" && !(Number(runTimePerUnit) > 0)) {
      setError("Antal per timme måste vara större än 0");
      return;
    }
    // Same rule for Cykeltid: an empty field means none, but a typed 0 st/h
    // has no meaning (and would convert to Infinity minutes).
    if (!isLego && !moMode && timeUnit === "units_per_hour" && cycleTime.trim() !== "" && !(Number(cycleTime) > 0)) {
      setError("Cykeltid i st/h måste vara större än 0 (lämna fältet tomt för ingen cykeltid)");
      return;
    }
    setPending(true);
    try {
      const payload: OperationPayload = {
        sequenceNo: Number(sequenceNo),
        description,
        workCenterId,
        // Lego operations carry no times — the columns are NOT NULL, so 0.
        setupTime: isLego ? 0 : Number(setupTime),
        // Canonical storage is always minutes per unit — st/h and sek/st are
        // converted here, once, at the submit boundary.
        runTimePerUnit: isLego ? 0 : runTimeToMinutes(Number(runTimePerUnit), timeUnit),
        // Cykeltid: same conversion as Tid/enhet; empty = null (clears). Lego
        // has no times, so it always clears; an MO operation has no field.
        ...(moMode
          ? {}
          : {
              cycleTimePerUnit:
                isLego || cycleTime.trim() === "" ? null : runTimeToMinutes(Number(cycleTime), timeUnit),
            }),
        // Lego hides the time fields entirely, so it always forces minutes —
        // a stray st/h preference from before the resource switch must not
        // survive the save.
        timeUnit: isLego ? "minutes_per_unit" : timeUnit,
        comment,
        // Nothing to print without a comment — keeps the flag from lingering
        // on a row whose text was just erased.
        printOnWorkCard: comment.trim() === "" ? false : printOnWorkCard,
        packingInstructions,
        // Lego fields — nulls/defaults on an ordinary resource so a resource
        // switch clears them (the server enforces the same rule).
        subcontractSupplierId: isLego && subcontractSupplierId !== "" ? subcontractSupplierId : null,
        setupPrice: isLego && setupPrice !== "" ? Number(setupPrice) : null,
        unitPrice: isLego && unitPrice !== "" ? Number(unitPrice) : null,
        transportPrice: isLego && transportPrice !== "" ? Number(transportPrice) : null,
        showNetWeight: isLego ? showNetWeight : false,
        ...(moMode ? {} : { costingOnly, useArticleDrawing: isLego ? useArticleDrawing : true }),
      };
      if (onSubmit) {
        await onSubmit(payload);
        onSaved();
        return;
      }
      let operationId = editing?.id;
      if (editing) {
        await apiFetch(`/api/v1/articles/${articleId}/routing/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        const created = await apiFetch<RoutingOperation>(`/api/v1/articles/${articleId}/routing`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        operationId = created.id;
      }

      // Optional drawing upload for the lego operation (own file instead of
      // the article's drawings) — after the operation exists. Multipart, so
      // raw fetch instead of apiFetch (which sets a JSON content type) —
      // same as the article file upload in FilerTab.tsx.
      const file = fileInputRef.current?.files?.[0];
      if (isLego && !useArticleDrawing && file && operationId) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(`${API_URL}/api/v1/articles/${articleId}/routing/${operationId}/file`, {
          method: "PUT",
          credentials: "include",
          body,
        });
        if (!res.ok) {
          const uploadError = await res.json().catch(() => ({}));
          throw new Error(
            (uploadError as { error?: string }).error ?? "Operationen sparades men ritningen kunde inte laddas upp"
          );
        }
      }
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara operationen"));
    } finally {
      setPending(false);
    }
  }

  async function removeFile() {
    if (!routingEditing) return;
    if (!(await confirmDelete("Ta bort operationens ritning?"))) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/routing/${routingEditing.id}/file`, { method: "DELETE" });
      setHasFile(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort ritningen"));
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Sekvensnr" htmlFor="sequenceNo">
          <Input id="sequenceNo" type="number" size="xs" min="1" step="1" required value={sequenceNo} onChange={(e) => setSequenceNo(e.target.value)} />
        </Field>
        <Field label="Resurs" htmlFor="workCenterId">
          <Select id="workCenterId" value={workCenterId} onChange={(e) => handleWorkCenterChange(e.target.value)}>
            {standardCenters.length > 0 && (
              <optgroup label="Resurser">
                {standardCenters.map((wc) => (
                  <option key={wc.id} value={wc.id}>
                    {wc.code} · {wc.name}
                  </option>
                ))}
              </optgroup>
            )}
            {legoCenters.length > 0 && (
              <optgroup label="Legoresurser">
                {legoCenters.map((wc) => (
                  <option key={wc.id} value={wc.id}>
                    {wc.code} · {wc.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
      </FormRow>

      <Field label="Beskrivning (valfritt)" htmlFor="description">
        <Input
          id="description"
          maxLength={255}
          placeholder="T.ex. Kapning"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <FormHint attached>
        Vad operationen är, till skillnad från vilken resurs den körs på. Visas i stället för resursnamnet på
        arbetskortet, i stämpelterminalen och i strukturradens operationsval. Lämnas den tom visas resursnamnet
        precis som förut.
      </FormHint>

      {isLego ? (
        <>
          <Field label="Leverantör" htmlFor="subcontractSupplierId">
            <Select
              id="subcontractSupplierId"
              value={subcontractSupplierId}
              onChange={(e) => setSubcontractSupplierId(e.target.value)}
            >
              <option value="">— Ingen —</option>
              {suppliers
                .filter((s) => s.active || s.id === subcontractSupplierId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {!s.active ? " (inaktiv)" : ""}
                  </option>
                ))}
            </Select>
          </Field>
          <FormHint attached>
            Leverantören som legoinköpet går till — förifylld från legoresursen. Utan leverantör kan
            behovsberäkningen inte skapa någon inköpsorder för operationen.
          </FormHint>

          <FormRow>
            <Field label="Ställpris" htmlFor="setupPrice">
              <Input id="setupPrice" type="number" size="sm" min="0" step="0.01" value={setupPrice} onChange={(e) => setSetupPrice(e.target.value)} />
            </Field>
            <Field label="Styckpris" htmlFor="unitPrice">
              <Input id="unitPrice" type="number" size="sm" min="0" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Transportkostnad (kr)" htmlFor="transportPrice">
              <Input id="transportPrice" type="number" size="sm" min="0" step="0.01" value={transportPrice} onChange={(e) => setTransportPrice(e.target.value)} />
            </Field>
          </FormRow>
          <FormHint attached>
            Ställpriset läggs på en gång per inköpsorder, styckpriset per enhet. Transportkostnaden är frakten till och
            från leverantören, en gång per order — den läggs till ställpriset på inköpsorderraden. Alla tre räknas in i
            förkalkylen som legokostnad med LO-påslag.
          </FormHint>

          <label style={checkboxRowStyle}>
            <Checkbox id="showNetWeight" checked={showNetWeight} onChange={(e) => setShowNetWeight(e.target.checked)} />
            Visa nettovikt på legoinköpet
          </label>
          <FormHint attached>
            Skriver ut Nettovikt (artikelns vikt × antal) på inköpsorderns rad. Kräver att artikeln har en vikt.
          </FormHint>

          <label style={checkboxRowStyle}>
            <Checkbox
              id="useArticleDrawing"
              checked={useArticleDrawing}
              onChange={(e) => setUseArticleDrawing(e.target.checked)}
            />
            Använd artikelns ritningar
          </label>
          <FormHint attached>
            Legoinköpets mejl bifogar alltid ritning: artikelns kopplade filer (fliken Filer) med kryss, annars en
            fil som laddas upp här på operationen.
          </FormHint>

          {!moMode && !useArticleDrawing && (
            <>
              <Field label="Ritning (PDF/JPEG/PNG, max 20 MB)" htmlFor="operationFile">
                <input
                  id="operationFile"
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className={fieldStyles.input}
                />
              </Field>
              {hasFile && routingEditing && (
                <FormHint attached>
                  En ritning finns redan på operationen —{" "}
                  <a
                    href={`${API_URL}/api/v1/articles/${articleId}/routing/${routingEditing.id}/file/download`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    öppna
                  </a>
                  . En ny uppladdning ersätter den.{" "}
                  <button
                    type="button"
                    onClick={removeFile}
                    style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", textDecoration: "underline", color: "inherit" }}
                  >
                    Ta bort ritningen
                  </button>
                </FormHint>
              )}
            </>
          )}
        </>
      ) : (
        <FormRow>
          <Field label="Ställtid (min)" htmlFor="setupTime">
            <Input id="setupTime" type="number" size="sm" min="0" step="0.01" required value={setupTime} onChange={(e) => setSetupTime(e.target.value)} />
          </Field>
          <Field label="Tid/enhet" htmlFor="runTimePerUnit">
            <div className={styles.runTimeRow}>
              <Input
                id="runTimePerUnit"
                type="number"
                size="sm"
                min="0"
                step="0.01"
                required
                value={runTimePerUnit}
                onChange={(e) => setRunTimePerUnit(e.target.value)}
              />
              <SegmentedToggle
                value={timeUnit}
                onChange={handleTimeUnitChange}
                ariaLabel="Tidsenhet"
                options={[
                  { value: "minutes_per_unit", label: OPERATION_TIME_UNIT_LABELS.minutes_per_unit },
                  { value: "seconds_per_unit", label: OPERATION_TIME_UNIT_LABELS.seconds_per_unit },
                  { value: "units_per_hour", label: OPERATION_TIME_UNIT_LABELS.units_per_hour },
                ]}
              />
            </div>
          </Field>
        </FormRow>
      )}
      {!isLego && !moMode && (
        <>
          <Field label={`Cykeltid (${OPERATION_TIME_UNIT_LABELS[timeUnit]}, valfritt)`} htmlFor="cycleTimePerUnit">
            <Input
              id="cycleTimePerUnit"
              type="number"
              size="sm"
              min="0"
              step="any"
              value={cycleTime}
              onChange={(e) => setCycleTime(e.target.value)}
            />
          </Field>
          <FormHint attached>
            Operationens produktiva tid per styck, i samma enhet som Tid/enhet. Används inte i kalkylen eller
            beläggningen ännu.
          </FormHint>
        </>
      )}

      {/* Checkbox (ui/Field.tsx) has no `label` prop — the visible text
          is a sibling inside a wrapping <label>, same pattern as
          NewStockCountForm.tsx. */}
      {!moMode && (
        <>
          <label style={checkboxRowStyle}>
            <Checkbox id="costingOnly" checked={costingOnly} onChange={(e) => setCostingOnly(e.target.checked)} />
            Kalkyl
          </label>
          <FormHint attached>
            Operationen räknas med i förkalkylen — standardpris och försäljningspris — men följer inte med när en
            tillverkningsorder frisläpps. Den syns alltså inte på arbetskortet, i stämpelterminalen, i beläggningen
            eller i efterkalkylen. En operation som material är kopplat till kan inte märkas Kalkyl.
          </FormHint>
        </>
      )}

      <Field label="Kommentar (valfritt)" htmlFor="comment">
        <textarea
          id="comment"
          rows={3}
          maxLength={1000}
          className={fieldStyles.input}
          style={{ resize: "vertical" }}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Field>

      <label style={checkboxRowStyle}>
        <Checkbox
          id="printOnWorkCard"
          checked={printOnWorkCard}
          disabled={comment.trim() === ""}
          onChange={(e) => setPrintOnWorkCard(e.target.checked)}
        />
        Skriv ut på arbetskortet
      </label>
      <FormHint attached>
        {moMode
          ? "Kommentaren skrivs ut under operationsraden på utskriften Skriv ut TO (PDF). Utan kryss syns den bara här på tillverkningsordern."
          : "Kommentaren skrivs ut under operationsraden på utskriften Skriv ut TO (PDF). Utan kryss syns den bara här på artikelkortet. Texten som gäller när tillverkningsordern frisläpps är den som hamnar på utskriften — senare ändringar i rutten påverkar inte en redan frisläppt order."}
      </FormHint>

      <Field label="Packinstruktion (valfritt)" htmlFor="packingInstructions">
        <textarea
          id="packingInstructions"
          rows={3}
          maxLength={1000}
          className={fieldStyles.input}
          style={{ resize: "vertical" }}
          value={packingInstructions}
          onChange={(e) => setPackingInstructions(e.target.value)}
        />
      </Field>
      <FormHint attached>
        Hur artiklarna packas inför nästa operation/avsändning. Skrivs alltid ut under operationsraden på
        utskriften Skriv ut TO (PDF) och visas i stämpelterminalen, oavsett Skriv ut på arbetskortet.
      </FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : editing ? "Spara ändringar" : "Lägg till operation"}
        </Button>
      </FormActions>
    </Form>
  );
}
