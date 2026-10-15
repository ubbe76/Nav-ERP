"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { apiFetch } from "../../lib/api";
import type { ApiClient } from "../../lib/types";
import { API_CLIENT_SCOPE_LABELS, API_CLIENT_SCOPES } from "../../lib/apiClientScopes";

// All rights and no customer — what clients created before 4.9 got.
function hasFullAccess(client: ApiClient) {
  return client.customerId === null && API_CLIENT_SCOPES.every((s) => client.scopes.includes(s));
}

export function ApiClientsTable({ clients, onEdit }: { clients: ApiClient[]; onEdit: (client: ApiClient) => void }) {
  const router = useRouter();

  return (
    <Table<ApiClient>
      columns={[
        { key: "name", label: "Namn", width: "1fr" },
        { key: "access", label: "Behörighet", width: "2fr" },
        { key: "active", label: "Status", width: "140px" },
        { key: "createdAt", label: "Skapad", width: "160px" },
        { key: "actions", label: "", width: "200px" },
      ]}
      rows={clients}
      renderCell={(client, key) => {
        switch (key) {
          case "name":
            return <strong>{client.name}</strong>;
          case "access":
            return (
              <div>
                <div>{client.scopes.map((s) => API_CLIENT_SCOPE_LABELS[s]).join(", ") || "Inga"}</div>
                <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
                  {client.customer ? `Kund: ${client.customer.customerNumber} · ${client.customer.name}` : "Alla kunder"}
                </div>
                {client.active && hasFullAccess(client) && (
                  <span title="Överväg att begränsa klienten">
                    <StatusPill status="delayed" label="Full åtkomst" compact />
                  </span>
                )}
              </div>
            );
          case "active":
            return client.active ? (
              <StatusPill status="running" label="Aktiv" compact />
            ) : (
              <StatusPill status="draft" label="Återkallad" compact />
            );
          case "createdAt":
            return new Date(client.createdAt).toLocaleDateString("sv-SE");
          case "actions":
            return client.active ? (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <Button type="button" variant="secondary" size="small" onClick={() => onEdit(client)}>
                  Ändra
                </Button>
                <RevokeButton client={client} onDone={() => router.refresh()} />
              </div>
            ) : null;
          default:
            return null;
        }
      }}
    />
  );
}

function RevokeButton({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/api-clients/${client.id}/revoke`, { method: "POST" });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte återkalla klienten");
      setPending(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="danger" size="small" disabled={pending} onClick={revoke}>
        {pending ? "…" : "Återkalla"}
      </Button>
      {error && <div style={{ color: "var(--status-stopped-text)", fontSize: 12, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
