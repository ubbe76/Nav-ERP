"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Checkbox, Field, Input, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { ProductionGroupDetail, ProductionGroupListItem, WorkCenter } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import formStyles from "./EmployeeTabs.module.css";
import styles from "../../app/tillverkning/tidrapporter/page.module.css";
import { HelpLink } from "../ui/HelpLink";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

const TYPE_LABELS: Record<WorkCenter["type"], string> = {
  machine: "Maskin",
  personnel: "Personal",
  // Never listed here (the pages filter ?type=machine,personnel) but the
  // union covers it.
  subcontract: "Lego",
};

export function ProductionGroupsPageClient({
  groups,
  workCenters,
}: {
  groups: ProductionGroupListItem[];
  workCenters: WorkCenter[];
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProductionGroupDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function openGroup(id: string) {
    setLoadError(null);
    try {
      setEditing(await apiFetch<ProductionGroupDetail>(`/api/v1/production-groups/${id}`));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Kunde inte hämta gruppen");
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Produktionsgrupper</div>
          <div className={shellStyles.meta}>{groups.length} grupper</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/tillverkning/resurser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Resurser
          </Link>
          <Link href="/tillverkning/resurser/import" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Importera
          </Link>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Ny grupp
          </Button>
          <HelpLink chapter="tillverkning" anchor="produktionsgrupper" label="Hjälp om produktionsgrupper" />
        </div>
      </div>

      <FormError>{loadError}</FormError>

      <Table<ProductionGroupListItem>
        columns={[
          { key: "code", label: "Kod", width: "120px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "workCenterCount", label: "Resurser", width: "110px", align: "right" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={groups}
        renderCell={(group, key) => {
          switch (key) {
            case "code":
              return (
                <button type="button" className={styles.rowLink} onClick={() => openGroup(group.id)}>
                  {group.code}
                </button>
              );
            case "name":
              return (
                <button type="button" className={styles.rowLink} onClick={() => openGroup(group.id)}>
                  <strong>{group.name}</strong>
                </button>
              );
            case "workCenterCount":
              return group.workCenterCount;
            case "active":
              return group.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Ny produktionsgrupp">
        <GroupForm
          workCenters={workCenters}
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `${editing.code} · ${editing.name}` : ""}>
        {editing && (
          <GroupForm
            group={editing}
            workCenters={workCenters}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function GroupForm({
  group,
  workCenters,
  onDone,
}: {
  group?: ProductionGroupDetail;
  workCenters: WorkCenter[];
  onDone: () => void;
}) {
  const [code, setCode] = useState(group?.code ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [active, setActive] = useState(group?.active ?? true);
  const [selectedWorkCenters, setSelectedWorkCenters] = useState<Set<string>>(
    () => new Set(group?.workCenters.map((w) => w.id) ?? [])
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toggleWorkCenter(id: string) {
    setSelectedWorkCenters((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // A resource belongs to at most one group — checking one that sits in
  // another group moves it here on save.
  function currentGroupNote(wc: WorkCenter): string | null {
    if (!wc.productionGroupCode) return null;
    if (group && wc.productionGroupId === group.id) return null;
    return `idag i ${wc.productionGroupCode} · ${wc.productionGroupName}`;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = { code, name, description: description.trim() === "" ? null : description, active };
      let groupId: string;
      if (group) {
        await apiFetch(`/api/v1/production-groups/${group.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        groupId = group.id;
      } else {
        const created = await apiFetch<{ id: string }>("/api/v1/production-groups", {
          method: "POST",
          body: JSON.stringify({ ...payload, description: payload.description ?? undefined }),
        });
        groupId = created.id;
      }
      await apiFetch(`/api/v1/production-groups/${groupId}/work-centers`, {
        method: "PUT",
        body: JSON.stringify({ workCenterIds: [...selectedWorkCenters] }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara gruppen");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Kod" htmlFor="groupCode">
          <Input id="groupCode" required maxLength={20} size="md" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Aktiv" htmlFor="groupActive">
          <Toggle id="groupActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Namn" htmlFor="groupName">
        <Input id="groupName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Beskrivning" htmlFor="groupDescription">
        <Input id="groupDescription" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <Field label="Resurser i gruppen" htmlFor="groupWorkCenters">
        {workCenters.length === 0 ? (
          <FormHint>Inga resurser registrerade än.</FormHint>
        ) : (
          <>
            <FormHint>
              En resurs kan bara tillhöra en grupp — bockar du i en resurs som ligger i en annan grupp flyttas den hit.
            </FormHint>
            <div className={formStyles.checkList} id="groupWorkCenters">
              {workCenters.map((wc) => {
                const note = currentGroupNote(wc);
                return (
                  <label key={wc.id} className={formStyles.checkRow} data-inactive={!wc.active}>
                    <Checkbox checked={selectedWorkCenters.has(wc.id)} onChange={() => toggleWorkCenter(wc.id)} />
                    <span className={formStyles.checkPrimary}>
                      {wc.code} · {wc.name} ({TYPE_LABELS[wc.type]})
                      {!wc.active && " (inaktiv)"}
                      {note && <span className={formStyles.inlineNote}> — {note}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : group ? "Spara grupp" : "Skapa grupp"}
        </Button>
      </FormActions>
    </Form>
  );
}
