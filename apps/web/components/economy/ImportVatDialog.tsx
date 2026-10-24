"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormLineRow, FormRow } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { stockholmToday } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { VAT_CODE_CATALOG, computedVatAmount, type VatCodeSlot, type VatCodeView } from "../../lib/vatCodes";
import styles from "./Momsrapport.module.css";

type RowDraft = { key: number; vatCodeId: string; taxBase: string };

type PreviewLine = { id: string; account: string; debit: number; credit: number };

function slotAccount(code: VatCodeView, slot: VatCodeSlot): { number: string; label: string } | null {
  const account = code.accounts.find((candidate) => candidate.slot === slot);
  if (!account) return null;
  return {
    number: account.accountNumber,
    label: account.accountName ? `${account.accountNumber} · ${account.accountName}` : `${account.accountNumber} · Konto saknas`,
  };
}

// The kontering the API books for the rows: per row debet base account /
// kredit its counter account with the tax base, debet ingående moms / kredit
// utgående moms with round2(underlag × sats) — the same arithmetic as the
// poster (computedVatAmount). Summed per account and side, first-seen order.
function previewLines(rows: { code: VatCodeView; taxBase: number }[]): PreviewLine[] {
  const lines = new Map<string, PreviewLine>();
  const add = (account: { number: string; label: string } | null, side: "debit" | "credit", amount: number) => {
    if (!account || amount === 0) return;
    const line = lines.get(account.number) ?? { id: account.number, account: account.label, debit: 0, credit: 0 };
    line[side] = round2(line[side] + amount);
    lines.set(account.number, line);
  };
  for (const { code, taxBase } of rows) {
    const vat = computedVatAmount(taxBase, code.rate);
    add(slotAccount(code, "base"), "debit", taxBase);
    add(slotAccount(code, "baseCounter"), "credit", taxBase);
    add(slotAccount(code, "inputVat"), "debit", vat);
    add(slotAccount(code, "outputVat"), "credit", vat);
  }
  return [...lines.values()];
}

// Importmoms: the customs decision (tullbeslutet) booked as its own event —
// the tax base is tullvärde + tull + frakt till gränsen, never the supplier's
// invoice. One IM verification; afterwards the user lands on it to upload the
// tullbeslut as underlag.
export function ImportVatDialog({
  open,
  onClose,
  vatCodes,
}: {
  open: boolean;
  onClose: () => void;
  vatCodes: VatCodeView[];
}) {
  return (
    <Modal open={open} onClose={onClose} title="Bokför importmoms">
      <ImportVatForm vatCodes={vatCodes} onClose={onClose} />
    </Modal>
  );
}

function ImportVatForm({ vatCodes, onClose }: { vatCodes: VatCodeView[]; onClose: () => void }) {
  const router = useRouter();
  // The active import codes in catalog order (IMP25, IMP12, IMP6).
  const importCodes = useMemo(
    () =>
      VAT_CODE_CATALOG.flatMap((entry) => {
        const code = vatCodes.find((candidate) => candidate.code === entry.code);
        return code && code.kind === "import" && code.active ? [code] : [];
      }),
    [vatCodes]
  );

  const [date, setDate] = useState(stockholmToday());
  const [description, setDescription] = useState("");
  const [nextKey, setNextKey] = useState(2);
  const [rows, setRows] = useState<RowDraft[]>([{ key: 1, vatCodeId: importCodes[0]?.id ?? "", taxBase: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const parsed = rows.map((row) => ({
    code: importCodes.find((code) => code.id === row.vatCodeId) ?? null,
    // To the öre, like the poster (computedVatAmount works on round2 amounts):
    // the preview shows what is booked, and 1 000,005 is not > 0 once rounded.
    taxBase: round2(Number(row.taxBase.replace(",", "."))),
    raw: row.taxBase.trim(),
  }));
  const complete = parsed.flatMap((row) =>
    row.code && row.raw !== "" && Number.isFinite(row.taxBase) && row.taxBase > 0
      ? [{ code: row.code, taxBase: row.taxBase }]
      : []
  );
  const lines = previewLines(complete);
  const totalDebit = round2(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = round2(lines.reduce((sum, line) => sum + line.credit, 0));

  function update(key: number, patch: Partial<RowDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (description.trim() === "") {
      setError("Ange en beskrivning");
      return;
    }
    if (complete.length !== rows.length) {
      setError("Varje rad behöver en momssats och ett beskattningsunderlag större än 0");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<{ verification: { id: string; displayNumber: string } }>("/api/v1/import-vat", {
        method: "POST",
        body: JSON.stringify({
          date,
          description: description.trim(),
          rows: complete.map((row) => ({ vatCodeId: row.code.id, taxBase: row.taxBase })),
        }),
      });
      onClose();
      // To the new verification: the tullbeslut is uploaded there as underlag.
      router.push(`/ekonomi/verifikat/${result.verification.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte bokföra importmomsen"));
      setPending(false);
    }
  }

  if (importCodes.length === 0) {
    return (
      <Form onSubmit={(event) => event.preventDefault()}>
        <FormError>
          Det finns ingen aktiv importmomskod. Aktivera Importmoms 25, 12 eller 6 % under{" "}
          <GatedLink href="/ekonomi/momskoder">Momskoder</GatedLink>.
        </FormError>
        <FormActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Stäng
          </Button>
        </FormActions>
      </Form>
    );
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <FormHint>
        Importmomsen bokförs på tullbeslutet, inte på leverantörens faktura. Beskattningsunderlaget är tullvärde + tull +
        frakt till gränsen enligt tullbeslutet. Efter bokföringen kommer du till verifikatet, där du laddar upp
        tullbeslutet som underlag.
      </FormHint>

      <FormRow columns={2}>
        <Field label="Datum" htmlFor="importVatDate">
          <Input id="importVatDate" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Beskrivning" htmlFor="importVatDescription">
          <Input
            id="importVatDescription"
            required
            maxLength={255}
            value={description}
            placeholder="T.ex. Tullbeslut 2026-10-01"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </FormRow>

      {rows.map((row, index) => (
        <FormLineRow key={row.key}>
          <FormRow columns={2}>
            <Field label="Momssats" htmlFor={`importVatCode-${row.key}`}>
              <Select
                id={`importVatCode-${row.key}`}
                value={row.vatCodeId}
                onChange={(e) => update(row.key, { vatCodeId: e.target.value })}
              >
                {importCodes.map((code) => (
                  <option key={code.id} value={code.id}>
                    {code.rate} % ({code.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Beskattningsunderlag" htmlFor={`importVatBase-${row.key}`}>
              <Input
                id={`importVatBase-${row.key}`}
                type="number"
                min="0"
                step="any"
                required
                value={row.taxBase}
                onChange={(e) => update(row.key, { taxBase: e.target.value })}
              />
            </Field>
          </FormRow>
          {rows.length > 1 && (
            <div className={styles.rowActions}>
              <Button
                type="button"
                size="small"
                variant="ghost"
                aria-label={`Ta bort rad ${index + 1}`}
                onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))}
              >
                Ta bort rad
              </Button>
            </div>
          )}
        </FormLineRow>
      ))}
      {rows.length < 20 && (
        <div className={styles.rowActions}>
          <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={() => {
              setRows((current) => [...current, { key: nextKey, vatCodeId: importCodes[0]!.id, taxBase: "" }]);
              setNextKey((key) => key + 1);
            }}
          >
            + Lägg till rad
          </Button>
        </div>
      )}

      {lines.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>Kontering</div>
          <Table<PreviewLine>
            columns={[
              { key: "account", label: "Konto", width: "1.6fr" },
              { key: "debit", label: "Debet", width: "110px", align: "right" },
              { key: "credit", label: "Kredit", width: "110px", align: "right" },
            ]}
            rows={lines}
            footer={{
              account: <strong>Summa</strong>,
              debit: <span className="num">{formatMoney(totalDebit)}</span>,
              credit: <span className="num">{formatMoney(totalCredit)}</span>,
            }}
            renderCell={(line, key) => {
              switch (key) {
                case "account":
                  return line.account;
                case "debit":
                  return <span className="num">{line.debit === 0 ? "" : formatMoney(line.debit)}</span>;
                case "credit":
                  return <span className="num">{line.credit === 0 ? "" : formatMoney(line.credit)}</span>;
                default:
                  return null;
              }
            }}
          />
          <FormHint>
            Kontona kommer från momskoderna — ändra dem under <GatedLink href="/ekonomi/momskoder">Momskoder</GatedLink>.
            Verifikatet bokförs i serie IM.
          </FormHint>
        </>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Bokför…" : "Bokför importmoms"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
