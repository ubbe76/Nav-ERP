"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { HelpLink } from "../ui/HelpLink";
import { PermissionGroupForm } from "./PermissionGroupForm";
import { PERMISSION_LABELS } from "../../lib/permissions";
import type { PermissionGroup } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

export function PermissionGroupsPageClient({ groups }: { groups: PermissionGroup[] }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PermissionGroup | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Behörighetsgrupper</div>
          <div className={shellStyles.meta}>{groups.length} grupper</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny behörighetsgrupp
          </Button>
          <HelpLink chapter="system" anchor="behorighetsgrupper" label="Hjälp om behörighetsgrupper" />
        </div>
      </div>

      <Table<PermissionGroup>
        columns={[
          { key: "code", label: "Kod", width: "0.8fr" },
          { key: "name", label: "Namn", width: "1.4fr" },
          { key: "permissions", label: "Rättigheter", width: "2.6fr" },
          { key: "users", label: "Användare", width: "0.8fr", align: "right" },
        ]}
        rows={groups}
        renderCell={(group, key) => {
          switch (key) {
            case "code":
              return (
                <button
                  type="button"
                  onClick={() => setEditing(group)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}
                >
                  <strong>{group.code}</strong>
                </button>
              );
            case "name":
              return group.name;
            case "permissions":
              return group.permissions.length === 0
                ? "Ingen åtkomst"
                : group.permissions.map((p) => PERMISSION_LABELS[p]).join(", ");
            case "users":
              return group.userCount;
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny behörighetsgrupp">
        <PermissionGroupForm
          allGroups={groups}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.code}` : ""}>
        {editing && (
          <PermissionGroupForm
            group={editing}
            allGroups={groups}
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
