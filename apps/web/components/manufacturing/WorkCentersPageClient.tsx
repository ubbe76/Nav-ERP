"use client";

import { useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Input, Select } from "../ui/Field";
import { DurationInput } from "../ui/DurationInput";
import { DURATION_HINT, durationFromHours, hoursFromDuration } from "../../lib/duration";
import { FormError } from "../ui/Form";
import { NewWorkCenterForm } from "./NewWorkCenterForm";
import { apiFetch } from "../../lib/api";
import { WORK_CENTER_TYPE_LABELS, type ProductionGroup, type WeekSchedule, type WorkCenter } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { useCan } from "../PermissionsProvider";
import { apiErrorMessage } from "../../lib/errorMessages";

// The row-edit draft (NOTES.md #5): the fields a planner tunes often —
// cost rate, TO markup, group and capacity — editable straight in the list.
// Everything else (number, name, type, the Monitor defaults) still goes
// through the modal behind the name.
interface RowDraft {
  hourlyRate: string;
  overheadPercent: string;
  productionGroupId: string;
  weekScheduleId: string;
  capacityFactor: string;
  hoursPerDay: string;
}

// API decimals arrive as "450.0000"; show them the way the form does.
function plain(value: string): string {
  return String(Number(value));
}

function draftFor(workCenter: WorkCenter): RowDraft {
  return {
    hourlyRate: plain(workCenter.hourlyRate),
    overheadPercent: plain(workCenter.overheadPercent),
    productionGroupId: workCenter.productionGroupId ?? "",
    weekScheduleId: workCenter.weekScheduleId ?? "",
    capacityFactor: plain(workCenter.capacityFactor),
    // Kapacitet per dag as tt:mm; the column keeps hours.
    hoursPerDay: workCenter.hoursPerDay == null ? "" : durationFromHours(workCenter.hoursPerDay),
  };
}

// Only what actually changed goes in the PATCH — updateWorkCenterSchema
// requires at least one field, so an untouched row must not send `{}`.
function patchFor(workCenter: WorkCenter, draft: RowDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (Number(draft.hourlyRate) !== Number(workCenter.hourlyRate)) patch.hourlyRate = Number(draft.hourlyRate);
  if (Number(draft.overheadPercent) !== Number(workCenter.overheadPercent)) patch.overheadPercent = Number(draft.overheadPercent);
  if ((draft.productionGroupId || null) !== workCenter.productionGroupId) patch.productionGroupId = draft.productionGroupId || null;
  if ((draft.weekScheduleId || null) !== workCenter.weekScheduleId) patch.weekScheduleId = draft.weekScheduleId || null;
  if (Number(draft.capacityFactor) !== Number(workCenter.capacityFactor)) patch.capacityFactor = Number(draft.capacityFactor);
  const hours = draft.hoursPerDay.trim() === "" ? null : hoursFromDuration(draft.hoursPerDay, workCenter.hoursPerDay);
  if (hours !== (workCenter.hoursPerDay == null ? null : Number(workCenter.hoursPerDay))) patch.hoursPerDay = hours;
  return patch;
}

export function WorkCentersPageClient({
  workCenters,
  allWorkCenters,
  groups,
  weekSchedules,
}: {
  workCenters: WorkCenter[];
  // Every type — the form's number hint spans the shared code series.
  allWorkCenters: WorkCenter[];
  groups: ProductionGroup[];
  weekSchedules: WeekSchedule[];
}) {
  const router = useRouter();
  const canImport = useCan()(["admin"]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkCenter | null>(null);
  // Row being edited inline, and its draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RowDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(workCenter: WorkCenter) {
    setError(null);
    setEditingId(workCenter.id);
    setDraft(draftFor(workCenter));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  async function saveEdit(workCenter: WorkCenter) {
    if (!draft) return;
    // An unreadable Kapacitet must not be sent as "none".
    if (draft.hoursPerDay.trim() !== "" && hoursFromDuration(draft.hoursPerDay) === null) {
      setError(`Kapacitet per dag: ${DURATION_HINT}`);
      return;
    }
    const patch = patchFor(workCenter, draft);
    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/work-centers/${workCenter.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      cancelEdit();
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara resursen"));
    } finally {
      setPending(false);
    }
  }

  // Enter saves, Escape cancels — the row is a tiny form without a submit.
  function editKeys(workCenter: WorkCenter) {
    return (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void saveEdit(workCenter);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    };
  }

  function update(field: keyof RowDraft, value: string) {
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Resurser</div>
          <div className={shellStyles.meta}>{workCenters.length} resurser</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/tillverkning/grupper" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Produktionsgrupper
          </Link>
          <Link href="/tillverkning/legoresurser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Legoresurser
          </Link>
          <Link href="/tillverkning/ordrar" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Tillverkningsordrar
          </Link>
          {/* The import page is admin-only (it says so to anyone else). */}
          {canImport && (
            <Link href="/tillverkning/resurser/import" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Importera
            </Link>
          )}
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny resurs
          </Button>
          <HelpLink chapter="tillverkning" anchor="resurser" label="Hjälp om resurser" />
        </div>
      </div>

      <FormError margin="below">{error}</FormError>

      <Table<WorkCenter>
        columns={[
          // As tight as the contents allow, so the table fits beside the
          // module panel at 1280 px (about 900 px for the table): wider, the
          // last column with Ändra was scrolled out of the card. Kapacitet
          // widens while a row is edited (its schedule select and two
          // inputs), and the action column is max-content with Spara above
          // Avbryt, as on the order cards.
          { key: "code", label: "Nr", width: "50px" },
          { key: "name", label: "Namn", width: "minmax(100px, 1fr)" },
          { key: "type", label: "Typ", width: "64px" },
          { key: "productionGroupId", label: "Produktionsgrupp", width: "134px" },
          { key: "weekScheduleId", label: "Kapacitet", width: editingId !== null ? "125px" : "100px" },
          { key: "hourlyRate", label: "Timkostnad", width: "90px", align: "right" },
          { key: "overheadPercent", label: "TO-påslag", width: "75px", align: "right" },
          { key: "active", label: "Status", width: "64px" },
          { key: "id", label: "", width: "max-content", align: "right" },
        ]}
        rows={workCenters}
        renderCell={(workCenter, key) => {
          const isEditing = editingId === workCenter.id && draft !== null;
          const keys = editKeys(workCenter);
          switch (key) {
            case "code":
              return workCenter.code;
            case "name":
              return (
                <button
                  type="button"
                  onClick={() => setEditing(workCenter)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}
                >
                  <strong>{workCenter.name}</strong>
                </button>
              );
            case "type":
              return WORK_CENTER_TYPE_LABELS[workCenter.type];
            case "productionGroupId":
              if (isEditing) {
                return (
                  <Select
                    value={draft.productionGroupId}
                    onChange={(e) => update("productionGroupId", e.target.value)}
                    onKeyDown={keys}
                    aria-label={`Produktionsgrupp för ${workCenter.name}`}
                    style={{ width: "100%" }}
                  >
                    <option value="">— Ingen —</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.code} · {group.name}
                      </option>
                    ))}
                  </Select>
                );
              }
              return workCenter.productionGroupCode
                ? `${workCenter.productionGroupCode} · ${workCenter.productionGroupName}`
                : "—";
            case "weekScheduleId": {
              if (isEditing) {
                // Schedule and factor stack in the 140px cell — side by side
                // they'd spill into Timkostnad.
                return (
                  <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <Select
                      value={draft.weekScheduleId}
                      onChange={(e) => update("weekScheduleId", e.target.value)}
                      onKeyDown={keys}
                      aria-label={`Veckoschema för ${workCenter.name}`}
                      style={{ width: "100%" }}
                    >
                      <option value="">— Inget —</option>
                      {weekSchedules.map((schedule) => (
                        <option key={schedule.id} value={schedule.id}>
                          {schedule.code} · {schedule.name}
                        </option>
                      ))}
                    </Select>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)" }}>
                      ×
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        size="xs"
                        value={draft.capacityFactor}
                        onChange={(e) => update("capacityFactor", e.target.value)}
                        onKeyDown={keys}
                        aria-label={`Kapacitetsfaktor för ${workCenter.name}`}
                      />
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)" }}>
                      <DurationInput
                        size="xs"
                        placeholder="tt:mm"
                        value={draft.hoursPerDay}
                        onValueChange={(value) => update("hoursPerDay", value)}
                        onKeyDown={keys}
                        aria-label={`Kapacitet per dag (tt:mm) för ${workCenter.name}`}
                      />
                      tt:mm/dag
                    </span>
                  </span>
                );
              }
              const factor = Number(workCenter.capacityFactor);
              // The schedule wins; hours per day show only without one.
              const capacity =
                workCenter.weekScheduleCode ??
                (workCenter.hoursPerDay != null ? `${Number(workCenter.hoursPerDay).toLocaleString("sv-SE")} h/dag` : "—");
              return (
                <>
                  {capacity}
                  {factor !== 1 && <span style={{ opacity: 0.7 }}> ×{factor}</span>}
                </>
              );
            }
            case "hourlyRate":
              if (isEditing) {
                return (
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    size="xs"
                    value={draft.hourlyRate}
                    onChange={(e) => update("hourlyRate", e.target.value)}
                    onKeyDown={keys}
                    autoFocus
                    aria-label={`Timkostnad för ${workCenter.name}`}
                  />
                );
              }
              return `${Number(workCenter.hourlyRate).toFixed(2)} SEK`;
            case "overheadPercent":
              if (isEditing) {
                return (
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    size="xs"
                    value={draft.overheadPercent}
                    onChange={(e) => update("overheadPercent", e.target.value)}
                    onKeyDown={keys}
                    aria-label={`TO-påslag för ${workCenter.name}`}
                  />
                );
              }
              return `${Number(workCenter.overheadPercent).toFixed(2)} %`;
            case "active":
              return workCenter.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            case "id":
              return isEditing ? (
                <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => saveEdit(workCenter)}>
                    {pending ? "Sparar…" : "Spara"}
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={cancelEdit}>
                    Avbryt
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={editingId !== null}
                  onClick={() => startEdit(workCenter)}
                >
                  Ändra
                </Button>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny resurs">
        <NewWorkCenterForm
          allWorkCenters={allWorkCenters}
          groups={groups}
          weekSchedules={weekSchedules}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <NewWorkCenterForm
            workCenter={editing}
            allWorkCenters={allWorkCenters}
            groups={groups}
            weekSchedules={weekSchedules}
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
