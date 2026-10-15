"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { Select } from "../ui/Field";
import type { SystemSettings } from "../../lib/types";
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
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "" : String(value);
}
