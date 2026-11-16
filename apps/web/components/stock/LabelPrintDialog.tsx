"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiErrorMessage } from "../../lib/errorMessages";
import { openPostedPdf } from "../../lib/openPostedPdf";

type LabelFormat = "a4" | "single";

// The chosen format is remembered per browser — the same printer stands at
// the same desk. A missing or blocked storage just means A4-ark.
const FORMAT_KEY = "nav.labelFormat";
function readStoredFormat(): LabelFormat | null {
  try {
    const value = localStorage.getItem(FORMAT_KEY);
    return value === "a4" || value === "single" ? value : null;
  } catch {
    return null;
  }
}
function storeFormat(format: LabelFormat) {
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // Not remembering is fine; the choice still holds for this dialog.
  }
}

// Etikettdialog: format, start position on the A4 sheet and copies per label.
// `endpoint` is POST /articles/labels, /stock/locations/labels or an
// inköpsorder's /receipts/labels and `idsKey` the body key that carries the
// ids. `maxIds` is the endpoint's own limit on the list (500 for articles and
// places, 2 000 for receipts — a serial receive call is one id per styck).
// The returned PDF opens in a new tab.
export function LabelPrintDialog({
  open,
  onClose,
  endpoint,
  idsKey,
  ids,
  maxIds = 500,
  title = "Skriv ut etiketter",
}: {
  open: boolean;
  onClose: () => void;
  endpoint: string;
  idsKey: "articleIds" | "locationIds" | "receiptIds";
  ids: string[];
  maxIds?: number;
  title?: string;
}) {
  const [format, setFormat] = useState<LabelFormat>("a4");
  const [start, setStart] = useState("1");
  const [copies, setCopies] = useState("1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read after mount — the server render has no storage.
  useEffect(() => {
    const stored = readStoredFormat();
    if (stored) setFormat(stored);
  }, []);

  async function print() {
    setError(null);
    const copiesNumber = Number(copies);
    const startNumber = Number(start);
    if (!Number.isInteger(copiesNumber) || copiesNumber < 1 || copiesNumber > 100) {
      setError("Antal per etikett måste vara mellan 1 och 100");
      return;
    }
    // Same limits as the label schemas in packages/shared (scan.ts).
    if (ids.length > maxIds) {
      setError(`Högst ${maxIds.toLocaleString("sv-SE")} valda per utskrift`);
      return;
    }
    if (ids.length * copiesNumber > 2000) {
      setError("Högst 2 000 etiketter per utskrift");
      return;
    }
    if (format === "a4" && (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 24)) {
      setError("Börja på etikett måste vara mellan 1 och 24");
      return;
    }
    setPending(true);
    try {
      await openPostedPdf(
        endpoint,
        { [idsKey]: ids, copies: copiesNumber, format, ...(format === "a4" && { start: startNumber }) },
        "Kunde inte skapa etiketterna"
      );
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa etiketterna"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void print();
        }}
      >
        <FormHint>
          {ids.length} {ids.length === 1 ? "etikett vald" : "etiketter valda"}
        </FormHint>
        <Field label="Format" htmlFor="labelFormat">
          <Select
            id="labelFormat"
            value={format}
            onChange={(e) => {
              const next = e.target.value as LabelFormat;
              setFormat(next);
              storeFormat(next);
            }}
          >
            <option value="a4">A4-ark (70 × 37 mm, 24 per ark)</option>
            <option value="single">Etikettskrivare (100 × 50 mm)</option>
          </Select>
        </Field>
        {format === "a4" && (
          <Field label="Börja på etikett" htmlFor="labelStart">
            <Input
              id="labelStart"
              size="xs"
              type="number"
              inputMode="numeric"
              min={1}
              max={24}
              step={1}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
        )}
        <Field label="Antal per etikett" htmlFor="labelCopies">
          <Input
            id="labelCopies"
            size="xs"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            value={copies}
            onChange={(e) => setCopies(e.target.value)}
          />
        </Field>
        <FormError>{error}</FormError>
        <FormActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" variant="primary" disabled={pending || ids.length === 0}>
            {pending ? "Skapar…" : "Skriv ut"}
          </Button>
        </FormActions>
      </Form>
    </Modal>
  );
}
