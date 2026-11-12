"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ApiClientsTable } from "./ApiClientsTable";
import { NewApiClientForm } from "./NewApiClientForm";
import { EditApiClientForm } from "./EditApiClientForm";
import type { ApiClient } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { confirmDialog } from "../../lib/confirm";

export function ApiClientsPageClient({ clients }: { clients: ApiClient[] }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ApiClient | null>(null);

  // The secret is shown once: closing the dialog any way but "Klar" asks first.
  const secretShown = useRef(false);
  async function requestClose() {
    if (secretShown.current) {
      if (!(await confirmDialog("Secreten visas inte igen. Har du sparat den?", { confirmLabel: "Stäng" }))) return;
      // The client exists now — reload the list however the dialog was closed.
      secretShown.current = false;
      router.refresh();
    }
    setModalOpen(false);
  }

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

      <Modal open={modalOpen} onClose={() => void requestClose()} title="Ny API-klient">
        <NewApiClientForm
          onSecretShown={() => {
            secretShown.current = true;
            router.refresh();
          }}
          onSuccess={() => {
            secretShown.current = false;
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
