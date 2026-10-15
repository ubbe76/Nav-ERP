"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ApiClientsTable } from "./ApiClientsTable";
import { NewApiClientForm } from "./NewApiClientForm";
import { EditApiClientForm } from "./EditApiClientForm";
import type { ApiClient } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function ApiClientsPageClient({ clients }: { clients: ApiClient[] }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ApiClient | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Integrationer</div>
          <div className={shellStyles.meta}>{clients.length} API-klienter</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny klient
          </Button>
          <HelpLink chapter="system" anchor="integrationer" label="Hjälp om integrationer" />
        </div>
      </div>

      <ApiClientsTable clients={clients} onEdit={setEditing} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny API-klient">
        <NewApiClientForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Ändra ${editing.name}` : "Ändra"}>
        {editing && (
          <EditApiClientForm
            key={editing.id}
            client={editing}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}
