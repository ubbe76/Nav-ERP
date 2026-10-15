"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewArticleGroupForm } from "./NewArticleGroupForm";
import type { ArticleGroup } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function ArticleGroupsPageClient({ groups }: { groups: ArticleGroup[] }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ArticleGroup | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Artikelgrupper</div>
          <div className={shellStyles.meta}>{groups.length} grupper</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/artiklar/register" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Artiklar
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny grupp
          </Button>
          <HelpLink chapter="artiklar" anchor="artikelgrupper" label="Hjälp om artikelgrupper" />
        </div>
      </div>

      <Table<ArticleGroup>
        columns={[
          { key: "code", label: "Kod", width: "0.4fr" },
          { key: "name", label: "Namn", width: "1.2fr" },
          { key: "description", label: "Beskrivning", width: "minmax(0, 2.4fr)" },
        ]}
        rows={groups}
        renderCell={(group, key) => {
          switch (key) {
            case "code":
              return group.code;
            case "name":
              return (
                <button
                  type="button"
                  onClick={() => setEditing(group)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}
                >
                  <strong>{group.name}</strong>
                </button>
              );
            case "description":
              return group.description ? (
                <span
                  title={group.description}
                  style={{ display: "block", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {group.description}
                </span>
              ) : (
                "—"
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny artikelgrupp">
        <NewArticleGroupForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <NewArticleGroupForm
            group={editing}
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
