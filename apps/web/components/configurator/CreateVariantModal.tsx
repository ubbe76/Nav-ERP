"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ConfiguratorSelection, VariantPreviewRow } from "../../lib/configurator";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { parseDecimal } from "./parseDecimal";
import { VariantPreviewTable } from "./VariantPreviewTable";

interface Props {
  open: boolean;
  articleId: string;
  /** The test panel's selection when the dialog was opened. */
  selection: ConfiguratorSelection;
  defaultQuantity: number;
  onClose: () => void;
  openKey: number;
}

// One combination from Testa konfiguration.
export function CreateVariantModal(props: Props) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="Skapa variant" wide>
      {props.open && <CreateVariantForm key={props.openKey} {...props} />}
    </Modal>
  );
}

function CreateVariantForm({ articleId, selection, defaultQuantity, onClose }: Props) {
  const router = useRouter();
  const base = `/api/v1/articles/${articleId}/configurator/variants`;
  const [quantityRaw, setQuantityRaw] = useState(String(defaultQuantity));
  const [row, setRow] = useState<VariantPreviewRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const quantity = parseDecimal(quantityRaw);

  function body(q: number) {
    const sets: Record<string, unknown[]> = {};
    for (const [code, value] of Object.entries(selection)) {
      if (value !== undefined) sets[code] = [value]; // null = deliberately empty
    }
    return JSON.stringify({ sets, calcQuantity: q });
  }

  // A newer request wins; the opening preview and every quantity change go here.
  useEffect(() => {
    if (quantity === null || quantity <= 0) {
      // Drop the stale row (and its Skapa button) and any request in flight.
      seq.current++;
      setRow(null);
      setPending(false);
      setError("Ange ett kalkylantal större än 0");
      return;
    }
    const mine = ++seq.current;
    setPending(true);
    const timer = setTimeout(() => {
      apiFetch<VariantPreviewRow[]>(`${base}/preview`, { method: "POST", body: body(quantity) })
        .then((rows) => {
          if (mine !== seq.current) return;
          setRow(rows[0] ?? null);
          setError(null);
          setPending(false);
        })
        .catch((err) => {
          if (mine !== seq.current) return;
          setRow(null);
          setError(apiErrorMessage(err, "Kunde inte räkna ut varianten"));
          setPending(false);
        });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantity, base]);

  async function create() {
    if (quantity === null || quantity <= 0) return;
    seq.current++;
    setError(null);
    setPending(true);
    try {
      const rows = await apiFetch<VariantPreviewRow[]>(base, { method: "POST", body: body(quantity) });
      setRow(rows[0] ?? null);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa varianten"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={(e) => e.preventDefault()}>
      <Field label="Kalkylantal" htmlFor="cfg-variant-quantity">
        <Input
          id="cfg-variant-quantity"
          type="number"
          min="0"
          step="any"
          value={quantityRaw}
          disabled={row?.status === "created"}
          onChange={(e) => setQuantityRaw(e.target.value)}
        />
      </Field>
      <FormError>{error}</FormError>
      {row && <VariantPreviewTable rows={[row]} />}
      <FormActions>
        {row?.status === "new" && (
          <Button type="button" disabled={pending} onClick={() => void create()}>
            Skapa
          </Button>
        )}
        {row?.status === "exists" && row.articleId && (
          <Button type="button" onClick={() => router.push(`/artiklar/${row.articleId}`)}>
            Öppna {row.articleNumber}
          </Button>
        )}
        {row?.status === "created" && row.articleId && (
          <Button type="button" onClick={() => router.push(`/artiklar/${row.articleId}`)}>
            Öppna {row.articleNumber}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          Stäng
        </Button>
      </FormActions>
    </Form>
  );
}
