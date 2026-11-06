"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Checkbox, Field, Input, Select, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useCan } from "../PermissionsProvider";
import { formatQuantity } from "../../lib/format";
import type { BlockLocationResult, StockLocationRegisterRow, Warehouse } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Card } from "../ui/Card";
import { SectionHeading } from "../ui/SectionHeading";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { LabelPrintDialog } from "./LabelPrintDialog";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";

type StockLocation = StockLocationRegisterRow;

// "120 st · 35,5 kg" — one figure per unit, as the API sorts them.
function formatBalances(balances: StockLocation["balances"]): string {
  return balances.map((b) => `${formatQuantity(b.quantity)} ${b.unitCode}`).join(" · ");
}

// Date of the block in Stockholm time (the container may run UTC).
function blockedSince(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

export function LocationsSection({
  locations,
  total,
  pageSize,
  warehouses,
}: {
  locations: StockLocation[];
  total: number;
  pageSize: number;
  warehouses: Warehouse[];
}) {
  const router = useRouter();
  const canWrite = useCan()(["lager"]);
  // Spärra…: the location whose dialog is open, and its note draft.
  const [blocking, setBlocking] = useState<StockLocation | null>(null);
  const [blockNote, setBlockNote] = useState("");
  // The outcome of the last block/release, shown above the table.
  const [notice, setNotice] = useState<string | null>(null);
  const [newBlocked, setNewBlocked] = useState(false);
  const [newBlockedNote, setNewBlockedNote] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Row being edited, and its drafts.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editWarehouseId, setEditWarehouseId] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editFixed, setEditFixed] = useState(true);
  const [fixed, setFixed] = useState(true);
  // Emptied locations are deactivated rather than deleted; the Status filter
  // (Aktiva by default) decides whether they are listed.
  const visibleLocations = locations;
  // Rows ticked for Skriv ut etiketter.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const selectedIds = visibleLocations.filter((l) => selected.has(l.id)).map((l) => l.id);
  const allSelected = visibleLocations.length > 0 && selectedIds.length === visibleLocations.length;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function saveEdit(row: StockLocation) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock/locations/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, warehouseId: editWarehouseId, active: editActive, fixed: editFixed }),
      });
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara lagerplatsen");
    } finally {
      setPending(false);
    }
  }

  async function submitBlock(e: FormEvent) {
    e.preventDefault();
    if (!blocking) return;
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      // A JSON body is required (apiFetch only sets the content type with one).
      const res = await apiFetch<BlockLocationResult>(`/api/v1/stock/locations/${blocking.id}/block`, {
        method: "POST",
        body: JSON.stringify({ note: blockNote.trim() || undefined }),
      });
      const parts = [`${res.location.warehouseName} — ${res.location.name} är spärrad.`];
      if (res.articlesWithStock > 0) {
        parts.push(`${res.articlesWithStock} ${res.articlesWithStock === 1 ? "artikel" : "artiklar"} har saldo där, som inte längre räknas.`);
      }
      if (res.defaultForArticles > 0) {
        parts.push(
          `${res.defaultForArticles} ${res.defaultForArticles === 1 ? "artikel har" : "artiklar har"} platsen som huvudplats. Deras inleveranser går till nästa plats tills spärren släpps.`
        );
      }
      setNotice(parts.join(" "));
      setBlocking(null);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spärra lagerplatsen"));
      setBlocking(null);
    } finally {
      setPending(false);
    }
  }

  async function release(row: StockLocation) {
    const ok = await confirmDialog(
      `Släppa spärren på ${row.warehouseName} — ${row.name}? Saldot räknas igen i behovsberäkningen och kan tas med Automatiskt.`,
      { confirmLabel: "Släpp spärr" }
    );
    if (!ok) return;
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock/locations/${row.id}/unblock`, { method: "POST", body: "{}" });
      setNotice(`Spärren på ${row.warehouseName} — ${row.name} är släppt.`);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte släppa spärren"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <SectionHeading
        actions={
          <>
            {selectedIds.length > 0 && (
              <Button type="button" size="small" variant="secondary" onClick={() => setLabelsOpen(true)}>
                Skriv ut etiketter ({selectedIds.length})
              </Button>
            )}
          </>
        }
      >
        Lagerplatser
      </SectionHeading>
      <FormError>{error}</FormError>
      {notice && <FormNotice>{notice}</FormNotice>}
      <ListToolbar placeholder="Sök lagerplats, lager eller etikettkod…">
        <ListFilterSelect
          param="warehouseId"
          allLabel="Alla lager"
          ariaLabel="Filtrera på lager"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <ListFilterSelect
          param="status"
          allLabel="Aktiva"
          ariaLabel="Filtrera på status"
          options={[
            { value: "inactive", label: "Inaktiva" },
            { value: "all", label: "Alla" },
          ]}
        />
        <ListFilterSelect
          param="blocked"
          allLabel="Alla lagerplatser"
          ariaLabel="Filtrera på spärrade lagerplatser"
          options={[
            { value: "true", label: "Bara spärrade" },
            { value: "false", label: "Utan spärrade" },
          ]}
        />
        <ListExportLink endpoint="/api/v1/stock/locations/register/csv" />
      </ListToolbar>
      {visibleLocations.length > 0 ? (
        <Table<StockLocation>
          columns={[
            {
              key: "select",
              label: "Välj",
              width: "24px",
              header: (
                <SelectAllCheckbox
                  checked={allSelected}
                  indeterminate={selectedIds.length > 0 && !allSelected}
                  ariaLabel="Markera alla lagerplatser"
                  onChange={(on) => setSelected(on ? new Set(visibleLocations.map((l) => l.id)) : new Set())}
                />
              ),
            },
            { key: "warehouseName", label: "Lager", width: "minmax(84px, 1fr)" },
            { key: "name", label: "Namn", width: "minmax(44px, 0.5fr)" },
            { key: "labelCode", label: "Etikettkod", width: "74px" },
            { key: "fixed", label: "Fast", width: "40px" },
            { key: "active", label: "Status", width: "80px" },
            { key: "articleCount", label: "Artiklar", width: "52px", align: "right" },
            { key: "balances", label: "Saldo", width: "minmax(106px, 1fr)", align: "right" },
            { key: "blocked", label: "Spärrad", width: "minmax(84px, 0.6fr)" },
            { key: "id", label: "", width: "max-content", align: "right" },
          ]}
          rows={visibleLocations}
          renderCell={(row, key) => {
            switch (key) {
              case "select":
                return (
                  <Checkbox
                    checked={selected.has(row.id)}
                    onChange={(e) => toggle(row.id, e.target.checked)}
                    aria-label={`Markera ${row.labelCode}`}
                  />
                );
              case "warehouseName":
                return editingId === row.id ? (
                  <Select value={editWarehouseId} onChange={(e) => setEditWarehouseId(e.target.value)} aria-label="Lager">
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  row.warehouseName
                );
              case "name":
                return editingId === row.id ? (
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus style={{ maxWidth: 180 }} />
                ) : (
                  row.name
                );
              case "fixed":
                return editingId === row.id ? (
                  <Checkbox checked={editFixed} onChange={(e) => setEditFixed(e.target.checked)} aria-label="Fast lagerplats" />
                ) : row.fixed ? (
                  "Ja"
                ) : (
                  "Nej"
                );
              case "active":
                return editingId === row.id ? (
                  <Toggle checked={editActive} onChange={(e) => setEditActive(e.target.checked)} aria-label="Aktiv" />
                ) : row.active ? (
                  <StatusPill status="running" label="Aktiv" compact />
                ) : (
                  <StatusPill status="draft" label="Inaktiv" compact />
                );
              case "articleCount":
                return row.articleCount;
              case "balances":
                return row.balances.length > 0 ? <span style={{ whiteSpace: "nowrap" }}>{formatBalances(row.balances)}</span> : "—";
              case "blocked":
                return row.blocked ? (
                  <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                    <span>
                      <StatusPill status="stopped" label="Spärrad" compact />
                      {row.blockedNote ? ` ${row.blockedNote}` : ""}
                    </span>
                    {row.blockedAt && (
                      <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>sedan {blockedSince(row.blockedAt)}</span>
                    )}
                  </span>
                ) : (
                  "—"
                );
              case "id":
                return editingId === row.id ? (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => saveEdit(row)}>
                      Spara
                    </Button>
                    <Button type="button" size="small" variant="ghost" onClick={() => setEditingId(null)}>
                      Avbryt
                    </Button>
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 4, justifyContent: "flex-end", whiteSpace: "nowrap" }}>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      onClick={() => {
                        setEditingId(row.id);
                        setEditName(row.name);
                        setEditWarehouseId(row.warehouseId);
                        setEditActive(row.active);
                        setEditFixed(row.fixed);
                      }}
                    >
                      Ändra
                    </Button>
                    <Link href={`/lager/saldon?locationId=${row.id}`} style={{ alignSelf: "center" }}>
                      Visa saldon
                    </Link>
                    {canWrite && row.blocked && (
                      <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => release(row)}>
                        Släpp spärr
                      </Button>
                    )}
                    {canWrite && !row.blocked && row.name !== "***" && (
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        onClick={() => {
                          setBlocking(row);
                          setBlockNote("");
                        }}
                      >
                        Spärra…
                      </Button>
                    )}
                  </span>
                );
              case "labelCode":
                return row.labelCode;
              default:
                return null;
            }
          }}
        />
      ) : (
        <p>Inga lagerplatser matchar sökningen.</p>
      )}
      <Pagination total={total} pageSize={pageSize} />

      <Modal open={blocking !== null} onClose={() => setBlocking(null)} title="Spärra lagerplats" compact>
        <Form onSubmit={submitBlock}>
          <p>
            {blocking ? `${blocking.warehouseName} — ${blocking.name}` : ""}
          </p>
          <Field label="Anteckning" htmlFor="blockNote">
            <Input
              id="blockNote"
              value={blockNote}
              maxLength={200}
              onChange={(e) => setBlockNote(e.target.value)}
              placeholder="T.ex. Karantän, väntar på kontroll"
              autoFocus
            />
          </Field>
          <FormHint>
            Saldo på en spärrad lagerplats räknas inte i behovsberäkningen, Materialbrist och Leveranstidskontrollen och
            tas aldrig med Automatiskt. Det värderas som vanligt.{" "}
            <HelpLink chapter="lager" anchor="sparrade-lagerplatser" label="Hjälp om spärrade lagerplatser" />
          </FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              Spärra
            </Button>
            <Button type="button" variant="ghost" onClick={() => setBlocking(null)}>
              Avbryt
            </Button>
          </FormActions>
        </Form>
      </Modal>

      <LabelPrintDialog
        open={labelsOpen}
        onClose={() => setLabelsOpen(false)}
        endpoint="/api/v1/stock/locations/labels"
        idsKey="locationIds"
        ids={selectedIds}
        title="Skriv ut lagerplatsetiketter"
      />

      {warehouses.length === 0 ? (
        <p style={{ marginTop: 16 }}>Skapa ett lager ovan innan du kan lägga till en lagerplats.</p>
      ) : (
        <Card maxWidth={420} style={{ marginTop: 16 }}>
          <Form onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              setError(null);
              setPending(true);
              try {
                await apiFetch("/api/v1/stock/locations", {
                  method: "POST",
                  body: JSON.stringify({
                    warehouseId,
                    name,
                    fixed,
                    ...(newBlocked ? { blocked: true, blockedNote: newBlockedNote.trim() || undefined } : {}),
                  }),
                });
                setName("");
                setFixed(true);
                setNewBlocked(false);
                setNewBlockedNote("");
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Kunde inte skapa lagerplatsen");
              } finally {
                setPending(false);
              }
            }}>
            <strong>Ny lagerplats</strong>

            <Field label="Lager" htmlFor="locationWarehouseId">
              <Select id="locationWarehouseId" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Namn" htmlFor="locationName">
              <Input id="locationName" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>

            <label style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 14 }}>
              <Checkbox id="locationFixed" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
              Fast lagerplats
            </label>
            <FormHint>En fast lagerplats ligger kvar när den blir tom. En tillfällig inaktiveras automatiskt.</FormHint>

            <label style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 14 }}>
              <Checkbox id="locationBlocked" checked={newBlocked} onChange={(e) => setNewBlocked(e.target.checked)} />
              Spärrad lagerplats
            </label>
            {newBlocked && (
              <Field label="Anteckning" htmlFor="locationBlockedNote">
                <Input
                  id="locationBlockedNote"
                  value={newBlockedNote}
                  maxLength={200}
                  onChange={(e) => setNewBlockedNote(e.target.value)}
                />
              </Field>
            )}
            <FormHint>
              Saldo på en spärrad lagerplats räknas inte i behovsberäkningen, Materialbrist och Leveranstidskontrollen och
              tas aldrig med Automatiskt. Det värderas som vanligt.
            </FormHint>

            <FormActions>
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? "Skapar…" : "Skapa lagerplats"}
              </Button>
            </FormActions>
          </Form>
        </Card>
      )}
    </div>
  );
}
