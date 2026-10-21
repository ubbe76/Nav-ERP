"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { Select } from "../ui/Field";
import type { DeliveryDayMode, SystemSettings } from "../../lib/types";
import styles from "./SettingsForm.module.css";

export function SettingsForm({ settings }: { settings: SystemSettings }) {
  const [allowMultipleStamps, setAllowMultipleStamps] = useState(settings.allowMultipleStamps);
  const [showRevisionsOnDocuments, setShowRevisionsOnDocuments] = useState(settings.showRevisionsOnDocuments);
  const [showOrderRevisionOnDocuments, setShowOrderRevisionOnDocuments] = useState(
    settings.showOrderRevisionOnDocuments
  );
  const [atfMinutesPerWeek, setAtfMinutesPerWeek] = useState(String(settings.atfMinutesPerWeek));
  const [atfSaved, setAtfSaved] = useState(false);
  // "" = ingen gräns (null on the API).
  const [overReceiptPercent, setOverReceiptPercent] = useState(formatPercent(settings.purchaseOverReceiptPercent));
  const [overReceiptSaved, setOverReceiptSaved] = useState(false);
  const [materialShortage, setMaterialShortage] = useState(settings.manufacturingMaterialShortage);
  const [palletMismatch, setPalletMismatch] = useState(settings.palletCardAllowQuantityMismatch);
  const [palletCardCode, setPalletCardCode] = useState(settings.palletCardCode);
  const [longOperationWeeks, setLongOperationWeeks] = useState(String(settings.planningLongOperationWeeks));
  const [longOperationSaved, setLongOperationSaved] = useState(false);
  const [quoteValidityDays, setQuoteValidityDays] = useState(String(settings.quoteValidityDays));
  const [quoteValiditySaved, setQuoteValiditySaved] = useState(false);
  const [supplierMode, setSupplierMode] = useState(settings.supplierDeliveryDayMode);
  const [supplierTransit, setSupplierTransit] = useState(String(settings.supplierTransitDays));
  const [customerMode, setCustomerMode] = useState(settings.customerDeliveryDayMode);
  const [customerTransit, setCustomerTransit] = useState(String(settings.customerTransitDays));
  // The last saved transit days, so a blur without a change saves nothing.
  const [savedTransit, setSavedTransit] = useState({
    supplier: settings.supplierTransitDays,
    customer: settings.customerTransitDays,
  });
  const [transitSaved, setTransitSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(body: Partial<SystemSettings>) {
    setError(null);
    setPending(true);
    try {
      return await apiFetch<SystemSettings>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara inställningen");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function toggle() {
    const updated = await save({ allowMultipleStamps: !allowMultipleStamps });
    if (updated) setAllowMultipleStamps(updated.allowMultipleStamps);
  }

  async function toggleShowRevisions() {
    const updated = await save({ showRevisionsOnDocuments: !showRevisionsOnDocuments });
    if (updated) setShowRevisionsOnDocuments(updated.showRevisionsOnDocuments);
  }

  async function toggleShowOrderRevision() {
    const updated = await save({ showOrderRevisionOnDocuments: !showOrderRevisionOnDocuments });
    if (updated) setShowOrderRevisionOnDocuments(updated.showOrderRevisionOnDocuments);
  }

  async function saveAtf() {
    setAtfSaved(false);
    const minutes = Number(atfMinutesPerWeek);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) {
      setError("ATF-intjäningen måste vara ett heltal 0–600 minuter");
      return;
    }
    const updated = await save({ atfMinutesPerWeek: minutes });
    if (updated) {
      setAtfMinutesPerWeek(String(updated.atfMinutesPerWeek));
      setAtfSaved(true);
    }
  }

  // badInput: Firefox lets letters into a number field and then reports the
  // value as "" — which here would silently mean "no limit".
  async function saveOverReceipt(badInput: boolean) {
    setOverReceiptSaved(false);
    const trimmed = overReceiptPercent.trim().replace(",", ".");
    const percent = trimmed === "" ? null : Number(trimmed);
    if (badInput || (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 1000))) {
      setError("Tillåten överleverans måste vara 0–1000 % eller tomt för ingen gräns");
      return;
    }
    const updated = await save({ purchaseOverReceiptPercent: percent });
    if (updated) {
      setOverReceiptPercent(formatPercent(updated.purchaseOverReceiptPercent));
      setOverReceiptSaved(true);
    }
  }

  async function changeMaterialShortage(next: SystemSettings["manufacturingMaterialShortage"]) {
    const updated = await save({ manufacturingMaterialShortage: next });
    if (updated) setMaterialShortage(updated.manufacturingMaterialShortage);
  }

  async function togglePalletMismatch() {
    const updated = await save({ palletCardAllowQuantityMismatch: !palletMismatch });
    if (updated) setPalletMismatch(updated.palletCardAllowQuantityMismatch);
  }

  async function changePalletCardCode(next: SystemSettings["palletCardCode"]) {
    const updated = await save({ palletCardCode: next });
    if (updated) setPalletCardCode(updated.palletCardCode);
  }

  async function saveLongOperationWeeks(badInput: boolean) {
    setLongOperationSaved(false);
    const trimmed = longOperationWeeks.trim().replace(",", ".");
    const weeks = trimmed === "" ? NaN : Number(trimmed);
    if (badInput || !Number.isFinite(weeks) || weeks < 0 || weeks > 104) {
      setError("Orimligt mycket tid måste vara 0–104 veckor (0 = ingen varning)");
      return;
    }
    const updated = await save({ planningLongOperationWeeks: weeks });
    if (updated) {
      setLongOperationWeeks(String(updated.planningLongOperationWeeks));
      setLongOperationSaved(true);
    }
  }

  async function saveQuoteValidityDays(badInput: boolean) {
    setQuoteValiditySaved(false);
    const value = quoteValidityDays.trim() === "" ? NaN : Number(quoteValidityDays);
    if (badInput || !Number.isInteger(value) || value < 0 || value > 365) {
      setError("Offertens giltighetstid måste vara ett heltal 0–365 dagar (0 = ingen giltighetstid)");
      return;
    }
    const updated = await save({ quoteValidityDays: value });
    if (updated) {
      setQuoteValidityDays(String(updated.quoteValidityDays));
      setQuoteValiditySaved(true);
    }
  }

  async function changeDeliveryDayMode(side: "supplier" | "customer", next: DeliveryDayMode) {
    const updated = await save(
      side === "supplier" ? { supplierDeliveryDayMode: next } : { customerDeliveryDayMode: next }
    );
    if (!updated) return;
    if (side === "supplier") setSupplierMode(updated.supplierDeliveryDayMode);
    else setCustomerMode(updated.customerDeliveryDayMode);
  }

  async function saveTransit(side: "supplier" | "customer") {
    setTransitSaved(false);
    const text = side === "supplier" ? supplierTransit : customerTransit;
    const days = text.trim() === "" ? NaN : Number(text);
    if (!Number.isInteger(days) || days < 0 || days > 60) {
      setError("Transportdagar måste vara ett heltal 0–60");
      return;
    }
    if (days === savedTransit[side]) return;
    const updated = await save(side === "supplier" ? { supplierTransitDays: days } : { customerTransitDays: days });
    if (!updated) return;
    if (side === "supplier") setSupplierTransit(String(updated.supplierTransitDays));
    else setCustomerTransit(String(updated.customerTransitDays));
    setSavedTransit({ supplier: updated.supplierTransitDays, customer: updated.customerTransitDays });
    setTransitSaved(true);
  }

  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Tillåt flera samtidiga stämplingar</div>
          <div className={styles.description}>
            Av: hemvyn i stämpelterminalen erbjuder inte att stämpla in på ännu ett arbete så länge en stämpling
            redan är öppen — stämpla ut den först. På: knappen erbjuds ändå. Gäller bara det här valet i hemvyn —
            markerar man flera operationer och trycker Starta valda i operationsväljaren blir man ändå instämplad
            på alla samtidigt, oavsett detta läge.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowMultipleStamps}
          aria-label="Tillåt flera samtidiga stämplingar"
          className={styles.switch}
          data-on={allowMultipleStamps}
          disabled={pending}
          onClick={toggle}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Visa revisioner på dokument</div>
          <div className={styles.description}>
            På: aktiv artikelrevision och ritningsnummer med aktiv ritningsrevision skrivs ut per orderrad på
            offert, orderbekräftelse, inköpsorder och förfrågan. Revisionerna hanteras på artikelkortets flik
            Revisioner.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={showRevisionsOnDocuments}
          aria-label="Visa revisioner på dokument"
          className={styles.switch}
          data-on={showRevisionsOnDocuments}
          disabled={pending}
          onClick={toggleShowRevisions}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Visa orderns revision på dokument</div>
          <div className={styles.description}>
            På: orderns revision skrivs ut efter ordernumret (t.ex. IO2500123 / 2) på offert, orderbekräftelse och
            inköpsorder.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={showOrderRevisionOnDocuments}
          aria-label="Visa orderns revision på dokument"
          className={styles.switch}
          data-on={showOrderRevisionOnDocuments}
          disabled={pending}
          onClick={toggleShowOrderRevision}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>ATF-intjäning (minuter per vecka)</div>
          <div className={styles.description}>
            Arbetstidsförkortning som tjänas in per fullgjord arbetsvecka, t.ex. 82. 0 = ATF används inte. Kan
            avvikas per anställd på personalkortet.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min={0}
            max={600}
            aria-label="ATF-intjäning (minuter per vecka)"
            className={styles.numberInput}
            value={atfMinutesPerWeek}
            disabled={pending}
            onChange={(e) => {
              setAtfSaved(false);
              setAtfMinutesPerWeek(e.target.value);
            }}
            onBlur={saveAtf}
          />
          {atfSaved && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Tillåten överleverans på inköpsorder (%)</div>
          <div className={styles.description}>
            Hur mycket mer än beställt antal som får tas emot på en inköpsorderrad, i procent av radens beställda
            antal. 0 = aldrig mer än beställt. Tomt fält = ingen gräns.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min="0"
            max={1000}
            step="any"
            placeholder="Ingen gräns"
            aria-label="Tillåten överleverans på inköpsorder (%)"
            className={styles.numberInput}
            style={{ width: 120 }}
            value={overReceiptPercent}
            disabled={pending}
            onChange={(e) => {
              setOverReceiptSaved(false);
              setOverReceiptPercent(e.target.value);
            }}
            onBlur={(e) => saveOverReceipt(e.currentTarget.validity.badInput)}
          />
          {overReceiptSaved && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Materialbrist vid rapportering</div>
          <div className={styles.description}>
            Vad som händer när en rapportering drar mer ingående material än vad som finns. Ingen kontroll: ingen
            kontroll görs. Varning: du får frågan Rapportera ändå? innan något sparas. Spärr: rapporteringen
            nekas. Tillgängligt = artikelns totala saldo på alla lagerplatser. Gäller utstämpling, Slutför
            operation, Slutför order, Förbruka och inleverans på legorader.
          </div>
        </div>
        {/* Fixed width: in the flex row the long description would otherwise
            squeeze the select until the chosen value no longer shows. */}
        <div style={{ flexShrink: 0, width: 160 }}>
          <Select
            aria-label="Materialbrist vid rapportering"
            value={materialShortage}
            disabled={pending}
            onChange={(e) => changeMaterialShortage(e.target.value as SystemSettings["manufacturingMaterialShortage"])}
          >
            <option value="none">Ingen kontroll</option>
            <option value="warn">Varning</option>
            <option value="block">Spärr</option>
          </Select>
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Kod på pallkort</div>
          <div className={styles.description}>
            Om pallkortet får en streckkod eller QR-kod för artikelnumret och ordernumret. Gäller interna kort och
            kunder som inte har ett eget val på kundkortet.
          </div>
        </div>
        <div style={{ flexShrink: 0, width: 160 }}>
          <Select
            aria-label="Kod på pallkort"
            value={palletCardCode}
            disabled={pending}
            onChange={(e) => changePalletCardCode(e.target.value as SystemSettings["palletCardCode"])}
          >
            <option value="none">Ingen</option>
            <option value="barcode">Streckkod</option>
            <option value="qr">QR-kod</option>
          </Select>
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal</div>
          <div className={styles.description}>
            Av: Skriv ut i dialogen Pallkort är avstängd så länge kollina inte summerar till totalt antal. På: du
            varnas men kan skriva ut ändå.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={palletMismatch}
          aria-label="Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal"
          className={styles.switch}
          data-on={palletMismatch}
          disabled={pending}
          onClick={togglePalletMismatch}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Orimligt mycket tid på en operation (veckor)</div>
          <div className={styles.description}>
            Planera, Flytta och en ny tillverkningsorder varnar när en operations återstående tid ensam skulle
            fylla resursen i fler vanliga veckor än så — oftast tider i fel enhet eller ett felskrivet antal.
            Operationen planeras ändå. 0 = ingen varning.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min="0"
            max={104}
            step="any"
            aria-label="Orimligt mycket tid på en operation (veckor)"
            className={styles.numberInput}
            value={longOperationWeeks}
            disabled={pending}
            onChange={(e) => {
              setLongOperationSaved(false);
              setLongOperationWeeks(e.target.value);
            }}
            onBlur={(e) => saveLongOperationWeeks(e.currentTarget.validity.badInput)}
          />
          {longOperationSaved && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Offertens giltighetstid (dagar)</div>
          <div className={styles.description}>
            Ny offert får Giltig t.o.m. = i dag plus så här många dagar, och datumet skrivs ut på offerten. Kan
            ändras per offert. 0 = ingen giltighetstid.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min="0"
            max={365}
            step="1"
            aria-label="Offertens giltighetstid (dagar)"
            className={styles.numberInput}
            value={quoteValidityDays}
            disabled={pending}
            onChange={(e) => {
              setQuoteValiditySaved(false);
              setQuoteValidityDays(e.target.value);
            }}
            onBlur={(e) => saveQuoteValidityDays(e.currentTarget.validity.badInput)}
          />
          {quoteValiditySaved && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.section}>
        <div className={styles.texts}>
          <div className={styles.label}>Leveransdagar</div>
          <div className={styles.description}>
            Transportdagar räknas i arbetsdagar. Gäller leverantörer och kunder som inte har en egen inställning.
          </div>
        </div>
        <div className={styles.sideRow}>
          <div className={styles.sideLabel}>Leverantörer — Dagarna avser</div>
          <div className={styles.sideControls}>
            <div className={styles.modeSelect}>
              <Select
                aria-label="Leverantörer — Dagarna avser"
                value={supplierMode}
                onChange={(e) => changeDeliveryDayMode("supplier", e.target.value as DeliveryDayMode)}
              >
                <option value="arrival">Ankomst till oss</option>
                <option value="dispatch">Avsändning från leverantören</option>
              </Select>
            </div>
            <label className={styles.transit}>
              Transportdagar
              <input
                type="number"
                min="0"
                step="1"
                className={styles.numberInput}
                value={supplierTransit}
                onChange={(e) => {
                  setTransitSaved(false);
                  setSupplierTransit(e.target.value);
                }}
                onBlur={() => saveTransit("supplier")}
              />
            </label>
          </div>
        </div>
        <div className={styles.sideRow}>
          <div className={styles.sideLabel}>Kunder — Dagarna avser</div>
          <div className={styles.sideControls}>
            <div className={styles.modeSelect}>
              <Select
                aria-label="Kunder — Dagarna avser"
                value={customerMode}
                onChange={(e) => changeDeliveryDayMode("customer", e.target.value as DeliveryDayMode)}
              >
                <option value="arrival">Ankomst till kunden</option>
                <option value="dispatch">Avsändning från oss</option>
              </Select>
            </div>
            <label className={styles.transit}>
              Transportdagar
              <input
                type="number"
                min="0"
                step="1"
                className={styles.numberInput}
                value={customerTransit}
                onChange={(e) => {
                  setTransitSaved(false);
                  setCustomerTransit(e.target.value);
                }}
                onBlur={() => saveTransit("customer")}
              />
            </label>
          </div>
        </div>
        {transitSaved && <span className={styles.saved}>Sparat</span>}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "" : String(value);
}
