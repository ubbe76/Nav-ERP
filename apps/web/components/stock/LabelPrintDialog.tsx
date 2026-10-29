"use client";

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { API_URL } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";

type LabelFormat = "a4" | "single";

// Etikettdialog: format, start position on the A4 sheet and copies per label.
// `endpoint` is POST /articles/labels or /stock/locations/labels and `idsKey`
// the body key that carries the ids (articleIds / locationIds). The returned
// PDF opens in a new tab.
export function LabelPrintDialog({
  open,
  onClose,
  endpoint,
  idsKey,
  ids,
  title = "Skriv ut etiketter",
}: {
  open: boolean;
  onClose: () => void;
  endpoint: string;
  idsKey: "articleIds" | "locationIds";
  ids: string[];
  title?: string;
}) {
  const [format, setFormat] = useState<LabelFormat>("a4");
  const [start, setStart] = useState("1");
  const [copies, setCopies] = useState("1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function print() {
    setError(null);
    const copiesNumber = Number(copies);
    const startNumber = Number(start);
    if (!Number.isInteger(copiesNumber) || copiesNumber < 1 || copiesNumber > 100) {
      setError("Antal per etikett måste vara mellan 1 och 100");
      return;
    }
    if (format === "a4" && (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 24)) {
      setError("Börja på etikett måste vara mellan 1 och 24");
      return;
    }
    setPending(true);
    // The tab is opened inside the click so popup blockers allow it, and
    // pointed at the PDF once it has arrived.
    const tab = window.open("", "_blank");
    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [idsKey]: ids,
          copies: copiesNumber,
          format,
          ...(format === "a4" && { start: startNumber }),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error ?? "Kunde inte skapa etiketterna"), { code: body.code });
      }
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
      // Leave the URL alive long enough for the tab to load it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onClose();
    } catch (err) {
      tab?.close();
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
          <Select id="labelFormat" value={format} onChange={(e) => setFormat(e.target.value as LabelFormat)}>
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
