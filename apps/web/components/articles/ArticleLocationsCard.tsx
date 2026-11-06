"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormSaved } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { formatQuantity } from "../../lib/format";
import { locationOptionLabel, moveInList } from "../../lib/stockLocations";
import type { ArticleLocationPlace, ArticleLocations, StockLocation } from "../../lib/types";
import styles from "./ArticleLocationsCard.module.css";

const MAX_ALTERNATIVES = 20;

interface PlaceInfo {
  warehouseName: string;
  name: string;
  blocked: boolean;
  active: boolean;
  quantityOnHand?: string;
}

function placeLabel(p: PlaceInfo): string {
  return locationOptionLabel(p, { inactive: true });
}

function infoOf(p: ArticleLocationPlace): PlaceInfo {
  return { warehouseName: p.warehouseName, name: p.name, blocked: p.blocked, active: p.active, quantityOnHand: p.quantityOnHand };
}

// Lagerplatser card on the Lager tab: the article's huvudplats and the ordered
// alternativa platser. PUT replaces the whole set; the server owns the rules.
export function ArticleLocationsCard({
  articleId,
  value,
  onSaved,
}: {
  articleId: string;
  value: ArticleLocations;
  onSaved: (v: ArticleLocations) => void;
}) {
  const canEdit = useCan()(["artiklar", "lager"]);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [primaryId, setPrimaryId] = useState(value.primary?.locationId ?? "");
  const [altIds, setAltIds] = useState(value.alternatives.map((p) => p.locationId));
  const [toAdd, setToAdd] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StockLocation[]>("/api/v1/stock/locations").then(setLocations).catch(() => setLocations([]));
  }, []);

  // Everything we can name: the active register plus the places already
  // assigned (which may have been deactivated or blocked since).
  const info = useMemo(() => {
    const m = new Map<string, PlaceInfo>();
    for (const l of locations) m.set(l.id, { warehouseName: l.warehouseName, name: l.name, blocked: l.blocked, active: l.active });
    for (const p of [value.primary, ...value.alternatives]) if (p) m.set(p.locationId, infoOf(p));
    return m;
  }, [locations, value]);

  const savedPrimary = value.primary?.locationId ?? "";
  const savedAlts = value.alternatives.map((p) => p.locationId);
  const dirty = primaryId !== savedPrimary || altIds.join(",") !== savedAlts.join(",");

  // The *** reserve is the "no huvudplats" choice, never a place of its own.
  const isReserve = (l: StockLocation) => l.warehouseName === "***";
  // Choices: not blocked / not inactive, unless it is the assigned one (kept with suffix).
  const usable = locations.filter((l) => l.active && !l.blocked && !isReserve(l));
  const primaryChoices = usable.filter((l) => !altIds.includes(l.id) || l.id === primaryId);
  const addChoices = usable.filter((l) => l.id !== primaryId && !altIds.includes(l.id));

  function labelFor(id: string): string {
    const i = info.get(id);
    return i ? placeLabel(i) : "Okänd plats";
  }

  function add() {
    if (!toAdd || altIds.length >= MAX_ALTERNATIVES) return;
    setAltIds([...altIds, toAdd]);
    setToAdd("");
    setSaved(false);
  }

  async function save() {
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const next = await apiFetch<ArticleLocations>(`/api/v1/articles/${articleId}/locations`, {
        method: "PUT",
        body: JSON.stringify({
          primaryLocationId: primaryId === "" ? null : primaryId,
          alternativeLocationIds: altIds,
        }),
      });
      onSaved(next);
      setPrimaryId(next.primary?.locationId ?? "");
      setAltIds(next.alternatives.map((p) => p.locationId));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={640} style={{ marginBottom: 20 }}>
      <SectionHeading>Lagerplatser</SectionHeading>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormError>{error}</FormError>
        <Field label="Huvudplats" htmlFor="articlePrimaryLocation">
          <Select
            id="articlePrimaryLocation"
            value={primaryId}
            disabled={!canEdit}
            onChange={(e) => {
              setPrimaryId(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">*** (standard)</option>
            {/* An assigned place that is blocked/inactive now stays selectable, with its suffix. */}
            {primaryId && !primaryChoices.some((l) => l.id === primaryId) && (
              <option value={primaryId}>{labelFor(primaryId)}</option>
            )}
            {primaryChoices.map((l) => (
              <option key={l.id} value={l.id}>
                {locationOptionLabel(l)}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <Field label="Alternativa lagerplatser">
            {altIds.length === 0 ? (
              <p className={styles.empty}>Inga alternativa lagerplatser.</p>
            ) : (
              <ol className={styles.list}>
                {altIds.map((id, i) => (
                  <li key={id} className={styles.item}>
                    <span className={styles.rank}>{i + 1}.</span>
                    <span className={styles.name}>{labelFor(id)}</span>
                    {canEdit && (
                      <span className={styles.itemActions}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          aria-label={`Flytta upp ${labelFor(id)}`}
                          disabled={i === 0}
                          onClick={() => {
                            setAltIds(moveInList(altIds, i, -1));
                            setSaved(false);
                          }}
                        >
                          ↑
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          aria-label={`Flytta ned ${labelFor(id)}`}
                          disabled={i === altIds.length - 1}
                          onClick={() => {
                            setAltIds(moveInList(altIds, i, 1));
                            setSaved(false);
                          }}
                        >
                          ↓
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          onClick={() => {
                            setAltIds(altIds.filter((x) => x !== id));
                            setSaved(false);
                          }}
                        >
                          Ta bort
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Field>
        </div>

        {canEdit && (
          <div className={styles.addRow}>
            <Select aria-label="Välj lagerplats att lägga till" value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">Välj lagerplats…</option>
              {addChoices.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationOptionLabel(l)}
                </option>
              ))}
            </Select>
            <Button type="button" variant="secondary" disabled={!toAdd || altIds.length >= MAX_ALTERNATIVES} onClick={add}>
              Lägg till plats
            </Button>
          </div>
        )}

        <FormHint attached>
          Inleveranser utan vald plats hamnar på huvudplatsen. Uttag med Automatiskt tar först från huvudplatsen, sedan från de
          alternativa platserna i ordning och sist från övriga platser med saldo.
        </FormHint>
        {canEdit && (
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending || !dirty}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && !pending && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        )}
      </Form>
    </Card>
  );
}
