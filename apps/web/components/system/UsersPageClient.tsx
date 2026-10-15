"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { UserForm } from "./UserForm";
import type { AdminUser, PermissionGroup } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

const ROLE_LABELS: Record<AdminUser["role"], string> = {
  admin: "Administratör",
  supervisor: "Arbetsledare",
  user: "Användare",
};

export function UsersPageClient({ users, groups, currentUserId }: { users: AdminUser[]; groups: PermissionGroup[]; currentUserId: string }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Användare</div>
          <div className={shellStyles.meta}>
            {users.length} användare, {users.filter((u) => u.active).length} aktiva
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny användare
          </Button>
          <HelpLink chapter="system" anchor="anvandare" label="Hjälp om användare" />
        </div>
      </div>

      <Table<AdminUser>
        columns={[
          { key: "name", label: "Namn", width: "1.4fr" },
          { key: "email", label: "E-post", width: "1.6fr" },
          { key: "role", label: "Roll", width: "1fr" },
          { key: "group", label: "Behörighetsgrupp", width: "1.2fr" },
          { key: "active", label: "Status", width: "0.8fr" },
        ]}
        rows={users}
        renderCell={(user, key) => {
          switch (key) {
            case "name":
              return (
                <button
                  type="button"
                  onClick={() => setEditing(user)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}
                >
                  <strong>{user.name}</strong>
                </button>
              );
            case "email":
              return user.email;
            case "role":
              return ROLE_LABELS[user.role];
            case "group":
              return user.role === "admin" ? "Alla (administratör)" : (user.permissionGroupName ?? "Ingen åtkomst");
            case "active":
              return <StatusPill status={user.active ? "done" : "stopped"} label={user.active ? "Aktiv" : "Avstängd"} />;
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny användare">
        <UserForm
          groups={groups}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <UserForm
            groups={groups}
            user={editing}
            currentUserId={currentUserId}
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
