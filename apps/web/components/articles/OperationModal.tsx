"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
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
import type { ArticleDrawing, ArticleFile, MOOperation, MOOperationResource, Paged, RoutingOperation, Supplier, WorkCenter } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormLineRow, FormNotice, FormRow } from "../ui/Form";
import { MAX_ROUTING_ALTERNATIVES, moveItem, workCenterHasCapacity } from "../../lib/routingAlternatives";

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
  // Manufacturing-order mode: something is already reported on the operation,
  // so a resource switch warns that the time is costed at the new rate.
  reportedTime?: boolean;
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
  // Ritningar och filer (routing mode): the article's drawings and loose
  // files the operation is worked from — each the whole set.
  drawingIds?: string[];
  fileIds?: string[];
  // Routing only — Alternativa resurser, the whole set in rank order (sent
  // always, so it replaces the operation's set; [] removes it). Times are
  // minutes, null = Som ordinarie.
  alternatives?: { workCenterId: string; setupTime: number | null; runTimePerUnit: number | null }[];
  // MO mode, an operation with alternatives only — Vald för hand.
  resourceLocked?: boolean;
}

// One row of the alternative-resource editor; the times are typed text, the
// run time in the operation's time unit ("" = Som ordinarie).
interface AlternativeRow {
  key: number;
  workCenterId: string;
  setupTime: string;
  runTimePerUnit: string;
}

export function OperationModal({
  open,
  onClose,
  articleId,
  workCenters,
  editing,
  defaultSequenceNo,
  reportedTime,
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
          reportedTime={reportedTime}
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
  reportedTime,
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
  // --- Alternativa resurser, beredningen: the set in rank order. ---
  const nextAltKey = useRef(0);
  const [alternatives, setAlternatives] = useState<AlternativeRow[]>(() =>
    (routingEditing?.alternatives ?? []).map((alt) => ({
      key: nextAltKey.current++,
      workCenterId: alt.workCenterId,
      setupTime: alt.setupTime == null ? "" : String(Number(alt.setupTime)),
      runTimePerUnit: alt.runTimePerUnit == null ? "" : shownInUnit(Number(alt.runTimePerUnit), editing?.timeUnit ?? "minutes_per_unit"),
    })),
  );
  // --- Alternativa resurser, tillverkningsordern: the operation's resources
  // (rank 0 = ordinarie) and Vald för hand. A time the user has typed is never
  // overwritten by the prefill from a chosen resource ("manuellt vinner"). ---
  const moResources: MOOperationResource[] = (moMode && editing && "resources" in editing ? editing.resources : undefined) ?? [];
  const initialLocked = moMode && editing && "resourceLocked" in editing ? (editing.resourceLocked ?? false) : false;
  const [resourceLocked, setResourceLocked] = useState(initialLocked);
  const lockedTouched = useRef(false);
  const setupTouched = useRef(false);
  const runTouched = useRef(false);
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
  // --- Ritningar och filer (routing mode): the article's drawings and loose
  // files to choose among. ---
  const [articleDrawings, setArticleDrawings] = useState<ArticleDrawing[]>([]);
  const [looseFiles, setLooseFiles] = useState<ArticleFile[]>([]);
  const [drawingIds, setDrawingIds] = useState<string[]>(() => (routingEditing?.drawings ?? []).map((d) => d.id));
  const [fileIds, setFileIds] = useState<string[]>(() => (routingEditing?.files ?? []).map((f) => f.id));
  useEffect(() => {
    if (moMode || !articleId) return;
    let cancelled = false;
    Promise.all([
      apiFetch<ArticleDrawing[]>(`/api/v1/articles/${articleId}/drawings`),
      apiFetch<ArticleFile[]>(`/api/v1/articles/${articleId}/files`),
    ])
      .then(([drawings, files]) => {
        if (cancelled) return;
        setArticleDrawings(drawings);
        setLooseFiles(files.filter((f) => !f.drawingRevisionId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [moMode, articleId]);
  const [hasFile, setHasFile] = useState(routingEditing?.hasFile ?? false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedCenter = workCenters.find((wc) => wc.id === workCenterId);
  const isLego = selectedCenter?.type === "subcontract";
  // Alternatives exist on an own operation that is worked: not lego, not Kalkyl.
  const canHaveAlternatives = !moMode && !isLego && !costingOnly;
  const resourceChanged = moMode && editing !== null && workCenterId !== editing.workCenterId;
  const onResourceRow = moResources.some((r) => r.workCenterId === workCenterId);

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
    setAlternatives((rows) =>
      rows.map((row) => {
        const typed = Number(row.runTimePerUnit);
        return row.runTimePerUnit.trim() !== "" && Number.isFinite(typed) && typed > 0
          ? { ...row, runTimePerUnit: convert(typed) }
          : row;
      }),
    );
    setTimeUnit(next);
  }

  function handleWorkCenterChange(id: string) {
    const previousId = workCenterId;
    setWorkCenterId(id);
    // MO mode: a resource of the operation fills the times from its row, unless
    // the user has typed them; Vald för hand follows the switch, unless the
    // checkbox has been touched.
    if (moMode && editing) {
      const row = moResources.find((r) => r.workCenterId === id);
      if (row) {
        if (!setupTouched.current) setSetupTime(String(Number(row.setupTime)));
        if (!runTouched.current) setRunTimePerUnit(shownInUnit(Number(row.runTimePerUnit), timeUnit));
      }
      if (!lockedTouched.current && moResources.length > 0) setResourceLocked(id !== editing.workCenterId ? true : initialLocked);
    }
    // Routing mode: the new ordinarie cannot also be an alternative — the old
    // ordinarie takes its place in the list (a swap), with its own times.
    if (!moMode && previousId !== id && alternatives.some((a) => a.workCenterId === id)) {
      setAlternatives((rows) =>
        rows.map((a) => (a.workCenterId === id ? { ...a, workCenterId: previousId, setupTime: "", runTimePerUnit: "" } : a)),
      );
    }
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
    if (
      canHaveAlternatives &&
      timeUnit === "units_per_hour" &&
      alternatives.some((a) => a.runTimePerUnit.trim() !== "" && !(Number(a.runTimePerUnit) > 0))
    ) {
      setError("Antal per timme måste vara större än 0 (lämna fältet tomt för Som ordinarie)");
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
        ...(moMode ? {} : { costingOnly, useArticleDrawing: isLego ? useArticleDrawing : true, drawingIds, fileIds }),
        // The whole set, so a swap of ordinarie and alternative passes; a lego or
        // Kalkyl operation carries none.
        ...(moMode
          ? moResources.length > 0 && (resourceChanged || resourceLocked !== initialLocked)
            ? { resourceLocked }
            : {}
          : {
              alternatives: canHaveAlternatives
                ? alternatives.map((row) => ({
                    workCenterId: row.workCenterId,
                    setupTime: row.setupTime.trim() === "" ? null : Number(row.setupTime),
                    runTimePerUnit: row.runTimePerUnit.trim() === "" ? null : runTimeToMinutes(Number(row.runTimePerUnit), timeUnit),
                  }))
                : [],
            }),
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
            {moResources.length > 0 && (
              <optgroup label="Operationens resurser">
                {moResources.map((r) => (
                  <option key={r.workCenterId} value={r.workCenterId}>
                    {r.code} · {r.name} ({r.rank === 0 ? "ordinarie" : "alternativ"})
                  </option>
                ))}
              </optgroup>
            )}
            {standardCenters.filter((wc) => !moResources.some((r) => r.workCenterId === wc.id)).length > 0 && (
              <optgroup label={moResources.length > 0 ? "Övriga resurser" : "Resurser"}>
                {standardCenters.filter((wc) => !moResources.some((r) => r.workCenterId === wc.id)).map((wc) => (
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

      {moMode && moResources.length > 0 && !onResourceRow && resourceChanged && (
        <FormNotice>
          Resursen är inte en av operationens resurser. Operationens alternativ tas bort från ordern, och Vald för hand
          försvinner.
        </FormNotice>
      )}
      {moMode && resourceChanged && reportedTime && (
        <FormNotice>
          Tid som redan är rapporterad står kvar på resursen den gjordes på och räknas med dess timkostnad. Ny tid hamnar
          på den nya resursen.
        </FormNotice>
      )}
      {moMode && moResources.length > 0 && onResourceRow && (
        <>
          <label style={checkboxRowStyle}>
            <Checkbox
              id="resourceLocked"
              checked={resourceLocked}
              onChange={(e) => {
                lockedTouched.current = true;
                setResourceLocked(e.target.checked);
              }}
            />
            Vald för hand
          </label>
          <FormHint attached>
            Resursen är vald av dig. Kryssa ur för att operationen åter kan få förslag på en annan resurs.
          </FormHint>
        </>
      )}

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
              <Input id="unitPrice" type="number" size="sm" min="0" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
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
            <Input id="setupTime" type="number" size="sm" min="0" step="0.01" required value={setupTime} onChange={(e) => { setupTouched.current = true; setSetupTime(e.target.value); }} />
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
                onChange={(e) => { runTouched.current = true; setRunTimePerUnit(e.target.value); }}
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

      {!moMode && !isLego && costingOnly && alternatives.length > 0 && (
        <FormNotice>
          Operationens {alternatives.length} alternativa resurser tas bort när den sparas som Kalkyl.
        </FormNotice>
      )}
      {!moMode && isLego && alternatives.length > 0 && (
        <FormNotice>
          Operationens {alternatives.length} alternativa resurser tas bort när den sparas på en legoresurs.
        </FormNotice>
      )}
      {canHaveAlternatives && (
        <AlternativesSection
          rows={alternatives}
          setRows={setAlternatives}
          nextKey={() => nextAltKey.current++}
          ordinaryId={workCenterId}
          workCenters={workCenters}
          known={routingEditing?.alternatives ?? []}
          timeUnit={timeUnit}
        />
      )}

      {/* Ritningar och filer: which of the article's drawings and files the
          operation is worked from — the terminal and the printout show them,
          a lego operation's mail sends only them. None chosen = all. */}
      {!moMode && (articleDrawings.length > 0 || looseFiles.length > 0) && (
        <fieldset className={styles.drawings}>
          <legend className={fieldStyles.label}>Ritningar och filer (valfritt)</legend>
          {articleDrawings.map((drawing) => {
            const active = drawing.revisions.find((r) => r.isActive);
            return (
              <label key={drawing.id} style={checkboxRowStyle}>
                <Checkbox
                  checked={drawingIds.includes(drawing.id)}
                  onChange={(e) =>
                    setDrawingIds((ids) => (e.target.checked ? [...ids, drawing.id] : ids.filter((id) => id !== drawing.id)))
                  }
                />
                {drawing.drawingNumber}
                {active ? ` rev ${active.revision}` : ""}
              </label>
            );
          })}
          {looseFiles.map((file) => (
            <label key={file.id} style={checkboxRowStyle}>
              <Checkbox
                checked={fileIds.includes(file.id)}
                onChange={(e) => setFileIds((ids) => (e.target.checked ? [...ids, file.id] : ids.filter((id) => id !== file.id)))}
              />
              {file.filename}
            </label>
          ))}
          <FormHint attached>
            Terminalen och tillverkningsorderns utskrift visar de valda ritningarna och filerna vid operationen, och en
            legooperation som använder artikelns ritningar mejlar bara dem. Utan val gäller alla artikelns ritningar och
            filer.
          </FormHint>
        </fieldset>
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

// Alternativa resurser: the operation's own alternatives in rank order. A row
// stacks its fields (the modal body is only 496 px wide); an empty time shows
// "Som ordinarie" and means the operation's own time.
function AlternativesSection({
  rows,
  setRows,
  nextKey,
  ordinaryId,
  workCenters,
  known,
  timeUnit,
}: {
  rows: AlternativeRow[];
  setRows: (update: (rows: AlternativeRow[]) => AlternativeRow[]) => void;
  nextKey: () => number;
  ordinaryId: string;
  workCenters: WorkCenter[];
  known: NonNullable<RoutingOperation["alternatives"]>;
  timeUnit: OperationTimeUnit;
}) {
  // Own resources only, never the ordinarie or one already in the list; an
  // inactive resource stays selectable where it already is.
  const options = (current: string) =>
    workCenters.filter(
      (wc) =>
        wc.type !== "subcontract" &&
        wc.id !== ordinaryId &&
        (wc.active || wc.id === current) &&
        (wc.id === current || !rows.some((r) => r.workCenterId === wc.id)),
    );
  const free = options("").length;
  const update = (key: number, patch: Partial<AlternativeRow>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const capacityOf = (id: string) => {
    const wc = workCenters.find((w) => w.id === id);
    return wc ? workCenterHasCapacity(wc) : (known.find((k) => k.workCenterId === id)?.hasCapacity ?? true);
  };

  return (
    <>
      <Field label="Alternativa resurser">
        <FormHint>
          Resurser operationen kan köras på när den ordinarie är full. Ordningen är rangordningen. Ett tomt tidsfält
          betyder Som ordinarie.
        </FormHint>
      </Field>
      {rows.map((row, index) => (
        <FormLineRow key={row.key}>
          <Field label="Resurs" htmlFor={`altResource-${row.key}`}>
            <Select
              id={`altResource-${row.key}`}
              value={row.workCenterId}
              onChange={(e) => update(row.key, { workCenterId: e.target.value })}
            >
              {options(row.workCenterId).map((wc) => (
                <option key={wc.id} value={wc.id}>
                  {wc.code} · {wc.name}
                  {!wc.active ? " (inaktiv)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {!capacityOf(row.workCenterId) && (
            <FormHint attached>Saknar kapacitet — föreslås aldrig</FormHint>
          )}
          <FormRow>
            <Field label="Ställtid (min)" htmlFor={`altSetup-${row.key}`}>
              <Input
                id={`altSetup-${row.key}`}
                type="number"
                min="0"
                step="any"
                placeholder="Som ordinarie"
                value={row.setupTime}
                onChange={(e) => update(row.key, { setupTime: e.target.value })}
              />
            </Field>
            <Field label={`Tid/enhet (${OPERATION_TIME_UNIT_LABELS[timeUnit]})`} htmlFor={`altRun-${row.key}`}>
              <Input
                id={`altRun-${row.key}`}
                type="number"
                min="0"
                step="any"
                placeholder="Som ordinarie"
                value={row.runTimePerUnit}
                onChange={(e) => update(row.key, { runTimePerUnit: e.target.value })}
              />
            </Field>
          </FormRow>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              aria-label={`Upp: alternativ ${index + 1}`}
              disabled={index === 0}
              onClick={() => setRows((current) => moveItem(current, index, -1))}
            >
              <ArrowUp size={14} aria-hidden="true" /> Upp
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="small"
              aria-label={`Ned: alternativ ${index + 1}`}
              disabled={index === rows.length - 1}
              onClick={() => setRows((current) => moveItem(current, index, 1))}
            >
              <ArrowDown size={14} aria-hidden="true" /> Ned
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            >
              Ta bort
            </Button>
          </div>
        </FormLineRow>
      ))}
      <div>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={rows.length >= MAX_ROUTING_ALTERNATIVES || free === 0}
          onClick={() => {
            const first = options("")[0];
            if (first) setRows((current) => [...current, { key: nextKey(), workCenterId: first.id, setupTime: "", runTimePerUnit: "" }]);
          }}
        >
          + Lägg till alternativ
        </Button>
        {rows.length >= MAX_ROUTING_ALTERNATIVES && <FormHint>Högst {MAX_ROUTING_ALTERNATIVES} alternativ.</FormHint>}
      </div>
    </>
  );
}
