"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Checkbox, Field, Input, Select, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { StockLocation, Warehouse } from "../../lib/types";
import { Form, FormActions, FormError } from "../ui/Form";
import { Card } from "../ui/Card";
import { SectionHeading } from "../ui/SectionHeading";

export function LocationsSection({ locations, warehouses }: { locations: StockLocation[]; warehouses: Warehouse[] }) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Row being edited, and its drafts.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editWarehouseId, setEditWarehouseId] = useState("");
  const [editActive, setEditActive] = useState(true);
  // Emptied locations are deactivated rather than deleted, so they are hidden
  // here by default — the page always loads them (?includeInactive=true).
  const [showInactive, setShowInactive] = useState(false);
  const visibleLocations = showInactive ? locations : locations.filter((l) => l.active);
  const inactiveCount = locations.filter((l) => !l.active).length;

  async function saveEdit(row: StockLocation) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock/locations/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, warehouseId: editWarehouseId, active: editActive }),
      });
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara lagerplatsen");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <SectionHeading
        actions={
          inactiveCount > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 13 }}>
              <Checkbox checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Visa inaktiva ({inactiveCount})
            </label>
          )
        }
      >
        Lagerplatser
      </SectionHeading>
      <FormError>{error}</FormError>
      {visibleLocations.length > 0 ? (
        <Table<StockLocation>
          columns={[
            { key: "warehouseName", label: "Lager", width: "1fr" },
            { key: "name", label: "Namn", width: "1fr" },
            { key: "active", label: "Status", width: "140px" },
            { key: "id", label: "", width: "170px", align: "right" },
          ]}
          rows={visibleLocations}
          renderCell={(row, key) => {
            switch (key) {
              case "warehouseName":
                return editingId === row.id ? (
                  <Select value={editWarehouseId} onChange={(e) => setEditWarehouseId(e.target.value)} aria-label="Lager">
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  row.warehouseName
                );
              case "name":
                return editingId === row.id ? (
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus style={{ maxWidth: 180 }} />
                ) : (
                  row.name
                );
              case "active":
                return editingId === row.id ? (
                  <Toggle checked={editActive} onChange={(e) => setEditActive(e.target.checked)} aria-label="Aktiv" />
                ) : row.active ? (
                  <StatusPill status="running" label="Aktiv" compact />
                ) : (
                  <StatusPill status="draft" label="Inaktiv" compact />
                );
              case "id":
                return editingId === row.id ? (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => saveEdit(row)}>
                      Spara
                    </Button>
                    <Button type="button" size="small" variant="ghost" onClick={() => setEditingId(null)}>
                      Avbryt
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(row.id);
                      setEditName(row.name);
                      setEditWarehouseId(row.warehouseId);
                      setEditActive(row.active);
                    }}
                  >
                    Ändra
                  </Button>
                );
              default:
                return row[key as keyof StockLocation];
            }
          }}
        />
      ) : (
        <p>Inga lagerplatser tillagda än.</p>
      )}

      {warehouses.length === 0 ? (
        <p style={{ marginTop: 16 }}>Skapa ett lager ovan innan du kan lägga till en lagerplats.</p>
      ) : (
        <Card maxWidth={420} style={{ marginTop: 16 }}>
          <Form onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              setError(null);
              setPending(true);
              try {
                await apiFetch("/api/v1/stock/locations", {
                  method: "POST",
                  body: JSON.stringify({ warehouseId, name }),
                });
                setName("");
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Kunde inte skapa lagerplatsen");
              } finally {
                setPending(false);
              }
            }}>
            <strong>Ny lagerplats</strong>

            <Field label="Lager" htmlFor="locationWarehouseId">
              <Select id="locationWarehouseId" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Namn" htmlFor="locationName">
              <Input id="locationName" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>

            <FormActions>
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? "Skapar…" : "Skapa lagerplats"}
              </Button>
            </FormActions>
          </Form>
        </Card>
      )}
    </div>
  );
}
