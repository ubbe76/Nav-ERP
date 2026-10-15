"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCan } from "../PermissionsProvider";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { ParcelsTable, newParcelDraft, toParcelPayload, type ParcelDraft } from "./ParcelsTable";
import { RatesDialog } from "./RatesDialog";
import { apiFetch } from "../../lib/api";
import {
  errorBody,
  formatDate,
  formatDateTime,
  formatSek,
  SHIPMENT_STATUS_LABELS,
  SHIPMENT_STATUS_PILL,
  shippingErrorText,
} from "../../lib/shipping";
import type { OpenDelivery, ShipmentDetail, ShipmentRates } from "../../lib/types";
import styles from "./ShipmentCard.module.css";

const toDrafts = (s: ShipmentDetail): ParcelDraft[] =>
  s.parcels.map((p) => ({
    key: p.id,
    parcelKind: p.parcelKind,
    lengthCm: String(p.lengthCm),
    widthCm: String(p.widthCm),
    heightCm: String(p.heightCm),
    weightKg: String(p.weightKg),
    quantity: String(p.quantity),
    stackable: p.stackable,
    loadingMeters: p.loadingMeters === null ? "" : String(p.loadingMeters),
    description: p.description ?? "",
  }));

// Label/value pairs for the read views (bokad/levererad/avbruten) — rows with
// an empty value are left out so the summary stays short.
function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  const shown = rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== "");
  return (
    <dl className={styles.facts}>
      {shown.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// "Postnummer Ort" as one line, skipping whichever part is missing.
const postalLine = (postalCode: string | null, city: string | null) => [postalCode, city].filter(Boolean).join(" ");

export function ShipmentCard({ initial }: { initial: ShipmentDetail }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const draft = s.status === "draft";
  const canWrite = useCan()(["forsaljning"]);
  const tracked = s.status === "booked" || s.status === "delivered";

  // Rates dialog
  const [ratesOpen, setRatesOpen] = useState(false);
  const [rates, setRates] = useState<ShipmentRates | null>(initial.rates);
  const [ratesMessage, setRatesMessage] = useState<string | null>(null);
  const [priceChange, setPriceChange] = useState<{ savedPrice: number; newPrice: number } | null>(null);

  // Parcels editor
  const [parcels, setParcels] = useState<ParcelDraft[]>(toDrafts(initial));
  const [warnings, setWarnings] = useState<string[]>([]);

  // Add följesedel
  const [openDeliveries, setOpenDeliveries] = useState<OpenDelivery[]>([]);

  useEffect(() => {
    if (!draft) return;
    apiFetch<OpenDelivery[]>(`/api/v1/shipments/open-deliveries?customerId=${s.customerId}`)
      .then(setOpenDeliveries)
      .catch(() => setOpenDeliveries([]));
  }, [draft, s.customerId, s.deliveries.length]);

  function apply(next: ShipmentDetail) {
    setS(next);
    setParcels(toDrafts(next));
    setRates(next.rates);
  }

  async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      return await fn();
    } catch (err) {
      setError(shippingErrorText(err, fallback));
      return null;
    } finally {
      setPending(false);
    }
  }

  const post = <T,>(path: string, body?: unknown) =>
    apiFetch<T>(`/api/v1/shipments/${s.id}${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const patch = (body: unknown) => apiFetch<ShipmentDetail>(`/api/v1/shipments/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });

  async function fetchRates() {
    const result = await run(() => post<ShipmentRates>("/rates"), "Kunde inte hämta priser");
    if (result) {
      setRates(result);
      setRatesMessage(null);
      setRatesOpen(true);
    }
  }

  async function afterBooking(result: { shipment: ShipmentDetail; warnings: string[] }) {
    apply(result.shipment);
    setRatesOpen(false);
    setPriceChange(null);
    setNotice(result.warnings.length > 0 ? result.warnings.join(" ") : `Bokad — fraktsedelsnr ${result.shipment.trackingNumber ?? "–"}`);
    router.refresh();
  }

  async function book(body: unknown) {
    setRatesMessage(null);
    setNotice(null);
    setPending(true);
    setError(null);
    try {
      await afterBooking(await post<{ shipment: ShipmentDetail; warnings: string[] }>("/book", body));
    } catch (err) {
      const extra = errorBody<{ code?: string; rates?: ShipmentRates; savedPrice?: number; newPrice?: number }>(err);
      if (extra?.rates) {
        setRates(extra.rates);
        setRatesOpen(true);
        setRatesMessage(shippingErrorText(err, "Priset har gått ut"));
      } else if (extra?.code === "freight-price-changed" && extra.savedPrice !== undefined && extra.newPrice !== undefined) {
        setPriceChange({ savedPrice: extra.savedPrice, newPrice: extra.newPrice });
      } else if (ratesOpen) {
        setRatesMessage(shippingErrorText(err, "Bokningen misslyckades"));
      } else {
        setPriceChange(null);
        setError(shippingErrorText(err, "Bokningen misslyckades"));
      }
    } finally {
      setPending(false);
    }
  }

  async function saveSelection(rateId: string) {
    const next = await run(() => post<ShipmentDetail>("/selection", { rateId }), "Kunde inte spara valet");
    if (next) {
      apply(next);
      setRatesOpen(false);
      setNotice("Valet sparat — boka med Boka vald produkt");
    }
  }

  async function cancel() {
    const question = s.status === "booked" ? "Avboka transporten hos Sendify?" : "Avbryta försändelsen?";
    if (!(await confirmDialog(question))) return;
    const next = await run(() => post<ShipmentDetail>("/cancel"), "Kunde inte avbryta");
    if (next) {
      apply(next);
      router.refresh();
    }
  }

  async function refreshTracking() {
    const next = await run(() => post<ShipmentDetail>("/tracking"), "Kunde inte uppdatera spårningen");
    if (next) apply(next);
  }

  async function removeDraft() {
    if (!(await confirmDelete("Ta bort utkastet?"))) return;
    const ok = await run(() => apiFetch(`/api/v1/shipments/${s.id}`, { method: "DELETE" }), "Kunde inte ta bort");
    if (ok !== null) router.push("/forsaljning/forsandelser");
  }

  async function saveParcels() {
    const next = await run(
      () =>
        apiFetch<ShipmentDetail>(`/api/v1/shipments/${s.id}/parcels`, {
          method: "PUT",
          body: JSON.stringify({
            parcels: parcels.map(toParcelPayload),
          }),
        }),
      "Kunde inte spara kollina"
    );
    if (next) {
      apply(next);
      setNotice("Kollina sparade");
    }
  }

  async function suggestAgain() {
    if (!(await confirmDialog("Ersätta kollina med ett nytt förslag?"))) return;
    const result = await run(() => post<{ shipment: ShipmentDetail; warnings: string[] }>("/parcels/suggest"), "Kunde inte föreslå kollin");
    if (result) {
      apply(result.shipment);
      setWarnings(result.warnings);
    }
  }

  async function addDelivery(deliveryId: string) {
    const result = await run(() => post<{ shipment: ShipmentDetail; warnings: string[] }>("/deliveries", { deliveryId }), "Kunde inte lägga till följesedeln");
    if (result) {
      apply(result.shipment);
      setWarnings(result.warnings);
    }
  }

  async function removeDelivery(deliveryId: string) {
    const result = await run(
      () => apiFetch<{ shipment: ShipmentDetail; warnings: string[] }>(`/api/v1/shipments/${s.id}/deliveries/${deliveryId}`, { method: "DELETE" }),
      "Kunde inte ta bort följesedeln"
    );
    if (result) {
      apply(result.shipment);
      setWarnings(result.warnings);
    }
  }

  async function saveRecipient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "");
    const next = await run(
      () =>
        patch({
          recipientName: text("recipientName"),
          recipientAddressLine1: text("recipientAddressLine1"),
          recipientAddressLine2: text("recipientAddressLine2"),
          recipientPostalCode: text("recipientPostalCode"),
          recipientCity: text("recipientCity"),
          recipientCountry: text("recipientCountry"),
          recipientContactName: text("recipientContactName"),
          recipientPhone: text("recipientPhone"),
          recipientEmail: text("recipientEmail"),
          recipientPrivatePerson: f.get("recipientPrivatePerson") === "on",
          ...(text("senderReference") !== (s.senderReference ?? "") ? { senderReference: text("senderReference") } : {}),
          receiverReference: text("receiverReference"),
        }),
      "Kunde inte spara mottagaren"
    );
    if (next) {
      apply(next);
      setNotice("Sparat");
    }
  }

  async function savePickup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const date = String(f.get("pickupDate"));
    const body =
      date !== s.pickupDate
        ? { pickupDate: date }
        : { pickupFrom: String(f.get("pickupFrom")), pickupTo: String(f.get("pickupTo")) };
    const next = await run(() => patch(body), "Kunde inte spara upphämtningen");
    if (next) apply(next);
  }

  async function saveCustomerPrice(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get("customerPrice") ?? "").trim();
    const next = await run(() => patch({ customerPrice: raw === "" ? null : raw }), "Kunde inte spara kundpriset");
    if (next) apply(next);
  }

  const senderLine = [s.senderName, s.senderAddressLine1, s.senderAddressLine2, postalLine(s.senderPostalCode, s.senderCity)]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <div className={styles.toolbar}>
        <StatusPill status={SHIPMENT_STATUS_PILL[s.status]} label={SHIPMENT_STATUS_LABELS[s.status]} />
        <GatedLink href={`/kunder/${s.customerId}`}>{s.customerName}</GatedLink>
        <span className={styles.toolbarSpacer} />
        {draft && (
          <>
            <Button type="button" variant="primary" disabled={pending || s.bookingInProgress} onClick={fetchRates}>
              Hämta priser
            </Button>
            {s.freightProduct && (
              <Button type="button" variant="secondary" disabled={pending || s.bookingInProgress} onClick={() => book({ useSelection: true })}>
                Boka vald produkt
              </Button>
            )}
            <Button type="button" variant="ghost" disabled={pending} onClick={cancel}>
              Avbryt
            </Button>
            <Button type="button" variant="danger" disabled={pending} onClick={removeDraft}>
              Ta bort utkast
            </Button>
          </>
        )}
        {s.status === "booked" && (
          <>
            <Button type="button" variant="secondary" disabled={pending} onClick={async () => {
              const next = await run(() => post<ShipmentDetail>("/documents"), "Kunde inte hämta fraktsedeln");
              if (next) apply(next);
            }}>
              Hämta fraktsedel
            </Button>
            <Button type="button" variant="danger" disabled={pending} onClick={cancel}>
              Avboka
            </Button>
          </>
        )}
      </div>
      <div className={styles.messages}>
        {s.bookingInProgress && <FormHint>Bokning pågår…</FormHint>}
        <FormError>{error}</FormError>
        {notice && <FormHint>{notice}</FormHint>}
        {s.status === "cancelled" && <FormHint>Avbruten {s.cancelledAt ? formatDateTime(s.cancelledAt) : ""}.</FormHint>}
      </div>

      <div className={styles.layout}>
        <div className={styles.column}>
          <Card maxWidth="none" className={styles.panel}>
            <SectionHeading>Mottagare</SectionHeading>
            {draft ? (
              <Form onSubmit={saveRecipient} key={`recipient-${s.id}-${JSON.stringify([s.recipientName, s.recipientAddressLine1, s.recipientAddressLine2, s.recipientPostalCode, s.recipientCity, s.recipientCountry, s.recipientContactName, s.recipientPhone, s.recipientEmail, s.recipientPrivatePerson, s.senderReference, s.receiverReference])}`}>
                <fieldset disabled={pending} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
                  <div className={styles.stack}>
                    {/* The company name is the longest text on the card — the full width is its. */}
                    <Field label="Namn" htmlFor="recipientName"><Input id="recipientName" name="recipientName" defaultValue={s.recipientName} /></Field>
                    <FormRow>
                      <Field label="Adress" htmlFor="recipientAddressLine1"><Input id="recipientAddressLine1" name="recipientAddressLine1" defaultValue={s.recipientAddressLine1 ?? ""} /></Field>
                      <Field label="Adressrad 2" htmlFor="recipientAddressLine2"><Input id="recipientAddressLine2" name="recipientAddressLine2" defaultValue={s.recipientAddressLine2 ?? ""} /></Field>
                    </FormRow>
                    <FormRow columns="postal">
                      <Field label="Postnummer" htmlFor="recipientPostalCode"><Input id="recipientPostalCode" name="recipientPostalCode" size="sm" defaultValue={s.recipientPostalCode ?? ""} /></Field>
                      <Field label="Ort" htmlFor="recipientCity"><Input id="recipientCity" name="recipientCity" defaultValue={s.recipientCity ?? ""} /></Field>
                      <Field label="Land" htmlFor="recipientCountry"><Input id="recipientCountry" name="recipientCountry" size="xs" maxLength={2} defaultValue={s.recipientCountry} /></Field>
                    </FormRow>
                    <FormRow>
                      <Field label="Kontakt" htmlFor="recipientContactName"><Input id="recipientContactName" name="recipientContactName" size="md" defaultValue={s.recipientContactName ?? ""} /></Field>
                      <Field label="Telefon" htmlFor="recipientPhone"><Input id="recipientPhone" name="recipientPhone" size="md" defaultValue={s.recipientPhone ?? ""} /></Field>
                    </FormRow>
                    <FormRow>
                      <Field label="E-post" htmlFor="recipientEmail"><Input id="recipientEmail" name="recipientEmail" type="email" defaultValue={s.recipientEmail ?? ""} /></Field>
                      <Field label="Privatperson" htmlFor="recipientPrivatePerson"><Checkbox id="recipientPrivatePerson" name="recipientPrivatePerson" defaultChecked={s.recipientPrivatePerson} /></Field>
                    </FormRow>
                    <FormRow>
                      <Field label="Avsändarens referens" htmlFor="senderReference"><Input id="senderReference" name="senderReference" size="md" defaultValue={s.senderReference ?? ""} /></Field>
                      <Field label="Mottagarens referens" htmlFor="receiverReference"><Input id="receiverReference" name="receiverReference" size="md" defaultValue={s.receiverReference ?? ""} /></Field>
                    </FormRow>
                    <FormActions>
                      <Button type="submit" variant="secondary">Spara mottagare</Button>
                    </FormActions>
                  </div>
                </fieldset>
              </Form>
            ) : (
              <Facts
                rows={[
                  { label: "Namn", value: s.recipientName },
                  {
                    label: "Adress",
                    value: (
                      <span className={styles.address}>
                        {[s.recipientAddressLine1, s.recipientAddressLine2, postalLine(s.recipientPostalCode, s.recipientCity), s.recipientCountry]
                          .filter(Boolean)
                          .join("\n")}
                      </span>
                    ),
                  },
                  { label: "Kontakt", value: s.recipientContactName },
                  { label: "Telefon", value: s.recipientPhone },
                  { label: "E-post", value: s.recipientEmail },
                  { label: "Privatperson", value: s.recipientPrivatePerson ? "Ja" : null },
                  { label: "Avsändarens referens", value: s.senderReference },
                  { label: "Mottagarens referens", value: s.receiverReference },
                ]}
              />
            )}

            <SectionHeading spaced>Avsändare</SectionHeading>
            <Facts
              rows={[
                { label: "Adress", value: senderLine || <span className={styles.muted}>–</span> },
                { label: "Kontakt", value: [s.senderContactName, s.senderPhone, s.senderEmail].filter(Boolean).join(" · ") },
              ]}
            />
            <FormHint>Ändras under System → Frakt och Företagsinformation.</FormHint>
          </Card>
        </div>

        <div className={styles.column}>
          <Card maxWidth="none" className={styles.panel}>
            <SectionHeading>Följesedlar</SectionHeading>
            <ul className={styles.deliveries}>
              {s.deliveries.map((d) => (
                <li key={d.id} className={styles.delivery}>
                  <a href={`/api/v1/deliveries/${d.id}/pdf`} target="_blank" rel="noopener noreferrer">
                    {d.deliveryNumber}
                  </a>
                  <span className={styles.muted}>·</span>
                  <GatedLink href={`/forsaljning/ordrar/${d.orderId}`}>{d.orderNumber}</GatedLink>
                  {draft && s.deliveries.length > 1 && (
                    <span className={styles.deliveryRemove}>
                      <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => removeDelivery(d.id)}>
                        Ta bort
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {draft && openDeliveries.length > 0 && (
              <div className={styles.addDelivery}>
                <Field label="Lägg till följesedel" htmlFor="addDelivery">
                  <Select id="addDelivery" value="" disabled={pending} onChange={(e) => e.target.value && addDelivery(e.target.value)}>
                    <option value="">Välj följesedel till samma kund…</option>
                    {openDeliveries.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.deliveryNumber} · {d.orderNumber}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </Card>

          <Card maxWidth="none" className={styles.panel}>
            <SectionHeading>Upphämtning</SectionHeading>
            {draft ? (
              <Form onSubmit={savePickup} key={`pickup-${s.pickupDate}-${s.pickupFrom}-${s.pickupTo}`}>
                <fieldset disabled={pending} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
                  <div className={styles.stack}>
                    <FormRow columns={3}>
                      <Field label="Datum" htmlFor="pickupDate"><Input id="pickupDate" name="pickupDate" type="date" defaultValue={s.pickupDate} /></Field>
                      <Field label="Från" htmlFor="pickupFrom"><Input id="pickupFrom" name="pickupFrom" type="time" size="sm" defaultValue={s.pickupFrom} /></Field>
                      <Field label="Till" htmlFor="pickupTo"><Input id="pickupTo" name="pickupTo" type="time" size="sm" defaultValue={s.pickupTo} /></Field>
                    </FormRow>
                    {s.pickupWarning && (
                      <p role="alert" className={styles.warning}>{s.pickupWarning}</p>
                    )}
                    <FormActions>
                      <Button type="submit" variant="secondary">Spara upphämtning</Button>
                    </FormActions>
                    <FormHint>Byts datumet hämtas den dagens upphämtningstider.</FormHint>
                  </div>
                </fieldset>
              </Form>
            ) : (
              <Facts
                rows={[
                  { label: "Datum", value: s.pickupDate },
                  { label: "Tid", value: `${s.pickupFrom}–${s.pickupTo}` },
                ]}
              />
            )}
          </Card>

          <Card maxWidth="none" className={styles.panel}>
            <SectionHeading>Frakt</SectionHeading>
            <Facts
              rows={[
                {
                  label: "Produkt",
                  value: s.freightProduct ? `${s.freightProduct.carrierName} · ${s.freightProduct.productName}` : <span className={styles.muted}>Ingen vald</span>,
                },
                {
                  label: "Sendifys pris",
                  value: s.carrierCurrency === "SEK" || s.carrierPrice === null ? formatSek(s.carrierPrice) : `${s.carrierPrice} ${s.carrierCurrency}`,
                },
                {
                  label: "Fraktsedelsnr",
                  value: s.trackingUrl ? (
                    <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer">{s.trackingNumber}</a>
                  ) : (
                    s.trackingNumber ?? "–"
                  ),
                },
                ...(tracked
                  ? [
                      {
                        label: "Faktura",
                        value: s.invoice ? (
                          <GatedLink href={`/forsaljning/fakturor/${s.invoice.invoiceId}`}>{s.invoice.invoiceNumber ?? "Utkast"}</GatedLink>
                        ) : (
                          "Ej fakturerad"
                        ),
                      },
                    ]
                  : []),
                ...s.files.map((f) => ({
                  label: f.kind === "waybill" ? "Fraktsedel" : "Etikett",
                  value: (
                    <a href={`/api/v1/shipments/${s.id}/files/${f.id}`} target="_blank" rel="noopener noreferrer">{f.filename}</a>
                  ),
                })),
              ]}
            />
            {s.status !== "cancelled" && (
              <Form onSubmit={saveCustomerPrice} key={`price-${s.customerPrice}`} className={styles.priceForm}>
                <Field label="Kundpris (kr)" htmlFor="customerPrice">
                  <Input id="customerPrice" name="customerPrice" type="number" size="sm" min="0" step="0.01" defaultValue={s.customerPrice ?? ""} disabled={pending} />
                </Field>
                <FormActions>
                  <Button type="submit" variant="secondary" disabled={pending}>Spara kundpris</Button>
                </FormActions>
                <FormHint>
                  {s.customerPriceManual ? "Ändrat för hand — töm fältet och spara för att återgå till påslaget." : "Sendifys pris plus påslag enligt System → Frakt."}
                </FormHint>
              </Form>
            )}
          </Card>
        </div>
      </div>

      <SectionHeading
        actions={
          draft ? (
            <>
              <Button type="button" variant="ghost" size="small" disabled={pending} onClick={suggestAgain}>
                Föreslå kollin igen
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="small"
                disabled={pending}
                onClick={() => setParcels([...parcels, newParcelDraft()])}
              >
                + Kolli
              </Button>
            </>
          ) : undefined
        }
      >
        Kollin
      </SectionHeading>
      {warnings.length > 0 && <FormHint>{warnings.join(" · ")}</FormHint>}
      <ParcelsTable parcels={parcels} editable={draft} disabled={pending} onChange={setParcels} />
      {draft && (
        <FormActions>
          <Button type="button" variant="secondary" disabled={pending} onClick={saveParcels}>
            Spara kollin
          </Button>
        </FormActions>
      )}

      {tracked && (
        <>
          <SectionHeading
            spaced
            actions={
              canWrite ? (
                <Button type="button" variant="secondary" size="small" disabled={pending} onClick={refreshTracking}>
                  Uppdatera spårning
                </Button>
              ) : undefined
            }
          >
            Spårning
          </SectionHeading>
          <p className={`${styles.trackingText} ${s.tracking.exception ? styles.exception : ""}`}>
            {s.tracking.text ?? "Ingen spårningsinformation ännu"}
          </p>
          <Facts
            rows={[
              { label: "Levererad", value: s.tracking.deliveredAt ? formatDate(s.tracking.deliveredAt) : null },
              { label: "Senast kontrollerad", value: formatDateTime(s.tracking.checkedAt) },
            ]}
          />
          {s.tracking.events.length > 0 && (
            <div className={styles.events}>
              <Table<ShipmentDetail["tracking"]["events"][number] & { id: string }>
                columns={[
                  { key: "occurredAt", label: "Tid", width: "170px" },
                  { key: "status", label: "Status", width: "1fr" },
                  { key: "description", label: "Beskrivning", width: "2fr" },
                  { key: "location", label: "Plats", width: "1fr" },
                ]}
                rows={s.tracking.events.map((ev, i) => ({ ...ev, id: String(i) }))}
                renderCell={(ev, key) => {
                  switch (key) {
                    case "occurredAt":
                      return formatDateTime(ev.occurredAt);
                    case "status":
                      return ev.statusLabel;
                    case "description":
                      return ev.description ?? "–";
                    case "location":
                      return ev.location ?? "–";
                    default:
                      return null;
                  }
                }}
              />
            </div>
          )}
        </>
      )}

      <RatesDialog
        open={ratesOpen}
        rates={rates}
        selectedProductKey={s.freightProduct ? `${s.freightProduct.carrierCode}|${s.freightProduct.productName}` : null}
        pending={pending}
        message={ratesMessage}
        onClose={() => setRatesOpen(false)}
        onBook={(rateId) => book({ rateId })}
        onSave={saveSelection}
      />

      <Modal open={priceChange !== null} onClose={() => setPriceChange(null)} title="Priset har ändrats">
        {priceChange && (
          <>
            <p>
              Sparat pris {formatSek(priceChange.savedPrice)}, nytt pris {formatSek(priceChange.newPrice)}.
            </p>
            <FormActions>
              <Button type="button" variant="primary" disabled={pending} onClick={() => book({ useSelection: true, confirmPriceChange: true })}>
                Boka ändå
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPriceChange(null)}>
                Avbryt
              </Button>
            </FormActions>
          </>
        )}
      </Modal>

      <p className={styles.back}>
        <Link href="/forsaljning/forsandelser">← Alla försändelser</Link>
      </p>
    </>
  );
}
