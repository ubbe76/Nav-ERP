"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";
import { CostChain, type CostChainLine } from "../ui/CostChain";
import { apiFetch } from "../../lib/api";
import type { CostingMaterialSource, CostingSupplierPriceTier, SystemSettings } from "../../lib/types";

// Fixed example amounts for the live preview, so the numbers below move only
// with the percentages the user is typing. TO is included because it is part
// of the chain even though it is set per arbetsplats, not here — it sits
// outside TVK/SVK and is added last, towards the sales price, like the
// materialpåslag.
const EXAMPLE = { material: 1000, labor: 500, overhead: 50, subcontract: 200, semiFinished: 300 };

function toPercent(raw: string): number | null {
  if (raw.trim() === "") return 0;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || value > 1000) return null;
  return value;
}

export function CostingSettingsForm({ settings }: { settings: SystemSettings }) {
  const [materialSource, setMaterialSource] = useState<CostingMaterialSource>(settings.costingMaterialSource);
  const [supplierPriceTier, setSupplierPriceTier] = useState<CostingSupplierPriceTier>(
    settings.costingSupplierPriceTier
  );
  const [mo, setMo] = useState(String(settings.costingMoPercent));
  const [lo, setLo] = useState(String(settings.costingLoPercent));
  const [affo, setAffo] = useState(String(settings.costingAffoPercent));
  const [general, setGeneral] = useState(String(settings.costingGeneralMarkupPercent));
  const [materialMarkup, setMaterialMarkup] = useState(String(settings.costingMaterialMarkupPercent));

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const percents = {
      costingMoPercent: toPercent(mo),
      costingLoPercent: toPercent(lo),
      costingAffoPercent: toPercent(affo),
      costingGeneralMarkupPercent: toPercent(general),
      costingMaterialMarkupPercent: toPercent(materialMarkup),
    };
    if (Object.values(percents).some((value) => value === null)) {
      setError("Påslagen måste vara tal mellan 0 och 1000");
      return;
    }

    setPending(true);
    try {
      await apiFetch<SystemSettings>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({
          costingMaterialSource: materialSource,
          costingSupplierPriceTier: supplierPriceTier,
          ...percents,
        }),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara kalkylinställningarna");
    } finally {
      setPending(false);
    }
  }

  // The same chain the API applies, run on the example amounts.
  const moAmount = EXAMPLE.material * ((toPercent(mo) ?? 0) / 100);
  const loAmount = EXAMPLE.subcontract * ((toPercent(lo) ?? 0) / 100);
  // The halvfabrikat step deliberately takes no markup of its own — the point
  // of the example is to show that MO does NOT grow when it does.
  const manufacturingCost =
    EXAMPLE.material +
    moAmount +
    EXAMPLE.labor +
    EXAMPLE.subcontract +
    loAmount +
    EXAMPLE.semiFinished;
  const affoAmount = manufacturingCost * ((toPercent(affo) ?? 0) / 100);
  const selfCost = manufacturingCost + affoAmount;
  const generalAmount = selfCost * ((toPercent(general) ?? 0) / 100);
  // On dM + MO, beside the general markup — not on SVK, not stacked.
  const materialMarkupAmount = (EXAMPLE.material + moAmount) * ((toPercent(materialMarkup) ?? 0) / 100);

  const lines: CostChainLine[] = [
    { label: "Direkt material (dM)", amount: EXAMPLE.material },
    { label: `MO-påslag ${toPercent(mo) ?? 0} %`, amount: moAmount, kind: "markup" },
    { label: "Direkt lön (dL)", amount: EXAMPLE.labor },
    { label: "Legokostnad", amount: EXAMPLE.subcontract },
    { label: `LO-påslag ${toPercent(lo) ?? 0} %`, amount: loAmount, kind: "markup" },
    { label: "Halvfabrikat (inget påslag)", amount: EXAMPLE.semiFinished },
    { label: "Tillverkningskostnad (TVK)", amount: manufacturingCost, kind: "subtotal" },
    { label: `Affo-påslag ${toPercent(affo) ?? 0} %`, amount: affoAmount, kind: "markup" },
    { label: "Självkostnad (SVK)", amount: selfCost, kind: "subtotal" },
    { label: `Generellt påslag ${toPercent(general) ?? 0} %`, amount: generalAmount, kind: "markup" },
    { label: `Materialpåslag ${toPercent(materialMarkup) ?? 0} % (på dM + MO)`, amount: materialMarkupAmount, kind: "markup" },
    { label: "TO-påslag (per arbetsplats)", amount: EXAMPLE.overhead, kind: "markup" },
    {
      label: "Försäljningspris",
      amount: selfCost + generalAmount + materialMarkupAmount + EXAMPLE.overhead,
      kind: "result",
    },
  ];

  return (
    <Card maxWidth={640}>
      <Form onSubmit={handleSave}>
        <FormError>{error}</FormError>

        <Field label="Materialkostnad hämtas från" htmlFor="costingMaterialSource">
          <Select
            id="costingMaterialSource"
            value={materialSource}
            onChange={(e) => setMaterialSource(e.target.value as CostingMaterialSource)}
          >
            <option value="standard">Standardpris</option>
            <option value="supplier">Aktiv leverantörs pris</option>
            <option value="actual">Verklig kostnad</option>
          </Select>
        </Field>
        <FormHint attached>
          {materialSource === "supplier" &&
            "Huvudleverantörens pris i artikelns leverantörskatalog. Saknas det används artikelns standardkostnad, och kalkylen varnar om vilka rader som föll tillbaka."}
          {materialSource === "actual" &&
            "Glidande medelpris vid förbrukningstillfället, härlett ur lagertransaktionerna. Gäller bara efterkalkylen — förkalkylen har inga förbrukningar att prissätta och använder standardpris med en varning. Material som förbrukats innan artikeln fått någon prissatt inleverans faller också tillbaka på standardpriset."}
          {materialSource === "standard" &&
            "Artikelns standardkostnad på fliken Allmänt. Leverantörspriser påverkar inte kalkylen."}
        </FormHint>

        <Field label="Leverantörspris vid staffel" htmlFor="costingSupplierPriceTier">
          <Select
            id="costingSupplierPriceTier"
            value={supplierPriceTier}
            onChange={(e) => setSupplierPriceTier(e.target.value as CostingSupplierPriceTier)}
          >
            <option value="base">Grundpris</option>
            <option value="tiered">Staffelpris för kalkylantalet</option>
          </Select>
        </Field>
        <FormHint attached>
          {supplierPriceTier === "tiered"
            ? "När huvudleverantören har staffelsteg i leverantörskatalogen används steget för komponentens totala antal i kalkylen (kalkylantal × antal per styck; i efterkalkylen det förbrukade antalet). Gäller bara när materialkostnaden hämtas från Aktiv leverantörs pris."
            : "Katalogradens Pris (priset för antal 1) används oavsett antal, även om leverantören har staffelsteg. Gäller bara när materialkostnaden hämtas från Aktiv leverantörs pris."}
        </FormHint>

        <FormRow>
          <Field label="MO-påslag (%)" htmlFor="costingMoPercent">
            <Input
              id="costingMoPercent"
              type="number"
              min={0}
              max={1000}
              step="0.1"
              size="xs"
              value={mo}
              onChange={(e) => setMo(e.target.value)}
            />
          </Field>
          <Field label="LO-påslag (%)" htmlFor="costingLoPercent">
            <Input
              id="costingLoPercent"
              type="number"
              min={0}
              max={1000}
              step="0.1"
              size="xs"
              value={lo}
              onChange={(e) => setLo(e.target.value)}
            />
          </Field>
        </FormRow>
        <FormHint attached>
          MO = materialomkostnader, läggs på det direkta materialet och ingår i självkostnaden. LO =
          legoomkostnader, läggs på legokostnaden — tjänsteartiklar i artikelns struktur räknas som lego.
        </FormHint>

        <FormRow>
          <Field label="Affo-påslag (%)" htmlFor="costingAffoPercent">
            <Input
              id="costingAffoPercent"
              type="number"
              min={0}
              max={1000}
              step="0.1"
              size="xs"
              value={affo}
              onChange={(e) => setAffo(e.target.value)}
            />
          </Field>
          <Field label="Generellt påslag (%)" htmlFor="costingGeneralMarkupPercent">
            <Input
              id="costingGeneralMarkupPercent"
              type="number"
              min={0}
              max={1000}
              step="0.1"
              size="xs"
              value={general}
              onChange={(e) => setGeneral(e.target.value)}
            />
          </Field>
        </FormRow>
        <FormHint attached>
          Affo = affärsomkostnader, läggs på tillverkningskostnaden. Det generella påslaget läggs sist på
          självkostnaden och ger försäljningspriset. TO-påslaget sätts per arbetsplats under Tillverkning → Resurser.
        </FormHint>

        <Field label="Materialpåslag (%)" htmlFor="costingMaterialMarkupPercent">
          <Input
            id="costingMaterialMarkupPercent"
            type="number"
            min={0}
            max={1000}
            step="0.1"
            size="xs"
            value={materialMarkup}
            onChange={(e) => setMaterialMarkup(e.target.value)}
          />
        </Field>
        <FormHint attached>
          Läggs på direkt material + MO och ingår bara i försäljningspriset, bredvid det generella påslaget —
          självkostnaden påverkas inte. Halvfabrikatens materialpåslag följer med upp till den färdiga artikeln.
        </FormHint>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--color-border)" }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Så räknas försäljningspriset</div>
        <FormHint>Räkneexempel med 1 000 kr material, 500 kr lön, 50 kr TO och 200 kr lego.</FormHint>
        <CostChain lines={lines} />
      </div>
    </Card>
  );
}
