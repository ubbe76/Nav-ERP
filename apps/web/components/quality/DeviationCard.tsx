"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { Field, Select, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormSaved } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import { PdfActions } from "../documents/PdfActions";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDateTime } from "../../lib/date";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import {
  DEVIATION_ACTION_LABELS,
  DEVIATION_DECISIONS,
  DEVIATION_DECISION_LABELS,
  DEVIATION_STATUS_PILL,
  DEVIATION_TYPE_LABELS,
  formatDeviationQuantity,
  type Deviation,
  type DeviationAction,
  type DeviationDecision,
  type DeviationReason,
  type ResponsibleCandidate,
} from "../../lib/quality";
import { DeviationCostsSection } from "./DeviationCosts";
import { DeviationFields } from "./DeviationFields";
import { draftFromDeviation, draftPayload, draftProblem, type DeviationDraft } from "./deviationDraft";
import { DeviationFilesSection } from "./DeviationFiles";
import { DeviationHistory } from "./DeviationHistory";
import { DeviationLinksSection } from "./DeviationLinks";
import styles from "./Deviations.module.css";

// The order the status buttons come in.
const ACTION_ORDER: DeviationAction[] = ["start", "close", "cancel", "reopen"];

function Item({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? styles.wide : undefined}>
      <div className={styles.gridLabel}>{label}</div>
      <div className={`${styles.gridValue} ${wide ? styles.pre : ""}`}>
        {children === null || children === undefined || children === "" ? <span className={styles.muted}>–</span> : children}
      </div>
    </div>
  );
}

// The case read-only: closed and cancelled cases, and users without Kvalitet.
function DeviationDetails({ deviation }: { deviation: Deviation }) {
  const d = deviation;
  return (
    <Card maxWidth="none">
      <div className={styles.grid}>
        <Item label="Rubrik" wide>
          {d.title}
        </Item>
        <Item label="Datum">{d.reportedDate}</Item>
        <Item label="Orsak">{d.reasonName ? `${d.reasonCode} · ${d.reasonName}` : null}</Item>
        <Item label="Ansvarig">{d.responsibleUserName}</Item>
        <Item label="Åtgärd senast">
          {d.dueDate ? <span className={d.overdue ? styles.overdue : undefined}>{d.dueDate}</span> : null}
        </Item>
        {d.type === "customer" && (
          <Item label="Kund">
            {d.customerId ? (
              <GatedLink href={`/kunder/${d.customerId}`} className={styles.photoLink}>
                {d.customerName}
              </GatedLink>
            ) : null}
          </Item>
        )}
        {d.type === "supplier" && (
          <Item label="Leverantör">
            {d.supplierId ? (
              <GatedLink href={`/leverantorer/${d.supplierId}`} className={styles.photoLink}>
                {d.supplierName}
              </GatedLink>
            ) : null}
          </Item>
        )}
        {d.type !== "internal" && (
          <Item label={d.type === "customer" ? "Kundens referens" : "Leverantörens referens"}>{d.counterpartyReference}</Item>
        )}
        {d.type === "customer" && (
          <>
            <Item label="Kundorder">
              {d.salesOrderId ? (
                <GatedLink href={`/forsaljning/ordrar/${d.salesOrderId}`} className={styles.photoLink}>
                  {d.salesOrderNumber}
                </GatedLink>
              ) : null}
            </Item>
            <Item label="Faktura">
              {d.invoiceId ? (
                <GatedLink href={`/forsaljning/fakturor/${d.invoiceId}`} className={styles.photoLink}>
                  {d.invoiceNumber ?? "Utkast"}
                </GatedLink>
              ) : null}
            </Item>
          </>
        )}
        {d.type === "supplier" && (
          <Item label="Inköpsorder">
            {d.purchaseOrderId ? (
              <GatedLink href={`/inkop/ordrar/${d.purchaseOrderId}`} className={styles.photoLink}>
                {d.purchaseOrderNumber}
              </GatedLink>
            ) : null}
          </Item>
        )}
        <Item label="Tillverkningsorder">
          {d.manufacturingOrderId ? (
            <>
              <GatedLink href={`/tillverkning/ordrar/${d.manufacturingOrderId}`} className={styles.photoLink}>
                {d.manufacturingOrderNumber}
              </GatedLink>
              {d.moOperationSequenceNo !== null && ` · Op ${d.moOperationSequenceNo} ${d.moOperationWorkCenterName ?? ""}`}
            </>
          ) : null}
        </Item>
        <Item label="Artikel">
          {d.articleId ? (
            <GatedLink href={`/artiklar/${d.articleId}`} className={styles.photoLink}>
              {d.articleNumber} — {d.articleName}
            </GatedLink>
          ) : null}
        </Item>
        <Item label="Antal">{d.quantity !== null ? formatDeviationQuantity(d.quantity, d.unitCode) : null}</Item>
        {d.type !== "internal" && <Item label="Beslut">{d.decision ? DEVIATION_DECISION_LABELS[d.decision] : null}</Item>}
        <Item label="Beskrivning" wide>
          {d.description}
        </Item>
        <Item label="Orsaksanalys" wide>
          {d.causeAnalysis}
        </Item>
        <Item label="Åtgärd" wide>
          {d.correctiveAction}
        </Item>
        <Item label="Förebyggande åtgärd" wide>
          {d.preventiveAction}
        </Item>
      </div>
    </Card>
  );
}

// Avsluta: Beslut for customer and supplier cases; Åtgärd must be saved first.
function CloseDialog({
  deviation,
  open,
  onClose,
  onDone,
}: {
  deviation: Deviation;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const needsDecision = deviation.type !== "internal";
  const [decision, setDecision] = useState<"" | DeviationDecision>(deviation.decision ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const missingAction = deviation.closeRequirementsMissing.includes("correctiveAction");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (needsDecision && decision === "") {
      setError("Välj Beslut.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviation.id}/close`, {
        method: "POST",
        body: JSON.stringify(needsDecision ? { decision } : {}),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte avsluta avvikelsen"));
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Avsluta ${deviation.deviationNumber}`}>
      <Form onSubmit={submit}>
        <FormError>{error}</FormError>
        {missingAction && <FormNotice>Fyll i Åtgärd (och spara) innan avvikelsen kan avslutas.</FormNotice>}
        {needsDecision && (
          <Field label="Beslut" htmlFor="closeDecision">
            <Select id="closeDecision" value={decision} onChange={(e) => setDecision(e.target.value as "" | DeviationDecision)}>
              <option value="">— Välj —</option>
              {DEVIATION_DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {DEVIATION_DECISION_LABELS[d]}
                </option>
              ))}
            </Select>
            <FormHint>
              {deviation.type === "customer"
                ? "Godkänd betyder att vi godkänner kundens reklamation, Avslagen att vi inte gör det."
                : "Godkänd betyder att leverantören har godkänt vår reklamation, Avslagen att leverantören avvisat den."}
            </FormHint>
          </Field>
        )}
        <FormHint>Avvikelsen kan öppnas igen efteråt med Öppna igen.</FormHint>
        <FormActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" variant="primary" disabled={pending || missingAction}>
            {pending ? "Avslutar…" : "Avsluta"}
          </Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

// Makulera: a reason is required and stays on the case.
function CancelDialog({
  deviation,
  open,
  onClose,
  onDone,
}: {
  deviation: Deviation;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviation.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte makulera avvikelsen"));
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Makulera ${deviation.deviationNumber}`}>
      <Form onSubmit={submit}>
        <FormError>{error}</FormError>
        <Field label="Orsak till makuleringen" htmlFor="cancelReason">
          <Textarea id="cancelReason" rows={3} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <FormHint>Makulerade avvikelser räknas inte i rapporterna.</FormHint>
        <FormActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" variant="danger" disabled={pending || reason.trim() === ""}>
            {pending ? "Makulerar…" : "Makulera"}
          </Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

// Avvikelsekortet. The page keys it on updatedAt, so a saved change (or a
// status change) starts the form again from the server's values.
export function DeviationCard({
  deviation,
  reasons,
  responsible,
}: {
  deviation: Deviation;
  reasons: DeviationReason[];
  responsible: ResponsibleCandidate[];
}) {
  const router = useRouter();
  const can = useCan();
  const canWrite = can(["kvalitet"]);
  const canEdit = canWrite && deviation.editable;
  const pill = DEVIATION_STATUS_PILL[deviation.status];

  const [initialJson] = useState(() => JSON.stringify(draftFromDeviation(deviation)));
  const [draft, setDraft] = useState<DeviationDraft>(() => draftFromDeviation(deviation));
  const dirty = canEdit && JSON.stringify(draft) !== initialJson;
  useUnsavedGuard(dirty);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<DeviationAction | null>(null);
  const [dialog, setDialog] = useState<"close" | "cancel" | null>(null);

  function patch(next: Partial<DeviationDraft>) {
    setSaved(false);
    setDraft((prev) => ({ ...prev, ...next }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const problem = draftProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviation.id}`, { method: "PATCH", body: JSON.stringify(draftPayload(draft, "edit")) });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara avvikelsen"));
    } finally {
      setSaving(false);
    }
  }

  async function runAction(action: "start" | "reopen") {
    setError(null);
    setActionPending(action);
    try {
      await apiFetch(`/api/v1/deviations/${deviation.id}/${action}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ändra status"));
    } finally {
      setActionPending(null);
    }
  }

  function onAction(action: DeviationAction) {
    if (action === "close") setDialog("close");
    else if (action === "cancel") setDialog("cancel");
    else void runAction(action);
  }

  const actions = ACTION_ORDER.filter((a) => deviation.allowedTransitions.includes(a));

  return (
    <>
      <Card maxWidth="none" className={styles.headerCard}>
        <div className={styles.strip}>
          <StatusPill status={pill.status} label={pill.label} />
          <span className={styles.stripMeta}>
            {DEVIATION_TYPE_LABELS[deviation.type]} · registrerad {deviation.reportedDate}
            {deviation.createdByName ? ` av ${deviation.createdByName}` : ""}
          </span>
          <div className={styles.stripActions}>
            <PdfActions href={`/api/v1/deviations/${deviation.id}/pdf`} />
            {canWrite &&
              actions.map((action) => (
                <Button
                  key={action}
                  type="button"
                  size="small"
                  variant={action === "cancel" ? "danger" : action === "close" ? "primary" : "secondary"}
                  disabled={dirty || actionPending !== null}
                  onClick={() => onAction(action)}
                >
                  {actionPending === action ? "Ett ögonblick…" : DEVIATION_ACTION_LABELS[action]}
                </Button>
              ))}
          </div>
        </div>
        {dirty && canWrite && actions.length > 0 && (
          <div className={styles.notice}>Spara ändringarna innan du ändrar status.</div>
        )}
        {deviation.status === "closed" && (
          <div className={styles.notice}>
            Avslutad {formatStockholmDateTime(deviation.closedAt)}
            {deviation.closedByName ? ` av ${deviation.closedByName}` : ""}
            {deviation.decision ? ` · Beslut: ${DEVIATION_DECISION_LABELS[deviation.decision]}` : ""}. Öppna igen för att ändra.
          </div>
        )}
        {deviation.status === "cancelled" && (
          <div className={styles.notice}>
            Makulerad {formatStockholmDateTime(deviation.cancelledAt)}
            {deviation.cancelledByName ? ` av ${deviation.cancelledByName}` : ""}
            {deviation.cancelReason ? ` · Orsak: ${deviation.cancelReason}` : ""}
          </div>
        )}
        {!canEdit && error && <FormError margin="above">{error}</FormError>}
      </Card>

      {canEdit ? (
        <Card maxWidth="none">
          <Form onSubmit={save}>
            <FormError>{error}</FormError>
            <DeviationFields draft={draft} onChange={patch} reasons={reasons} responsible={responsible} mode="edit" />
            <FormActions>
              {saved && !dirty && <FormSaved>Sparat</FormSaved>}
              <Button type="submit" variant="primary" disabled={saving || !dirty}>
                {saving ? "Sparar…" : "Spara"}
              </Button>
            </FormActions>
          </Form>
        </Card>
      ) : (
        <DeviationDetails deviation={deviation} />
      )}

      {deviation.costs && <DeviationCostsSection deviationId={deviation.id} costs={deviation.costs} canEdit={canEdit} />}

      <DeviationLinksSection deviation={deviation} canEdit={canEdit} />

      <DeviationFilesSection deviationId={deviation.id} files={deviation.files} canEdit={canEdit} editable={deviation.editable} />

      <DeviationHistory events={deviation.events} />

      <CloseDialog
        deviation={deviation}
        open={dialog === "close"}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          router.refresh();
        }}
      />
      <CancelDialog
        deviation={deviation}
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          router.refresh();
        }}
      />
    </>
  );
}
