"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { Warehouse } from "../../lib/types";
import { Form, FormActions, FormError } from "../ui/Form";
import { Card } from "../ui/Card";
import { SectionHeading } from "../ui/SectionHeading";

export function WarehousesSection({ warehouses }: { warehouses: Warehouse[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Row being edited, and its drafts.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editActive, setEditActive] = useState(true);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/stock/warehouses", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa lagret");
    } finally {
      setPending(false);
    }
  }

  async function saveEdit(row: Warehouse) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock/warehouses/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, active: editActive }),
      });
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara lagret");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <SectionHeading>Lager</SectionHeading>
      <FormError>{error}</FormError>
      {warehouses.length > 0 ? (
        <Table<Warehouse>
          columns={[
            { key: "name", label: "Namn", width: "1fr" },
            { key: "active", label: "Status", width: "140px" },
            { key: "id", label: "", width: "170px", align: "right" },
          ]}
          rows={warehouses}
          renderCell={(row, key) => {
            switch (key) {
              case "name":
                return editingId === row.id ? (
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus style={{ maxWidth: 220 }} />
                ) : (
                  <strong>{row.name}</strong>
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
                      setEditActive(row.active);
                    }}
                  >
                    Ändra
                  </Button>
                );
              default:
                return null;
            }
          }}
        />
      ) : (
        <p>Inga lager tillagda än.</p>
      )}

      <Card maxWidth={420} style={{ marginTop: 16 }}>
        <Form onSubmit={handleSubmit}>
          <strong>Nytt lager</strong>

          <Field label="Namn" htmlFor="warehouseName">
            <Input id="warehouseName" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <FormActions>
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? "Skapar…" : "Skapa lager"}
            </Button>
          </FormActions>
        </Form>
      </Card>
    </div>
  );
}
