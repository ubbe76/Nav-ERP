"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../../lib/api";
import { moveInList } from "../../lib/stockLocations";
import { OVERVIEW_CARDS, OVERVIEW_CARD_LABELS, type OverviewCard } from "../../lib/overviewCards";
import styles from "./CustomizeOverview.module.css";

interface Entry {
  key: OverviewCard;
  shown: boolean;
}

// The shown cards in their order first, then the hidden ones in the standard
// order — so ticking Visa brings a card back where it was listed.
function startEntries(shown: readonly OverviewCard[]): Entry[] {
  return [
    ...shown.map((key) => ({ key, shown: true })),
    ...OVERVIEW_CARDS.filter((key) => !shown.includes(key)).map((key) => ({ key, shown: false })),
  ];
}

// Anpassa: each user picks the cards on Översikten and their order. Also used
// by read-only accounts (their own settings are not business data).
export function CustomizeOverview({ shown }: { shown: OverviewCard[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>(() => startEntries(shown));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setEntries(startEntries(shown));
    setError(null);
    setOpen(true);
  }

  async function save(overviewCards: OverviewCard[] | null) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify({ overviewCards }) });
      setOpen(false);
      router.refresh();
    } catch {
      setError("Kunde inte spara. Försök igen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={openDialog}>
        Anpassa
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Anpassa Översikten" compact>
        <p className={styles.hint}>Välj vilka kort Översikten visar och i vilken ordning. Valet gäller bara dig.</p>
        <ol className={styles.list}>
          {entries.map((entry, i) => {
            const label = OVERVIEW_CARD_LABELS[entry.key];
            return (
              <li key={entry.key} className={styles.item}>
                <label className={styles.visible}>
                  <input
                    type="checkbox"
                    checked={entry.shown}
                    onChange={(e) =>
                      setEntries(entries.map((x) => (x.key === entry.key ? { ...x, shown: e.target.checked } : x)))
                    }
                  />
                  <span className={styles.name}>{label}</span>
                  <span className={styles.visibleLabel}>Visa</span>
                </label>
                <span className={styles.actions}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-label={`Flytta upp ${label}`}
                    disabled={i === 0}
                    onClick={() => setEntries(moveInList(entries, i, -1))}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-label={`Flytta ned ${label}`}
                    disabled={i === entries.length - 1}
                    onClick={() => setEntries(moveInList(entries, i, 1))}
                  >
                    ↓
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.footer}>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => save(null)}>
            Återställ standard
          </Button>
          <span className={styles.footerRight}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => save(entries.filter((e) => e.shown).map((e) => e.key))}
            >
              Spara
            </Button>
          </span>
        </div>
      </Modal>
    </>
  );
}
