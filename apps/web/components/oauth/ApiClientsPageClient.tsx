"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ApiClientsTable } from "./ApiClientsTable";
import { NewApiClientForm } from "./NewApiClientForm";
import type { ApiClient } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function ApiClientsPageClient({ clients }: { clients: ApiClient[] }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);

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

      <ApiClientsTable clients={clients} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny API-klient">
        <NewApiClientForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}
