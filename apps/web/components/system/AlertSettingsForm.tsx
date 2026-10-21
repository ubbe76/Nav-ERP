"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import type { SystemSettings } from "../../lib/types";
import styles from "./SettingsForm.module.css";

// Aviseringar: the three system settings behind the alert list and the daily
// digest mail. Each field saves when it is left.
export function AlertSettingsForm({ settings }: { settings: SystemSettings }) {
  const [baseUrl, setBaseUrl] = useState(settings.publicBaseUrl);
  const [time, setTime] = useState(settings.alertDigestTime);
  const [days, setDays] = useState(String(settings.alertSupplierInvoiceDays));
  const [quoteDays, setQuoteDays] = useState(String(settings.alertQuoteFollowupDays));
  // The last values the server holds; a blur that changes nothing sends no PATCH.
  const [last, setLast] = useState({
    url: settings.publicBaseUrl,
    time: settings.alertDigestTime,
    days: settings.alertSupplierInvoiceDays,
    quoteDays: settings.alertQuoteFollowupDays,
  });
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(field: string, body: Partial<SystemSettings>) {
    setError(null);
    setSaved(null);
    setPending(true);
    try {
      const updated = await apiFetch<SystemSettings>("/api/v1/settings", { method: "PATCH", body: JSON.stringify(body) });
      setBaseUrl(updated.publicBaseUrl);
      setTime(updated.alertDigestTime);
      setDays(String(updated.alertSupplierInvoiceDays));
      setQuoteDays(String(updated.alertQuoteFollowupDays));
      setLast({
        url: updated.publicBaseUrl,
        time: updated.alertDigestTime,
        days: updated.alertSupplierInvoiceDays,
        quoteDays: updated.alertQuoteFollowupDays,
      });
      setSaved(field);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara inställningen");
    } finally {
      setPending(false);
    }
  }

  function saveBaseUrl() {
    const value = baseUrl.trim().replace(/\/+$/, "");
    if (value === last.url && value === baseUrl.trim()) return;
    void save("url", { publicBaseUrl: value });
  }

  function saveTime() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setError("Klockslaget måste anges som tt:mm");
      return;
    }
    if (time === last.time) return;
    void save("time", { alertDigestTime: time });
  }

  function saveDays(badInput: boolean) {
    const value = days.trim() === "" ? NaN : Number(days);
    if (badInput || !Number.isInteger(value) || value < 0 || value > 60) {
      setError("Antal dagar måste vara ett heltal 0–60");
      return;
    }
    if (value === last.days) return;
    void save("days", { alertSupplierInvoiceDays: value });
  }

  function saveQuoteDays(badInput: boolean) {
    const value = quoteDays.trim() === "" ? NaN : Number(quoteDays);
    if (badInput || !Number.isInteger(value) || value < 0 || value > 60) {
      setError("Antal dagar måste vara ett heltal 0–60");
      return;
    }
    if (value === last.quoteDays) return;
    void save("quoteDays", { alertQuoteFollowupDays: value });
  }

  return (
    <div className={styles.card} style={{ marginTop: 24 }}>
      <div className={styles.texts} style={{ marginBottom: 18 }}>
        <div className={styles.label}>Aviseringar</div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Navs adress</div>
          <div className={styles.description}>
            Adressen användarna öppnar Nav på, t.ex. https://erp.foretag.se. Behövs för länkarna i den dagliga
            sammanställningen; är den tom skickas mejlet utan länkar.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 1 }}>
          <input
            type="url"
            aria-label="Navs adress"
            className={styles.numberInput}
            style={{ width: 240, maxWidth: "100%", minWidth: 0 }}
            value={baseUrl}
            disabled={pending}
            onChange={(e) => {
              setSaved(null);
              setBaseUrl(e.target.value);
            }}
            onBlur={saveBaseUrl}
          />
          {saved === "url" && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Skicka sammanställningen klockan</div>
          <div className={styles.description}>
            Klockslaget (svensk tid) då den dagliga sammanställningen skickas till dem som slagit på den. Skickas
            bara på arbetsdagar.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="time"
            aria-label="Skicka sammanställningen klockan"
            className={styles.numberInput}
            style={{ width: 120 }}
            value={time}
            disabled={pending}
            onChange={(e) => {
              setSaved(null);
              setTime(e.target.value);
            }}
            onBlur={saveTime}
          />
          {saved === "time" && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Leverantörsfakturor att betala inom (dagar)</div>
          <div className={styles.description}>
            Hur långt framåt aviseringen Leverantörsfakturor att betala tittar. 0 = förfallna fakturor och de som
            förfaller i dag.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min="0"
            max={60}
            step="1"
            aria-label="Leverantörsfakturor att betala inom (dagar)"
            className={styles.numberInput}
            value={days}
            disabled={pending}
            onChange={(e) => {
              setSaved(null);
              setDays(e.target.value);
            }}
            onBlur={(e) => saveDays(e.currentTarget.validity.badInput)}
          />
          {saved === "days" && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.texts}>
          <div className={styles.label}>Offerter att följa upp inom (dagar)</div>
          <div className={styles.description}>
            Hur långt framåt aviseringen Offerter att följa upp tittar. 0 = offerter som har gått ut och de som går
            ut i dag.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min="0"
            max={60}
            step="1"
            aria-label="Offerter att följa upp inom (dagar)"
            className={styles.numberInput}
            value={quoteDays}
            disabled={pending}
            onChange={(e) => {
              setSaved(null);
              setQuoteDays(e.target.value);
            }}
            onBlur={(e) => saveQuoteDays(e.currentTarget.validity.badInput)}
          />
          {saved === "quoteDays" && <span className={styles.saved}>Sparat</span>}
        </div>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
