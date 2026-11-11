"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { apiFetch } from "../../lib/api";

import type { ArticleGroup, ArticleNumberSeriesOption } from "../../lib/types";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { useDimensions } from "../../lib/dimensions";
import { CostCenterSelect } from "../economy/DimensionSelect";
import { apiErrorMessage } from "../../lib/errorMessages";

// Creates a varugrupp (article group), or renames one when `group` is passed.
export function NewArticleGroupForm({ group, onSuccess }: { group?: ArticleGroup; onSuccess: () => void }) {
  const [code, setCode] = useState(group?.code ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  // The VAT rate (moms) every article in the group gets.
  const [vatRate, setVatRate] = useState(String(Number(group?.vatRate ?? 25)));
  // "" = the default series.
  const [numberSeriesKey, setNumberSeriesKey] = useState(group?.numberSeriesKey ?? "");
  const dims = useDimensions();
  const [defaultCostCenterId, setDefaultCostCenterId] = useState(group?.defaultCostCenterId ?? "");
  // Prispåslag (#16): "" = inherits the company's (System → Kalkyler).
  const [generalMarkup, setGeneralMarkup] = useState(group?.generalMarkupPercent == null ? "" : String(Number(group.generalMarkupPercent)));
  const [materialMarkup, setMaterialMarkup] = useState(group?.materialMarkupPercent == null ? "" : String(Number(group.materialMarkupPercent)));
  const [companyMarkups, setCompanyMarkups] = useState<{ general: number; material: number } | null>(null);
  const [seriesOptions, setSeriesOptions] = useState<ArticleNumberSeriesOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    apiFetch<ArticleNumberSeriesOption[]>("/api/v1/article-number-series")
      .then(setSeriesOptions)
      .catch(() => setSeriesOptions([]));
    apiFetch<{ costingGeneralMarkupPercent: number; costingMaterialMarkupPercent: number }>("/api/v1/settings")
      .then((s) => setCompanyMarkups({ general: Number(s.costingGeneralMarkupPercent), material: Number(s.costingMaterialMarkupPercent) }))
      .catch(() => setCompanyMarkups(null));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const body = JSON.stringify({ code, name, description, vatRate: Number(vatRate), numberSeriesKey: numberSeriesKey === "" ? null : numberSeriesKey,
        defaultCostCenterId: defaultCostCenterId || null,
        generalMarkupPercent: generalMarkup.trim() === "" ? null : Number(generalMarkup),
        materialMarkupPercent: materialMarkup.trim() === "" ? null : Number(materialMarkup),
      });
      if (group) {
        await apiFetch(`/api/v1/article-groups/${group.id}`, { method: "PATCH", body });
      } else {
        await apiFetch("/api/v1/article-groups", { method: "POST", body });
      }
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara varugruppen"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Kod (1–4 siffror)" htmlFor="code">
        <Input
          id="code"
          required
          inputMode="numeric"
          pattern="\d{1,4}"
          maxLength={4}
          title="1–4 siffror"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </Field>

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Momssats" htmlFor="vatRate">
        <Select id="vatRate" value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
          <option value="25">25 %</option>
          <option value="12">12 %</option>
          <option value="6">6 %</option>
          <option value="0">0 %</option>
        </Select>
        <FormHint>Gäller för alla artiklar i varugruppen. Artiklar utan varugrupp får 25 %.</FormHint>
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

      <Field label="Generellt påslag (%)" htmlFor="generalMarkupPercent">
        <Input
          id="generalMarkupPercent"
          type="number"
          min="0"
          max="1000"
          step="0.01"
          size="xs"
          placeholder={companyMarkups ? `Företagets (${companyMarkups.general} %)` : "Företagets"}
          value={generalMarkup}
          onChange={(e) => setGeneralMarkup(e.target.value)}
        />
      </Field>
      <Field label="Materialpåslag (%)" htmlFor="materialMarkupPercent">
        <Input
          id="materialMarkupPercent"
          type="number"
          min="0"
          max="1000"
          step="0.01"
          size="xs"
          placeholder={companyMarkups ? `Företagets (${companyMarkups.material} %)` : "Företagets"}
          value={materialMarkup}
          onChange={(e) => setMaterialMarkup(e.target.value)}
        />
        <FormHint>
          Prispåslag för gruppens artiklar i förkalkylen. Tomt = företagets, under System → Kalkyler. 0 är 0 %. Påverkar
          försäljningspriset, inte självkostnaden.
        </FormHint>
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : group ? "Spara varugrupp" : "Skapa varugrupp"}
        </Button>
      </FormActions>
    </Form>
  );
}
