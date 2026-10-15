"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, Input, Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { CompanyCarrier, RegisterEntry } from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";

// The company's own customer numbers at each carrier — a list under
// Företagsinformation. Mirrors the sub-list pattern (PartnerTabs KontakterTab).
export function CompanyCarriersSection({
  carriers,
  companyCarriers,
}: {
  carriers: RegisterEntry[];
  companyCarriers: CompanyCarrier[];
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CompanyCarrier | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(row: CompanyCarrier) {
    if (!(await confirmDelete(`Ta bort ${row.carrierName} ur listan?`))) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/company-carriers/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort speditören");
    }
  }

  return (
    <Card maxWidth={640}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong>Speditörer</strong>
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          + Ny speditör
        </Button>
      </div>

      <FormHint>
        Företagets egna kundnummer hos olika speditörer. Numret skrivs ut på inköpsorder/förfrågan när
        &quot;Frakt på vårt konto&quot; är ikryssad och den valda speditören finns här.
      </FormHint>

      <FormError>{error}</FormError>

      <Table<CompanyCarrier>
        columns={[
          { key: "carrierName", label: "Speditör", width: "1.4fr" },
          { key: "customerNumber", label: "Kundnummer", width: "1fr" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={companyCarriers}
        emptyText="Inga speditörer registrerade"
        renderCell={(row, key) => {
          switch (key) {
            case "carrierName":
              return <strong>{row.carrierName}</strong>;
            case "customerNumber":
              return row.customerNumber;
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setEditing(row);
                      setModalOpen(true);
                    }}
                  >
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => remove(row)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Redigera ${editing.carrierName}` : "Ny speditör"}
      >
        <CompanyCarrierForm
          carriers={carriers}
          existing={editing}
          usedCarrierIds={companyCarriers.map((c) => c.carrierId)}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </Card>
  );
}

// Creates a company carrier account, or edits one (customer number only —
// the carrier link is fixed after creation).
function CompanyCarrierForm({
  carriers,
  existing,
  usedCarrierIds,
  onSuccess,
}: {
  carriers: RegisterEntry[];
  existing: CompanyCarrier | null;
  usedCarrierIds: string[];
  onSuccess: () => void;
}) {
  const [carrierId, setCarrierId] = useState(existing?.carrierId ?? "");
  const [customerNumber, setCustomerNumber] = useState(existing?.customerNumber ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // On create, only offer carriers not already in the list.
  const available = existing ? carriers : carriers.filter((c) => !usedCarrierIds.includes(c.id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!existing && !carrierId) {
      setError("Välj en speditör");
      return;
    }
    if (!customerNumber.trim()) {
      setError("Ange ett kundnummer");
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (existing) {
        await apiFetch(`/api/v1/company-carriers/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ customerNumber: customerNumber.trim() }),
        });
      } else {
        await apiFetch(`/api/v1/company-carriers`, {
          method: "POST",
          body: JSON.stringify({ carrierId, customerNumber: customerNumber.trim() }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara speditören");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      {existing ? (
        <Field label="Speditör">
          <Input value={existing.carrierName} disabled />
        </Field>
      ) : (
        <Field label="Speditör" htmlFor="companyCarrierSelect">
          <Select id="companyCarrierSelect" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
            <option value="">— Välj speditör —</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Kundnummer" htmlFor="companyCarrierNumber">
        <Input
          id="companyCarrierNumber"
          maxLength={50}
          size="md"
          value={customerNumber}
          onChange={(e) => setCustomerNumber(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : existing ? "Spara" : "Lägg till"}
        </Button>
      </FormActions>
    </Form>
  );
}
