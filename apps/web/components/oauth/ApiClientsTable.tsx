"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { apiFetch } from "../../lib/api";
import type { ApiClient } from "../../lib/types";

export function ApiClientsTable({ clients }: { clients: ApiClient[] }) {
  const router = useRouter();

  return (
    <Table<ApiClient>
      columns={[
        { key: "name", label: "Namn", width: "1fr" },
        { key: "active", label: "Status", width: "140px" },
        { key: "createdAt", label: "Skapad", width: "160px" },
        { key: "actions", label: "", width: "140px" },
      ]}
      rows={clients}
      renderCell={(client, key) => {
        switch (key) {
          case "name":
            return <strong>{client.name}</strong>;
          case "active":
            return client.active ? (
              <StatusPill status="running" label="Aktiv" compact />
            ) : (
              <StatusPill status="draft" label="Återkallad" compact />
            );
          case "createdAt":
            return new Date(client.createdAt).toLocaleDateString("sv-SE");
          case "actions":
            return client.active ? <RevokeButton client={client} onDone={() => router.refresh()} /> : null;
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
