"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { confirmDelete } from "../../lib/confirm";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import {
  DEVIATION_COST_KINDS,
  DEVIATION_COST_KIND_LABELS,
  linkedDocumentHref,
  type DeviationCostKind,
  type DeviationCosts,
} from "../../lib/quality";
import styles from "./Deviations.module.css";

// One table row: a typed-in cost line, or one derived from a linked credit
// invoice / supplier credit note (shown with its document, never editable).
type CostTableRow = {
  id: string;
  kind: DeviationCostKind;
  kindLabel: string;
  text: ReactNode;
  amount: number;
  who: string;
  removeId: string | null;
};

// Kostnader: the lines, the derived ones and the net cost. Not rendered at all
// when the API hid the prices (costs === null).
export function DeviationCostsSection({
  deviationId,
  costs,
  canEdit,
}: {
  deviationId: string;
  costs: DeviationCosts;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<DeviationCostKind>("material");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const rows: CostTableRow[] = [
    ...costs.rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      kindLabel: c.kindLabel,
      text: c.description ?? "–",
      amount: c.amount,
      who: c.createdByName ?? "–",
      removeId: c.id,
    })),
    ...costs.derived.map((d) => ({
      id: `derived-${d.linkId}`,
      kind: d.kind,
      kindLabel: d.kindLabel,
      text: (
        <GatedLink href={linkedDocumentHref(d.documentType, d.documentId)} className={styles.photoLink}>
          {d.label}
        </GatedLink>
      ),
      amount: d.amount,
      who: "Härledd",
      removeId: null,
    })),
  ];

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviationId}/costs`, {
        method: "POST",
        body: JSON.stringify({ kind, description: description.trim() || undefined, amount: Number(amount) }),
      });
      setDescription("");
      setAmount("");
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till kostnaden"));
    } finally {
      setPending(false);
    }
  }

  async function remove(row: CostTableRow) {
    if (!row.removeId) return;
    if (!(await confirmDelete(`Ta bort kostnadsraden ${row.kindLabel.toLowerCase()} ${formatMoney(row.amount)} kr?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/deviations/${deviationId}/costs/${row.removeId}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort kostnaden"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.section}>
      <SectionHeading>Kostnader</SectionHeading>
      <FormHint>
        Kostnaderna är underlag för uppföljning — avvikelsen bokför ingenting. Material, Arbete, Frakt, Kreditering och
        Övrigt är kostnader, Ersättning (till exempel leverantörens kreditering) minskar nettokostnaden.
      </FormHint>
      <FormError>{error}</FormError>

      <Table<CostTableRow>
        columns={[
          { key: "kindLabel", label: "Typ", width: "130px" },
          { key: "text", label: "Beskrivning", width: "minmax(160px, 1fr)" },
          { key: "amount", label: "Belopp (SEK)", width: "130px", align: "right" },
          { key: "who", label: "Av", width: "130px" },
          ...(canEdit ? [{ key: "id", label: "", width: "100px", align: "right" as const }] : []),
        ]}
        rows={rows}
        emptyText="Inga kostnader registrerade"
        renderCell={(row, key) => {
          switch (key) {
            case "kindLabel":
              return row.kindLabel;
            case "text":
              return row.text;
            case "amount":
              return <span className="num">{row.kind === "recovery" ? `−${formatMoney(row.amount)}` : formatMoney(row.amount)}</span>;
            case "who":
              return row.who;
            case "id":
              return row.removeId ? (
                <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => remove(row)}>
                  Ta bort
                </Button>
              ) : null;
            default:
              return null;
          }
        }}
      />

      <div className={styles.totals}>
        <span>
          Kostnader <strong className="num">{formatMoney(costs.totalCosts)}</strong>
        </span>
        <span>
          Ersättningar <strong className="num">{formatMoney(costs.totalRecovery)}</strong>
        </span>
        <span>
          Nettokostnad <strong className="num">{formatMoney(costs.netCost)} kr</strong>
        </span>
      </div>

      {canEdit && (
        <form className={styles.inlineForm} onSubmit={add}>
          <Field label="Typ" htmlFor="costKind">
            <Select id="costKind" value={kind} onChange={(e) => setKind(e.target.value as DeviationCostKind)}>
              {DEVIATION_COST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DEVIATION_COST_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Beskrivning (valfritt)" htmlFor="costDescription">
            <Input id="costDescription" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Belopp (SEK)" htmlFor="costAmount">
            <Input
              id="costAmount"
              type="number"
              min="0"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={pending || !(Number(amount) > 0)}>
            Lägg till
          </Button>
        </form>
      )}
    </div>
  );
}
