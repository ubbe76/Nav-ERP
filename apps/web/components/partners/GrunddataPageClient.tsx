"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import fieldStyles from "../ui/Field.module.css";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { RegisterEntry, RegisterUsage } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import tabStyles from "./PartnerTabs.module.css";
import { HelpLink } from "../ui/HelpLink";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import type { AccessRule } from "../../lib/permissions";

const TABS = [
  "Leveransvillkor",
  "Betalningsvillkor",
  "Speditörer",
  "Enheter",
  "Kollityper",
  "Förlustorsaker",
  "Kvalitetsorsaker",
] as const;
type Tab = (typeof TABS)[number];

// Kvalitetsorsaker: which kinds of case (and the kassation) a reason can be
// chosen for. The API wants at least one of them.
const REASON_FLAGS = [
  { key: "appliesCustomer", label: "Kund" },
  { key: "appliesSupplier", label: "Leverantör" },
  { key: "appliesInternal", label: "Intern" },
  { key: "appliesScrap", label: "Kassation" },
] as const;
type ReasonFlagKey = (typeof REASON_FLAGS)[number]["key"];

const TAB_CONFIG: Record<
  Tab,
  {
    basePath: string;
    singular: string;
    seed?: { label: string; path: string };
    showDescription?: boolean;
    // Förlustorsaker: Aktiv flag, upper-case codes of at most 10 characters.
    showActive?: boolean;
    activeHint?: string;
    // Kvalitetsorsaker: the Kund/Leverantör/Intern/Kassation checkboxes.
    showReasonFlags?: boolean;
    // Writes are the Kvalitet permission's, deleting is the administrator's.
    writeRule?: AccessRule;
    deleteRule?: AccessRule;
    moveHint?: string;
  }
> = {
  Leveransvillkor: {
    basePath: "/api/v1/delivery-terms",
    singular: "leveransvillkor",
    seed: { label: "Förifyll Combiterms", path: "/api/v1/delivery-terms/generate-combiterms" },
    // The description column exists on every register in the API; it is only
    // surfaced where it carries meaning — the Combiterms explanations here.
    showDescription: true,
  },
  Betalningsvillkor: { basePath: "/api/v1/payment-terms", singular: "betalningsvillkor" },
  Speditörer: { basePath: "/api/v1/carriers", singular: "speditör" },
  Enheter: {
    basePath: "/api/v1/units",
    singular: "enhet",
    seed: { label: "Lägg till standardenheter", path: "/api/v1/units/generate-standard" },
  },
  Kollityper: {
    basePath: "/api/v1/package-types",
    singular: "kollityp",
    seed: { label: "Lägg till standardkollityper", path: "/api/v1/package-types/generate-standard" },
  },
  Förlustorsaker: {
    basePath: "/api/v1/quote-loss-reasons",
    singular: "förlustorsak",
    showActive: true,
    activeHint: "Inaktiva orsaker kan inte väljas när en offert markeras som förlorad.",
  },
  Kvalitetsorsaker: {
    basePath: "/api/v1/deviation-reasons",
    singular: "kvalitetsorsak",
    showActive: true,
    activeHint: "Inaktiva orsaker kan inte väljas på nya avvikelser eller kassationer.",
    showReasonFlags: true,
    writeRule: ["kvalitet"],
    deleteRule: ["admin"],
    moveHint: "Alla kopplade avvikelser och kassationer flyttas till den valda orsaken; därefter tas orsaken bort.",
  },
};

export function GrunddataPageClient({
  deliveryTerms,
  paymentTerms,
  carriers,
  units,
  packageTypes,
  lossReasons,
  deviationReasons,
}: {
  deliveryTerms: RegisterEntry[];
  paymentTerms: RegisterEntry[];
  carriers: RegisterEntry[];
  units: RegisterEntry[];
  packageTypes: RegisterEntry[];
  lossReasons: RegisterEntry[];
  deviationReasons: RegisterEntry[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>("Leveransvillkor");
  const entriesByTab: Record<Tab, RegisterEntry[]> = {
    Leveransvillkor: deliveryTerms,
    Betalningsvillkor: paymentTerms,
    Speditörer: carriers,
    Enheter: units,
    Kollityper: packageTypes,
    Förlustorsaker: lossReasons,
    Kvalitetsorsaker: deviationReasons,
  };

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Grunddata</div>
          <div className={shellStyles.meta}>Leveransvillkor, betalningsvillkor, speditörer, enheter, kollityper, förlustorsaker och kvalitetsorsaker</div>
        </div>
        <HelpLink chapter="grunddata" label="Hjälp om grunddata" />
      </div>

      <div className={tabStyles.tabStrip}>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={tabStyles.tab}
            data-active={tab === activeTab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      <RegisterTab key={activeTab} tab={activeTab} entries={entriesByTab[activeTab]} />
    </>
  );
}

// Also used on its own by /kvalitet/orsaker (the Kvalitetsorsaker register
// opened from the Kvalitet menu).
export function RegisterTab({ tab, entries }: { tab: Tab; entries: RegisterEntry[] }) {
  const router = useRouter();
  const can = useCan();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RegisterEntry | null>(null);
  const [freightEditing, setFreightEditing] = useState<RegisterEntry | null>(null);
  const [seedNotice, setSeedNotice] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const { basePath, singular, seed, showDescription, showActive, activeHint, showReasonFlags, writeRule, deleteRule, moveHint } =
    TAB_CONFIG[tab];
  const canWrite = writeRule ? can(writeRule) : true;
  const canDelete = deleteRule ? can(deleteRule) : true;

  async function runSeed() {
    if (!seed) return;
    setSeeding(true);
    setSeedNotice(null);
    try {
      const result = await apiFetch<{ created: number; skipped: number }>(seed.path, { method: "POST" });
      setSeedNotice(
        result.created === 0
          ? "Alla poster fanns redan"
          : `${result.created} skapade${result.skipped > 0 ? `, ${result.skipped} fanns redan` : ""}`
      );
      router.refresh();
    } catch (err) {
      setSeedNotice(err instanceof Error ? err.message : "Kunde inte förifylla");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginBottom: 14 }}>
        {seedNotice && (
          <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--color-text-secondary)" }}>
            {seedNotice}
          </span>
        )}
        {seed && (
          <Button type="button" variant="secondary" disabled={seeding} onClick={runSeed}>
            {seeding ? "Förifyller…" : seed.label}
          </Button>
        )}
        {canWrite && (
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny {singular}
          </Button>
        )}
      </div>

      <Table<RegisterEntry>
        columns={[
          { key: "code", label: "Kod", width: "0.4fr" },
          { key: "name", label: "Benämning", width: "2fr" },
          ...(showDescription ? [{ key: "description", label: "Förklaring", width: "3fr" }] : []),
          ...(tab === "Kollityper" ? [{ key: "freight", label: "Frakt", width: "2fr" }] : []),
          ...(showReasonFlags ? REASON_FLAGS.map((f) => ({ key: f.key, label: f.label, width: "0.5fr" })) : []),
          ...(showActive ? [{ key: "active", label: "Status", width: "0.6fr" }] : []),
        ]}
        rows={entries}
        emptyText={`Inga ${tab.toLowerCase()} registrerade`}
        renderCell={(entry, key) => {
          switch (key) {
            case "code":
              return entry.code;
            case "name":
              if (!canWrite) return <strong>{entry.name}</strong>;
              return (
                <button
                  type="button"
                  onClick={() => setEditing(entry)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}
                >
                  <strong>{entry.name}</strong>
                </button>
              );
            case "description":
              return entry.description ?? "—";
            case "active":
              return entry.active === false ? "Inaktiv" : "Aktiv";
            case "freight":
              return (
                <button
                  type="button"
                  onClick={() => setFreightEditing(entry)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--accent-fg)" }}
                >
                  {freightSummary(entry)}
                </button>
              );
            default:
              if (showReasonFlags && REASON_FLAGS.some((f) => f.key === key)) {
                return entry[key as ReasonFlagKey] ? "Ja" : "–";
              }
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={`Ny ${singular}`}>
        <RegisterEntryForm
          basePath={basePath}
          showDescription={showDescription}
          showActive={showActive}
          activeHint={activeHint}
          showReasonFlags={showReasonFlags}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <RegisterEntryForm
            basePath={basePath}
            entry={editing}
            entries={entries}
            singular={singular}
            showDescription={showDescription}
            showActive={showActive}
            activeHint={activeHint}
            showReasonFlags={showReasonFlags}
            canDelete={canDelete}
            moveHint={moveHint}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>

      <Modal open={freightEditing !== null} onClose={() => setFreightEditing(null)} title={freightEditing ? `Fraktuppgifter — ${freightEditing.name}` : ""}>
        {freightEditing && (
          <PackageTypeFreightForm
            entry={freightEditing}
            onSuccess={() => {
              setFreightEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

const cm = (mm: string | null | undefined) => (mm ? String(Number(mm) / 10) : "–");
function freightSummary(e: RegisterEntry): string {
  const kind = e.parcelKind === "pallet" ? "Pall" : "Paket";
  const tare = e.tareWeight ? `, ${Number(e.tareWeight).toLocaleString("sv-SE")} kg` : "";
  return `${kind} ${cm(e.lengthMm)}×${cm(e.widthMm)}×${cm(e.heightMm)} cm${tare}`;
}

function PackageTypeFreightForm({ entry, onSuccess }: { entry: RegisterEntry; onSuccess: () => void }) {
  const [parcelKind, setParcelKind] = useState(entry.parcelKind === "pallet" ? "pallet" : "package");
  const [lengthMm, setLengthMm] = useState(entry.lengthMm ?? "");
  const [widthMm, setWidthMm] = useState(entry.widthMm ?? "");
  const [heightMm, setHeightMm] = useState(entry.heightMm ?? "");
  const [tareWeight, setTareWeight] = useState(entry.tareWeight ?? "");
  const [stackable, setStackable] = useState(entry.stackable ?? false);
  const [loadingMeters, setLoadingMeters] = useState(entry.loadingMeters ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/package-types/${entry.id}/freight`, {
        method: "PATCH",
        body: JSON.stringify({
          parcelKind,
          lengthMm: num(lengthMm),
          widthMm: num(widthMm),
          heightMm: num(heightMm),
          tareWeight: num(tareWeight),
          stackable,
          loadingMeters: num(loadingMeters),
        }),
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara fraktuppgifterna"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Kolliart" htmlFor="ptKind">
        <Select id="ptKind" value={parcelKind} onChange={(e) => setParcelKind(e.target.value)}>
          <option value="package">Paket</option>
          <option value="pallet">Pall</option>
        </Select>
      </Field>
      <Field label="Längd (mm)" htmlFor="ptLength">
        <Input id="ptLength" type="number" size="xs" min="0" step="any" value={lengthMm} onChange={(e) => setLengthMm(e.target.value)} />
      </Field>
      <Field label="Bredd (mm)" htmlFor="ptWidth">
        <Input id="ptWidth" type="number" size="xs" min="0" step="any" value={widthMm} onChange={(e) => setWidthMm(e.target.value)} />
      </Field>
      <Field label="Höjd (mm)" htmlFor="ptHeight">
        <Input id="ptHeight" type="number" size="xs" min="0" step="any" value={heightMm} onChange={(e) => setHeightMm(e.target.value)} />
      </Field>
      <Field label="Egenvikt (kg)" htmlFor="ptTare">
        <Input id="ptTare" type="number" size="xs" min="0" step="any" value={tareWeight} onChange={(e) => setTareWeight(e.target.value)} />
      </Field>
      <Field label="Flakmeter" htmlFor="ptLdm">
        <Input id="ptLdm" type="number" size="xs" min="0" step="any" value={loadingMeters} onChange={(e) => setLoadingMeters(e.target.value)} />
      </Field>
      <FormHint>Tomt = transportören räknar flakmeter från måtten.</FormHint>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
        Stapelbar
      </label>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}

// Creates a register entry, or renames/deletes one when `entry` is passed.
// `entries`/`singular` are only needed for the delete-with-reassignment step
// (create mode never offers deletion, so they're optional there).
function RegisterEntryForm({
  basePath,
  entry,
  entries,
  singular,
  showDescription,
  showActive,
  activeHint,
  showReasonFlags,
  canDelete = true,
  moveHint,
  onSuccess,
}: {
  basePath: string;
  entry?: RegisterEntry;
  entries?: RegisterEntry[];
  singular?: string;
  showDescription?: boolean;
  showActive?: boolean;
  activeHint?: string;
  showReasonFlags?: boolean;
  canDelete?: boolean;
  moveHint?: string;
  onSuccess: () => void;
}) {
  const [code, setCode] = useState(entry?.code ?? "");
  const [name, setName] = useState(entry?.name ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [active, setActive] = useState(entry?.active ?? true);
  const [flags, setFlags] = useState<Record<ReasonFlagKey, boolean>>({
    appliesCustomer: entry?.appliesCustomer ?? false,
    appliesSupplier: entry?.appliesSupplier ?? false,
    appliesInternal: entry?.appliesInternal ?? false,
    appliesScrap: entry?.appliesScrap ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // "move" is the reassignment step shown when the entry is still referenced
  // — deletion is blocked (409 register-entry-in-use) until the caller picks
  // a replacement for every reference to move onto first.
  const [mode, setMode] = useState<"edit" | "move">("edit");
  const [usage, setUsage] = useState<RegisterUsage | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [actionPending, setActionPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // Tabs without the description concept keep their wire format unchanged;
      // an emptied field is stored as null so the table's "—" stays honest.
      const body = JSON.stringify(
        showDescription
          ? { code, name, description: description.trim() || null }
          : showReasonFlags
            ? { code: code.trim().toUpperCase(), name, active, ...flags }
            : showActive
              ? { code: code.trim().toUpperCase(), name, active }
              : { code, name }
      );
      if (entry) {
        await apiFetch(`${basePath}/${entry.id}`, { method: "PATCH", body });
      } else {
        await apiFetch(basePath, { method: "POST", body });
      }
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara"));
      setPending(false);
    }
  }

  async function handleDeleteClick() {
    if (!entry) return;
    setError(null);
    setActionPending(true);
    try {
      const result = await apiFetch<RegisterUsage>(`${basePath}/${entry.id}/usage`);
      if (result.total === 0) {
        if (await confirmDelete(`Ta bort ${entry.name}?`)) {
          await apiFetch(`${basePath}/${entry.id}`, { method: "DELETE" });
          onSuccess();
          return;
        }
      } else {
        setUsage(result);
        setMode("move");
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort posten"));
    } finally {
      setActionPending(false);
    }
  }

  async function handleMoveSubmit(e: FormEvent) {
    e.preventDefault();
    if (!entry || !replacementId) return;
    setError(null);
    setActionPending(true);
    try {
      await apiFetch(`${basePath}/${entry.id}`, {
        method: "DELETE",
        body: JSON.stringify({ replacementId }),
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte flytta och ta bort posten"));
      setActionPending(false);
    }
  }

  if (mode === "move" && entry) {
    const otherEntries = (entries ?? []).filter((e) => e.id !== entry.id);
    return (
      <Form onSubmit={handleMoveSubmit}>
        <h3 style={{ margin: "0 0 4px", font: "inherit", fontWeight: 600, fontSize: 15 }}>Ta bort {entry.name}</h3>
        <FormError>{error}</FormError>

        <p style={{ margin: 0, fontFamily: "var(--font-body)", fontSize: 13 }}>Posten används av:</p>
        <ul style={{ margin: "0 0 4px", paddingLeft: 20, fontFamily: "var(--font-body)", fontSize: 13 }}>
          {usage?.references.map((ref) => (
            <li key={`${ref.table}:${ref.label}`}>
              {ref.count} {ref.count === 1 ? ref.labelOne : ref.label}
            </li>
          ))}
        </ul>

        {otherEntries.length > 0 ? (
          <>
            <Field label="Flytta kopplingarna till" htmlFor="registerReplacement">
              <Select
                id="registerReplacement"
                required
                value={replacementId}
                onChange={(e) => setReplacementId(e.target.value)}
              >
                <option value="">— Välj —</option>
                {otherEntries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} · {e.name}
                  </option>
                ))}
              </Select>
            </Field>
            <FormHint>
              {moveHint ??
                `Alla kopplade kunder, leverantörer och dokument flyttas till den valda posten; därefter tas ${entry.name} bort.`}
            </FormHint>
          </>
        ) : (
          <FormHint>Lägg först till den post kopplingarna ska flyttas till.</FormHint>
        )}

        <FormActions>
          <Button
            type="button"
            variant="secondary"
            disabled={actionPending}
            onClick={() => {
              setError(null);
              setMode("edit");
            }}
          >
            Avbryt
          </Button>
          {otherEntries.length > 0 && (
            <Button type="submit" variant="primary" disabled={actionPending || !replacementId}>
              {actionPending ? "Tar bort…" : "Flytta och ta bort"}
            </Button>
          )}
        </FormActions>
      </Form>
    );
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Kod" htmlFor="registerCode">
        <Input
          id="registerCode"
          size="md"
          required
          maxLength={showActive ? 10 : 20}
          value={code}
          onChange={(e) => setCode(showActive ? e.target.value.toUpperCase() : e.target.value)}
        />
      </Field>

      <Field label="Benämning" htmlFor="registerName">
        <Input id="registerName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {showActive && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktiv
        </label>
      )}
      {showActive && activeHint && <FormHint>{activeHint}</FormHint>}

      {showReasonFlags && (
        <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <legend style={{ fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 600, padding: 0, marginBottom: 6 }}>
            Gäller för
          </legend>
          {REASON_FLAGS.map((flag) => (
            <label key={flag.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Checkbox
                checked={flags[flag.key]}
                onChange={(e) => setFlags((prev) => ({ ...prev, [flag.key]: e.target.checked }))}
              />
              {flag.label}
            </label>
          ))}
          <FormHint>
            Kund, Leverantör och Intern styr vilka avvikelser orsaken kan väljas på. Kassation gör den valbar när
            kasserat antal rapporteras.
          </FormHint>
        </fieldset>
      )}

      {showDescription && (
        <Field label="Förklaring (valfritt)" htmlFor="registerDescription">
          <textarea
            id="registerDescription"
            rows={2}
            maxLength={300}
            className={fieldStyles.input}
            style={{ resize: "vertical" }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      )}

      <FormActions style={{ justifyContent: entry && canDelete ? "space-between" : "flex-end" }}>
        {entry && canDelete && (
          <Button
            type="button"
            variant="danger"
            disabled={pending || actionPending}
            onClick={handleDeleteClick}
            aria-label={`Ta bort ${singular ?? entry.name}`}
          >
            {actionPending ? "Kontrollerar…" : "Ta bort"}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending || actionPending}>
          {pending ? "Sparar…" : entry ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}
