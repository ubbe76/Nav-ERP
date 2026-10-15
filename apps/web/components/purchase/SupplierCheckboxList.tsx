"use client";

import { useEffect, useMemo, useState } from "react";
import { Checkbox, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { Paged, Supplier } from "../../lib/types";

// Checkbox list of active suppliers with a text filter — used by the
// legoförfrågan dialog to pick which suppliers get the request. Fetches its
// own list (?limit=1000, same idiom as the other supplier dropdowns) unless
// the caller already has one loaded.
export function SupplierCheckboxList({
  value,
  onChange,
  preselect,
  suppliers: suppliersProp,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  preselect: string[];
  suppliers?: Supplier[];
}) {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(suppliersProp ?? null);
  const [filter, setFilter] = useState("");
  const [preselected, setPreselected] = useState(false);

  useEffect(() => {
    if (suppliersProp) return;
    let cancelled = false;
    apiFetch<Paged<Supplier>>("/api/v1/suppliers?limit=1000")
      .then((res) => {
        if (!cancelled) setSuppliers(res.rows);
      })
      .catch(() => {
        if (!cancelled) setSuppliers([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  }, []);

  const active = useMemo(() => (suppliers ?? []).filter((s) => s.active), [suppliers]);

  // Applies `preselect` exactly once, once the list has actually loaded —
  // only ids that exist in it (a primarySupplier could point at a since
  // deactivated supplier).
  useEffect(() => {
    if (preselected || suppliers === null) return;
    const ids = active.filter((s) => preselect.includes(s.id)).map((s) => s.id);
    if (ids.length > 0) onChange(ids);
    setPreselected(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when the list first arrives
  }, [suppliers]);

  if (suppliers === null) return <p>Hämtar leverantörer…</p>;

  const term = filter.trim().toLowerCase();
  const filtered = term
    ? active.filter((s) => `${s.name} ${s.supplierNumber}`.toLowerCase().includes(term))
    : active;

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));
  }

  return (
    <div>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Sök leverantör…"
        aria-label="Sök leverantör"
        style={{ marginBottom: 8 }}
      />
      {filtered.length === 0 ? (
        <p>Inga leverantörer</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
          {filtered.map((s) => (
            <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px" }}>
              <Checkbox checked={value.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              <span>
                {s.name}
                {s.supplierNumber && (
                  <span style={{ color: "var(--color-text-muted)", marginLeft: 6, fontSize: 12 }}>
                    {s.supplierNumber}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
