"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { apiFetch } from "../../lib/api";

import type { ArticleGroup, ArticleNumberSeriesOption } from "../../lib/types";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { useDimensions } from "../../lib/dimensions";
import { CostCenterSelect } from "../economy/DimensionSelect";

// Creates an article group, or renames one when `group` is passed.
export function NewArticleGroupForm({ group, onSuccess }: { group?: ArticleGroup; onSuccess: () => void }) {
  const [code, setCode] = useState(group?.code ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  // "" = the default series.
  const [numberSeriesKey, setNumberSeriesKey] = useState(group?.numberSeriesKey ?? "");
  const dims = useDimensions();
  const [defaultCostCenterId, setDefaultCostCenterId] = useState(group?.defaultCostCenterId ?? "");
  const [seriesOptions, setSeriesOptions] = useState<ArticleNumberSeriesOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    apiFetch<ArticleNumberSeriesOption[]>("/api/v1/article-number-series")
      .then(setSeriesOptions)
      .catch(() => setSeriesOptions([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const body = JSON.stringify({ code, name, description, numberSeriesKey: numberSeriesKey === "" ? null : numberSeriesKey,
        defaultCostCenterId: defaultCostCenterId || null,
      });
      if (group) {
        await apiFetch(`/api/v1/article-groups/${group.id}`, { method: "PATCH", body });
      } else {
        await apiFetch("/api/v1/article-groups", { method: "POST", body });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa artikelgruppen");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Kod (3–4 siffror)" htmlFor="code">
        <Input
          id="code"
          required
          inputMode="numeric"
          pattern="\d{3,4}"
          maxLength={4}
          title="3–4 siffror"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </Field>

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Beskrivning" htmlFor="description">
        <Textarea
          id="description"
          rows={3}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field label="Nummerserie" htmlFor="numberSeriesKey">
        <Select id="numberSeriesKey" value={numberSeriesKey} onChange={(e) => setNumberSeriesKey(e.target.value)}>
          <option value="">Artikelnummer (standard)</option>
          {seriesOptions
            .filter((o) => !o.isDefault)
            .map((o) => (
              <option key={o.key} value={o.key}>
                {o.name ?? o.key}
              </option>
            ))}
        </Select>
      </Field>

      {(dims.allCostCenters.length > 0 || defaultCostCenterId !== "") && (
        <Field label="Kostnadsställe (förval)" htmlFor="defaultCostCenterId">
          <CostCenterSelect id="defaultCostCenterId" all={dims.allCostCenters} value={defaultCostCenterId} onChange={setDefaultCostCenterId} />
          <FormHint>Sätts på faktura- och leverantörsfakturarader för gruppens artiklar när inget annat kostnadsställe anges.</FormHint>
        </Field>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : group ? "Spara grupp" : "Skapa artikelgrupp"}
        </Button>
      </FormActions>
    </Form>
  );
}
