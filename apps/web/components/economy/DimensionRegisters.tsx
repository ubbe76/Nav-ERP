"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { confirmDelete } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { PROJECT_STATUS_LABELS } from "../../lib/types";
import type { CostCenter, Project, ProjectStatus, RegisterUsage } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

// Ekonomi → Kostnadsställen / Projekt: the two dimension registers. Both
// behave like the grunddata registers: a code that is unique, rename and
// inactivate freely, and delete with "move the references first" when the
// entry is used (GET …/usage, DELETE with replacementId).

type Entry = { id: string; code: string; name: string; active: boolean };

interface DeleteMoveProps<T extends Entry> {
  basePath: string;
  entry: T;
  others: T[];
  singular: string;
  onDone: () => void;
  onError: (message: string | null) => void;
}

// Booked verification rows and locked documents (issued invoices, attested
// supplier invoices, closed orders) are immutable, so an entry they carry can
// never be moved or deleted — only deactivated. The usage flags such a
// reference with blocksReplacement.
const hasLockedReferences = (usage: RegisterUsage) => usage.references.some((ref) => ref.blocksReplacement === true);

// The delete button of an edit dialog; swaps the dialog for the move step
// when something still points at the entry.
function useDeleteWithMove<T extends Entry>({ basePath, entry, others, singular, onDone, onError }: DeleteMoveProps<T>) {
  const [usage, setUsage] = useState<RegisterUsage | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [pending, setPending] = useState(false);
  // The move/deactivate step replaces the dialog's form, so its errors are
  // shown inside it (the parent's error line is hidden meanwhile).
  const [stepError, setStepError] = useState<string | null>(null);

  async function start() {
    onError(null);
    setPending(true);
    try {
      const result = await apiFetch<RegisterUsage>(`${basePath}/${entry.id}/usage`);
      if (result.total === 0) {
        if (await confirmDelete(`Ta bort ${entry.name}?`)) {
          await apiFetch(`${basePath}/${entry.id}`, { method: "DELETE" });
          onDone();
        }
      } else {
        setUsage(result);
      }
    } catch (err) {
      onError(apiErrorMessage(err, `Kunde inte ta bort ${singular}`));
    } finally {
      setPending(false);
    }
  }

  async function deactivate() {
    setStepError(null);
    setPending(true);
    try {
      await apiFetch(`${basePath}/${entry.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
      onDone();
    } catch (err) {
      setStepError(apiErrorMessage(err, `Kunde inte inaktivera ${singular}`));
      setPending(false);
    }
  }

  async function move(e: FormEvent) {
    e.preventDefault();
    if (!replacementId) return;
    setStepError(null);
    setPending(true);
    try {
      await apiFetch(`${basePath}/${entry.id}?replacementId=${encodeURIComponent(replacementId)}`, {
        method: "DELETE",
        body: JSON.stringify({ replacementId }),
      });
      onDone();
    } catch (err) {
      setStepError(apiErrorMessage(err, `Kunde inte flytta och ta bort ${singular}`));
      setPending(false);
    }
  }

  const booked = usage ? hasLockedReferences(usage) : false;

  const moveForm = usage ? (
    <Form onSubmit={move}>
      <FormError>{stepError}</FormError>
      <h3 style={{ margin: "0 0 4px", font: "inherit", fontWeight: 600, fontSize: 15 }}>Ta bort {entry.name}</h3>
      <p style={{ margin: 0, fontFamily: "var(--font-body)", fontSize: 13 }}>Posten används av:</p>
      <ul style={{ margin: "0 0 4px", paddingLeft: 20, fontFamily: "var(--font-body)", fontSize: 13 }}>
        {usage.references.map((ref) => (
          <li key={`${ref.table}:${ref.label}`}>
            {ref.count} {ref.count === 1 ? ref.labelOne : ref.label}
          </li>
        ))}
      </ul>
      {booked ? (
        <FormHint>
          {entry.name} används på bokförda verifikat eller låsta dokument. Bokföringen kan inte ändras, så posten kan inte tas bort eller flyttas —{" "}
          {entry.active ? "inaktivera den i stället." : "den är redan inaktiv och kan inte väljas på nya rader."}
        </FormHint>
      ) : others.length > 0 ? (
        <>
          <Field label="Flytta kopplingarna till" htmlFor="dimensionReplacement">
            <Select id="dimensionReplacement" required value={replacementId} onChange={(e) => setReplacementId(e.target.value)}>
              <option value="">— Välj —</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} · {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <FormHint>
            Alla kopplade verifikatrader, fakturor och order flyttas till den valda posten; därefter tas {entry.name} bort. Du kan
            i stället inaktivera posten.
          </FormHint>
        </>
      ) : (
        <FormHint>Lägg först till den post kopplingarna ska flyttas till — eller inaktivera posten i stället.</FormHint>
      )}
      <FormActions>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => { setUsage(null); setStepError(null); }}>
          Avbryt
        </Button>
        {booked && entry.active && (
          <Button type="button" variant="primary" disabled={pending} onClick={() => void deactivate()}>
            {pending ? "Inaktiverar…" : "Inaktivera"}
          </Button>
        )}
        {!booked && others.length > 0 && (
          <Button type="submit" variant="primary" disabled={pending || !replacementId}>
            {pending ? "Tar bort…" : "Flytta och ta bort"}
          </Button>
        )}
      </FormActions>
    </Form>
  ) : null;

  return { start, moveForm, pending };
}

const linkButton = { background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" } as const;

// ---------------------------------------------------------------------------
// Kostnadsställen
// ---------------------------------------------------------------------------

export function KostnadsstallenPageClient({ costCenters }: { costCenters: CostCenter[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CostCenter | null>(null);
  const active = costCenters.filter((c) => c.active).length;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kostnadsställen</div>
          <div className={shellStyles.meta}>
            {costCenters.length.toLocaleString("sv-SE")} kostnadsställen, {active.toLocaleString("sv-SE")} aktiva
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Nytt kostnadsställe
          </Button>
          <HelpLink chapter="ekonomi" anchor="kostnadsstallen-och-projekt" label="Hjälp om kostnadsställen" />
        </div>
      </div>

      <Table<CostCenter>
        columns={[
          { key: "code", label: "Kod", width: "120px" },
          { key: "name", label: "Namn", width: "2fr" },
          { key: "status", label: "Status", width: "100px" },
        ]}
        rows={costCenters}
        emptyText="Inga kostnadsställen ännu — lägg till avdelningar som verkstad, montering eller kontor."
        renderCell={(c, key) => {
          switch (key) {
            case "code":
              return c.code;
            case "name":
              return (
                <button type="button" onClick={() => setEditing(c)} style={linkButton}>
                  <strong>{c.name}</strong>
                </button>
              );
            case "status":
              return <StatusPill status={c.active ? "running" : "draft"} label={c.active ? "Aktivt" : "Inaktivt"} compact />;
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt kostnadsställe">
        <CostCenterForm
          costCenters={costCenters}
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <CostCenterForm
            key={editing.id}
            costCenter={editing}
            costCenters={costCenters}
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

function CostCenterForm({
  costCenter,
  costCenters,
  onDone,
}: {
  costCenter?: CostCenter;
  costCenters: CostCenter[];
  onDone: () => void;
}) {
  const [code, setCode] = useState(costCenter?.code ?? "");
  const [name, setName] = useState(costCenter?.name ?? "");
  const [active, setActive] = useState(costCenter?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const del = useDeleteWithMove<CostCenter>({
    basePath: "/api/v1/cost-centers",
    entry: costCenter ?? { id: "", code: "", name: "", active: true },
    others: costCenters.filter((c) => c.id !== costCenter?.id && c.active),
    singular: "kostnadsstället",
    onDone,
    onError: setError,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (costCenter) {
        await apiFetch(`/api/v1/cost-centers/${costCenter.id}`, {
          method: "PATCH",
          body: JSON.stringify({ code: code.trim(), name: name.trim(), active }),
        });
      } else {
        await apiFetch("/api/v1/cost-centers", { method: "POST", body: JSON.stringify({ code: code.trim(), name: name.trim() }) });
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara kostnadsstället"));
      setPending(false);
    }
  }

  if (del.moveForm) return <>{del.moveForm}</>;

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Kod" htmlFor="costCenterCode">
        <Input id="costCenterCode" size="md" required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Namn" htmlFor="costCenterName">
        <Input id="costCenterName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {costCenter && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktivt
        </label>
      )}
      <FormHint>Koden blir objektkoden i SIE-filen (dimension 1). Inaktiva kostnadsställen kan inte väljas på nya rader.</FormHint>
      <FormActions style={{ justifyContent: costCenter ? "space-between" : "flex-end" }}>
        {costCenter && (
          <Button type="button" variant="danger" disabled={pending || del.pending} onClick={() => void del.start()}>
            {del.pending ? "Kontrollerar…" : "Ta bort"}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending || del.pending}>
          {pending ? "Sparar…" : costCenter ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Projekt
// ---------------------------------------------------------------------------

export function ProjektPageClient({
  projects,
  customers,
}: {
  projects: Project[];
  customers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const open = projects.filter((p) => p.status === "open").length;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Projekt</div>
          <div className={shellStyles.meta}>
            {projects.length.toLocaleString("sv-SE")} projekt, {open.toLocaleString("sv-SE")} öppna
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Nytt projekt
          </Button>
          <HelpLink chapter="ekonomi" anchor="kostnadsstallen-och-projekt" label="Hjälp om projekt" />
        </div>
      </div>

      <Table<Project>
        columns={[
          { key: "code", label: "Kod", width: "110px" },
          { key: "name", label: "Namn", width: "2fr" },
          { key: "customer", label: "Kund", width: "1.4fr" },
          { key: "start", label: "Start", width: "100px" },
          { key: "end", label: "Slut", width: "100px" },
          { key: "status", label: "Status", width: "100px" },
        ]}
        rows={projects}
        emptyText="Inga projekt ännu — lägg till ett projekt att följa intäkter och kostnader per."
        renderCell={(p, key) => {
          switch (key) {
            case "code":
              return p.code;
            case "name":
              return (
                <button type="button" onClick={() => setEditing(p)} style={linkButton}>
                  <strong>{p.name}</strong>
                </button>
              );
            case "customer":
              return p.customerName ?? "—";
            case "start":
              return p.startDate ?? "—";
            case "end":
              return p.endDate ?? "—";
            case "status":
              return (
                <StatusPill
                  status={!p.active ? "draft" : p.status === "open" ? "running" : "done"}
                  label={!p.active ? "Inaktivt" : PROJECT_STATUS_LABELS[p.status]}
                  compact
                />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt projekt">
        <ProjectForm
          projects={projects}
          customers={customers}
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <ProjectForm
            key={editing.id}
            project={editing}
            projects={projects}
            customers={customers}
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

function ProjectForm({
  project,
  projects,
  customers,
  onDone,
}: {
  project?: Project;
  projects: Project[];
  customers: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [code, setCode] = useState(project?.code ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [customerId, setCustomerId] = useState(project?.customerId ?? "");
  const [startDate, setStartDate] = useState(project?.startDate ?? "");
  const [endDate, setEndDate] = useState(project?.endDate ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "open");
  const [active, setActive] = useState(project?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const del = useDeleteWithMove<Project>({
    basePath: "/api/v1/projects",
    entry: project ?? { id: "", code: "", name: "", active: true, status: "open", customerId: null, customerName: null, startDate: null, endDate: null },
    others: projects.filter((p) => p.id !== project?.id && p.active && p.status === "open"),
    singular: "projektet",
    onDone,
    onError: setError,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (startDate && endDate && endDate < startDate) {
      setError("Slutdatum kan inte vara före startdatum.");
      return;
    }
    setPending(true);
    try {
      const body = {
        code: code.trim(),
        name: name.trim(),
        customerId: customerId || null,
        startDate: startDate || null,
        endDate: endDate || null,
        status,
        ...(project ? { active } : {}),
      };
      if (project) {
        await apiFetch(`/api/v1/projects/${project.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await apiFetch("/api/v1/projects", { method: "POST", body: JSON.stringify(body) });
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara projektet"));
      setPending(false);
    }
  }

  if (del.moveForm) return <>{del.moveForm}</>;

  // A customer that is no longer in the list (archived) stays selectable.
  const customerMissing = customerId !== "" && !customers.some((c) => c.id === customerId);

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Kod" htmlFor="projectCode">
        <Input id="projectCode" size="md" required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Namn" htmlFor="projectName">
        <Input id="projectName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Kund (valfritt)" htmlFor="projectCustomer">
        <Select id="projectCustomer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">— Ingen kund —</option>
          {customerMissing && <option value={customerId}>{project?.customerName ?? "(okänd kund)"}</option>}
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <FormRow columns={2}>
        <Field label="Start (valfritt)" htmlFor="projectStart">
          <Input id="projectStart" type="date" size="sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Slut (valfritt)" htmlFor="projectEnd">
          <Input id="projectEnd" type="date" size="sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
      </FormRow>
      <Field label="Status" htmlFor="projectStatus">
        <Select id="projectStatus" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
          <option value="open">{PROJECT_STATUS_LABELS.open}</option>
          <option value="closed">{PROJECT_STATUS_LABELS.closed}</option>
        </Select>
      </Field>
      <FormHint>
        Ett stängt projekt kan inte väljas på nya rader, men finns kvar på det som redan bokats. Koden blir objektkoden i SIE-filen
        (dimension 6).
      </FormHint>
      {project && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktivt
        </label>
      )}
      <FormActions style={{ justifyContent: project ? "space-between" : "flex-end" }}>
        {project && (
          <Button type="button" variant="danger" disabled={pending || del.pending} onClick={() => void del.start()}>
            {del.pending ? "Kontrollerar…" : "Ta bort"}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending || del.pending}>
          {pending ? "Sparar…" : project ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}
