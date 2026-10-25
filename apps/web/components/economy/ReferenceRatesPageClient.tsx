"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { confirmDelete } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatRatePercent, halfYearLabel, halfYearStart, halfYearStartBefore, parsePercent } from "../../lib/lateInterest";
import type { Paged, ReferenceRateEntry, ReferenceRateFetchResult } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

const SOURCE_LABELS: Record<ReferenceRateEntry["source"], string> = {
  riksbank: "Sveriges Riksbank",
  manual: "Manuell",
};

// Riksbankens villkor: a rate fetched from them is shown with its source.
const RIKSBANK_CREDIT = "Källa: Sveriges Riksbank";

// The routine's write rule is the customer invoices' (forsaljning).
const WRITE_RULE = ["forsaljning"] as const;

// Riksbankens fetch failures are about the rate here, not an exchange rate.
function fetchErrorMessage(err: unknown): string {
  if ((err as { code?: string } | null)?.code === "riksbank-unavailable") {
    return "Riksbanken svarar inte — försök igen om en stund eller lägg in räntan själv med Lägg till.";
  }
  return apiErrorMessage(err, "Kunde inte hämta referensräntorna");
}

export function ReferenceRatesPageClient({ rates, today }: { rates: Paged<ReferenceRateEntry>; today: string }) {
  const router = useRouter();
  const can = useCan();
  const canWrite = can(WRITE_RULE);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasRiksbankRates = rates.rows.some((rate) => rate.source === "riksbank");

  async function remove(rate: ReferenceRateEntry) {
    if (!(await confirmDelete(`Ta bort den egna räntan för ${halfYearLabel(rate.validFrom)} (${formatRatePercent(rate.rate)})?`))) {
      return;
    }
    setError(null);
    try {
      await apiFetch(`/api/v1/reference-rates/${rate.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort räntan"));
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Referensränta</div>
          <div className={shellStyles.meta}>{rates.total.toLocaleString("sv-SE")} halvår</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {canWrite && (
            <>
              <Button type="button" variant="secondary" onClick={() => setFetchOpen(true)}>
                Hämta från Riksbanken
              </Button>
              <Button type="button" variant="primary" onClick={() => setNewOpen(true)}>
                Lägg till
              </Button>
            </>
          )}
          <HelpLink chapter="ekonomi" anchor="referensranta" label="Hjälp om referensränta" />
        </div>
      </div>

      {notice && <FormNotice style={{ marginBottom: 14 }}>{notice}</FormNotice>}
      <FormError margin="below">{error}</FormError>

      <Table<ReferenceRateEntry>
        columns={[
          { key: "validFrom", label: "Gäller från", width: "140px" },
          { key: "half", label: "Halvår", width: "1fr" },
          { key: "rate", label: "Räntesats", width: "120px", align: "right" },
          { key: "source", label: "Källa", width: "170px" },
          ...(canWrite ? [{ key: "actions", label: "", width: "110px", align: "right" as const }] : []),
        ]}
        rows={rates.rows}
        emptyText="Inga referensräntor — hämta dem från Riksbanken eller lägg in en själv."
        renderCell={(rate, key) => {
          switch (key) {
            case "validFrom":
              return rate.validFrom;
            case "half":
              return halfYearLabel(rate.validFrom);
            case "rate":
              return formatRatePercent(rate.rate);
            case "source":
              return SOURCE_LABELS[rate.source];
            case "actions":
              return rate.source === "manual" ? (
                <Button type="button" size="small" variant="danger" onClick={() => remove(rate)}>
                  Ta bort
                </Button>
              ) : null;
            default:
              return null;
          }
        }}
      />
      <FormHint style={{ marginTop: 10 }}>
        Dröjsmålsräntan är referensräntan för halvåret plus räntemarginalen (8 procentenheter enligt räntelagen), om
        kunden inte har en Avtalad räntesats. Räntan bestäms för varje kalenderhalvår för sig.
        {hasRiksbankRates ? ` ${RIKSBANK_CREDIT}.` : ""}
      </FormHint>

      <Modal open={fetchOpen} onClose={() => setFetchOpen(false)} title="Hämta från Riksbanken">
        <FetchForm
          today={today}
          onDone={(message) => {
            setFetchOpen(false);
            setNotice(message);
            router.refresh();
          }}
        />
      </Modal>
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Lägg till referensränta">
        <NewRateForm
          today={today}
          onDone={(message) => {
            setNewOpen(false);
            setNotice(message);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

function FetchForm({ today, onDone }: { today: string; onDone: (message: string) => void }) {
  // Förval: the latest four half years, as the API defaults to.
  const [from, setFrom] = useState(() => halfYearStartBefore(today, 3));
  const [to, setTo] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (from > to) {
      setError("Från-datumet får inte vara efter till-datumet.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<ReferenceRateFetchResult>("/api/v1/reference-rates/fetch", {
        method: "POST",
        body: JSON.stringify({ from, to }),
      });
      onDone(
        result.fetched === 0
          ? `Riksbanken har inga nya referensräntor för ${from} – ${to} — lägg in räntan själv med Lägg till om den saknas.`
          : `${result.fetched.toLocaleString("sv-SE")} ${result.fetched === 1 ? "referensränta" : "referensräntor"} hämtade (${from} – ${to}). ${RIKSBANK_CREDIT}.`
      );
    } catch (err) {
      setError(fetchErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <FormRow>
        <Field label="Från" htmlFor="refFrom">
          <Input id="refFrom" type="date" size="sm" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Till" htmlFor="refTo">
          <Input id="refTo" type="date" size="sm" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </FormRow>
      <FormHint>
        Hämtar referensräntan för varje halvår som perioden berör, som standard de senaste fyra halvåren. En ränta du
        lagt in själv för samma halvår går före Riksbankens. {RIKSBANK_CREDIT}.
      </FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Hämtar…" : "Hämta"}
        </Button>
      </FormActions>
    </Form>
  );
}

function NewRateForm({ today, onDone }: { today: string; onDone: (message: string) => void }) {
  const [year, setYear] = useState(today.slice(0, 4));
  const [half, setHalf] = useState<"1" | "2">(Number(today.slice(5, 7)) <= 6 ? "1" : "2");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const yearNumber = Number(year);
    const rateNumber = parsePercent(rate);
    if (!Number.isInteger(yearNumber) || yearNumber < 1900 || yearNumber > 2200) {
      setError("Ange ett år, till exempel 2026.");
      return;
    }
    if (rateNumber === null) {
      setError("Ange räntesatsen som ett tal, till exempel 2,00.");
      return;
    }
    const validFrom = halfYearStart(yearNumber, half === "1" ? 1 : 2);
    setError(null);
    setPending(true);
    try {
      await apiFetch<ReferenceRateEntry>("/api/v1/reference-rates", {
        method: "POST",
        body: JSON.stringify({ validFrom, rate: rateNumber }),
      });
      onDone(`Referensräntan för ${halfYearLabel(validFrom)} sparades.`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara räntan"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <FormRow>
        <Field label="År" htmlFor="newRefYear">
          <Input
            id="newRefYear"
            type="number"
            step="1"
            size="sm"
            required
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
        </Field>
        <Field label="Halvår" htmlFor="newRefHalf">
          <Select id="newRefHalf" value={half} onChange={(e) => setHalf(e.target.value as "1" | "2")}>
            <option value="1">Första halvåret (från 1 januari)</option>
            <option value="2">Andra halvåret (från 1 juli)</option>
          </Select>
        </Field>
      </FormRow>
      <Field label="Räntesats (%)" htmlFor="newRefRate">
        <Input
          id="newRefRate"
          type="number"
          step="0.01"
          size="sm"
          required
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
        <FormHint>
          Riksbankens referensränta för halvåret, utan räntemarginalen. En egen ränta går före Riksbankens för samma
          halvår och ersätter en tidigare egen.
        </FormHint>
      </Field>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}
