"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mergeUntouched } from "../../lib/rowStateMerge";
import { GatedLink } from "../ui/GatedLink";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { useRouter, useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Input } from "../ui/Field";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { ListExportLink, ListFilterSelect, ListToggleFilter, ListToolbar, Pagination } from "../ui/ListControls";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { fetchDefaultRecipient } from "../../lib/mail";
import { createLegoInquiries } from "../../lib/legoInquiries";
import { SendEmailModal } from "../mail/MailSection";
import { useCan } from "../PermissionsProvider";
import { PdfActions } from "../documents/PdfActions";
import { SupplierCheckboxList } from "../purchase/SupplierCheckboxList";
import { CreatedInquiriesPanel } from "../purchase/CreatedInquiriesPanel";
import { listApiQuery, pageFromSearchParams } from "../../lib/listQuery";
import {
  INQUIRY_STATUS_PILL,
  type ArticleGroup,
  type CreatedInquiry,
  type LegoInquiryRowInput,
  type Paged,
  type PlanningOrderProposal,
  type PlanningOrdersResult,
  type RequirementRow,
  type Supplier,
} from "../../lib/types";
import styles from "../../app/tillverkning/behovsberakning/page.module.css";
import { SectionHeading } from "../ui/SectionHeading";

// Typ-filtret rör bara inköpta/tillverkade — behovsberäkningen exkluderar
// tjänsteartiklar (de lagerhålls aldrig, se ArticleTabs.tsx tabsForType).
const TYPE_OPTIONS = [
  { value: "purchased", label: "Inköpsartiklar" },
  { value: "manufactured", label: "Tillverkade" },
];

// Artikel/lego-filtret (proposalKind === "subcontract") har ingen
// motsvarighet i API:ets querySchema — lego-rader sorteras redan sist i
// listan, så ett rent sidvist filter skulle bara dölja dem på sidor
// användaren aldrig når. Se fetch-effekten nedan för hur filtret hanteras.
const KIND_OPTIONS = [
  { value: "article", label: "Artiklar" },
  { value: "lego", label: "Lego" },
];

interface DisplayRow extends RequirementRow {
  id: string;
}

// Subcontract (lego) rows are keyed per MO OPERATION — the same article can
// appear on several lego rows — so the row key is the operation id there and
// the article id everywhere else.
function rowKey(row: RequirementRow): string {
  // Configured sales-order rows share articleId with the template's own row — keyed per sales-order row.
  return row.moOperationId ?? row.salesOrderRowId ?? row.articleId;
}

// Selection/quantity state lives per row key, independent of which page is
// currently fetched — a selection made on one page must survive navigating
// to another (and be included in the submit). The proposal-relevant fields
// (kind, article, supplier, operation) are snapshotted here too so
// confirmCreate/summary never need to look the row back up in the
// currently-loaded page.
interface RowState {
  selected: boolean;
  quantity: string;
  kind: "purchase" | "manufacture" | "subcontract" | "configured";
  salesOrderRowId: string | null;
  articleId: string;
  articleNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  moOperationId: string | null;
  // Lego-only display fields, snapshotted here for the same reason as the
  // rest of the state — the "Skapa förfrågan" modal lists selected rows
  // without looking them back up in the currently-loaded page.
  moOrderNumber: string | null;
  moOperationLabel: string | null;
  unitCode: string | null;
  // Set once the user changes the selection or the quantity — a touched row
  // keeps its state across refetches, an untouched one follows the server.
  touched: boolean;
}

// A purchase/lego proposal with no supplier can't be ordered, and neither can
// a row without a proposed quantity. Shared by makeRowState, the per-row
// checkbox and the select-all header so all three agree on what "selectable"
// means.
function isSelectable(row: RequirementRow): boolean {
  // An invalid configuration can't be manufactured (the server refuses it anyway).
  if (row.proposalKind === "configured") return row.proposalQuantity > 0 && !row.configurationError;
  const needsSupplier = row.proposalKind === "purchase" || row.proposalKind === "subcontract";
  return row.proposalQuantity > 0 && !(needsSupplier && !row.primarySupplier);
}

// Preselected when there's actually a proposal; an unselectable row starts
// unchecked and disabled.
function makeRowState(row: RequirementRow): RowState {
  return {
    selected: isSelectable(row),
    quantity: String(row.proposalQuantity),
    // Only meaningful when selected (selected requires proposalQuantity > 0,
    // which the API only sets alongside a non-null proposalKind) — the
    // fallback here just keeps the type non-nullable for disabled rows.
    kind: row.proposalKind ?? "purchase",
    salesOrderRowId: row.salesOrderRowId ?? null,
    articleId: row.articleId,
    articleNumber: row.articleNumber,
    supplierId: row.primarySupplier?.supplierId ?? null,
    supplierName: row.primarySupplier?.supplierName ?? null,
    moOperationId: row.moOperationId ?? null,
    moOrderNumber: row.moOrderNumber ?? null,
    moOperationLabel: row.moOperationLabel ?? null,
    unitCode: row.unitCode,
    touched: false,
  };
}

export function BehovsberakningPageClient({ pageSize }: { pageSize: number }) {
  // Inquiries and purchase-order mail are Inköp writes (purchase module).
  const canInkop = useCan()(["inkop"]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryKey = searchParams.toString();

  const [groups, setGroups] = useState<ArticleGroup[]>([]);
  const [data, setData] = useState<Paged<RequirementRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Keyed by articleId, merged (never wholesale replaced) across refetches —
  // see the fetch effect below — so selections/edits survive pagination and
  // filter changes, while untouched rows follow the recomputed proposals.
  // Only a successful order creation clears it, since the proposals
  // themselves changed at that point.
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [reloadKey, setReloadKey] = useState(0);
  // The server caches the computed behovsberäkning for a minute (paging,
  // search and filters read the cache). A reload we trigger ourselves —
  // Uppdatera, or after creating orders/inquiries — must bypass it, so it
  // sets this before bumping reloadKey and the next fetch sends refresh=true.
  const forceRefresh = useRef(false);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const reload = () => {
    forceRefresh.current = true;
    setReloadKey((k) => k + 1);
  };

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<PlanningOrdersResult | null>(null);
  // "Maila" on a created purchase order: the picked order, and the recipient
  // resolved from its supplier (null while that lookup is in flight, so the
  // dialog opens with the address already filled in rather than blank).
  const [mailTarget, setMailTarget] = useState<PlanningOrdersResult["purchaseOrders"][number] | null>(null);
  const [mailTo, setMailTo] = useState<string | null>(null);
  const [sentOrderIds, setSentOrderIds] = useState<string[]>([]);

  // "Skapa förfrågan": a legoförfrågan requests quotes from one or more
  // suppliers for the selected lego rows — separate from "Skapa ordrar",
  // which always books to the operation's own primary supplier.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [legoModalOpen, setLegoModalOpen] = useState(false);
  const [legoSupplierIds, setLegoSupplierIds] = useState<string[]>([]);
  const [legoSubmitting, setLegoSubmitting] = useState(false);
  const [legoSubmitError, setLegoSubmitError] = useState<string | null>(null);
  const [inquiryResult, setInquiryResult] = useState<{
    created: CreatedInquiry[];
    errors: { supplierName: string; articleNumbers: string[]; message: string }[];
  } | null>(null);

  useEffect(() => {
    if (!mailTarget) return;
    let cancelled = false;
    setMailTo(null);
    fetchDefaultRecipient("suppliers", mailTarget.supplierId).then((to) => {
      if (!cancelled) setMailTo(to);
    });
    return () => {
      cancelled = true;
    };
  }, [mailTarget]);

  useEffect(() => {
    apiFetch<ArticleGroup[]>("/api/v1/article-groups").then(setGroups).catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    apiFetch<Paged<Supplier>>("/api/v1/suppliers?limit=1000")
      .then((res) => setSuppliers(res.rows))
      .catch(() => setSuppliers([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const sp = Object.fromEntries(searchParams.entries());
    const kind = sp.kind === "lego" || sp.kind === "article" ? sp.kind : null;

    // The Alla/Artiklar/Lego filter has no server-side counterpart (see the
    // KIND_OPTIONS comment above), so when it's active we fetch the whole
    // (still type/groupId/showAll/search-filtered) result set in one go —
    // the same "limit=1000" idiom the article pickers use for "everything",
    // and within the shared list schema's max — and paginate the filtered
    // rows ourselves. Unfiltered ("Alla") keeps the plain server pagination
    // unchanged.
    const query = kind
      ? (() => {
          const params = new URLSearchParams();
          if (sp.search) params.set("search", sp.search);
          if (sp.type) params.set("type", sp.type);
          if (sp.groupId) params.set("groupId", sp.groupId);
          if (sp.showAll) params.set("showAll", sp.showAll);
          params.set("limit", "1000");
          params.set("offset", "0");
          return `?${params.toString()}`;
        })()
      : listApiQuery(sp, ["type", "groupId", "showAll"], pageSize);

    const refresh = forceRefresh.current ? "&refresh=true" : "";
    forceRefresh.current = false;

    apiFetch<Paged<RequirementRow> & { computedAt: string }>(`/api/v1/planning/requirements${query}${refresh}`)
      .then((res) => {
        if (cancelled) return;
        setComputedAt(res.computedAt);
        let paged: Paged<RequirementRow> = res;
        if (kind) {
          const filtered = res.rows.filter((r) =>
            kind === "lego" ? r.proposalKind === "subcontract" : r.proposalKind !== "subcontract"
          );
          const page = pageFromSearchParams(sp);
          const offset = (page - 1) * pageSize;
          paged = { rows: filtered.slice(offset, offset + pageSize), total: filtered.length };
        }
        setData(paged);
        // Merge: a row the user touched (selection or quantity) keeps its
        // state, every other loaded row is rebuilt from the fresh proposal —
        // so Uppdatera shows recomputed quantities. Entries for rows on other
        // pages stay as they are. confirmCreate clears rowStates first, so
        // that path is a full rebuild.
        setRowStates((prev) => mergeUntouched(prev, paged.rows, rowKey, makeRowState));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setData(null);
        setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey mirrors searchParams
  }, [queryKey, reloadKey, pageSize]);

  const rows: DisplayRow[] = (data?.rows ?? []).map((r) => ({ ...r, id: rowKey(r) }));

  const configuredRows = rows.filter((r) => r.proposalKind === "configured");
  const articleRows = rows.filter((r) => r.proposalKind !== "configured");

  // Selection spans every page the user has touched, not just the currently
  // loaded one.
  const selectedEntries = useMemo(
    () => Object.entries(rowStates).filter(([, s]) => s.selected),
    [rowStates]
  );
  const selectedCount = selectedEntries.length;
  const currentPageIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const otherPageCount = selectedEntries.filter(([key]) => !currentPageIds.has(key)).length;

  // The lego rows among the current selection — "Skapa förfrågan" only acts
  // on these, leaving any selected purchase/manufacture rows untouched.
  const legoEntries = useMemo(() => selectedEntries.filter(([, s]) => s.kind === "subcontract"), [selectedEntries]);
  const legoSupplierPreselect = useMemo(
    () => Array.from(new Set(legoEntries.map(([, s]) => s.supplierId).filter((id): id is string => id !== null))),
    [legoEntries]
  );

  function toggleRow(row: DisplayRow, selected: boolean) {
    setRowStates((prev) => {
      const current = prev[row.id] ?? makeRowState(row);
      return { ...prev, [row.id]: { ...current, selected, touched: true } };
    });
  }

  // Select-all covers the current page only: the client never holds the rows
  // of the other pages, and selections made there are left untouched (the
  // status line below the table reports them as "varav X på annan sida").
  const selectableRows = useMemo(() => rows.filter(isSelectable), [rows]);
  const selectedOnPage = selectableRows.filter((row) => (rowStates[row.id] ?? makeRowState(row)).selected).length;
  const allSelectedOnPage = selectableRows.length > 0 && selectedOnPage === selectableRows.length;

  function toggleAll(selected: boolean) {
    setRowStates((prev) => {
      const next = { ...prev };
      for (const row of selectableRows) {
        next[row.id] = { ...(prev[row.id] ?? makeRowState(row)), selected, touched: true };
      }
      return next;
    });
  }

  function setQuantity(row: DisplayRow, quantity: string) {
    setRowStates((prev) => {
      const current = prev[row.id] ?? makeRowState(row);
      return { ...prev, [row.id]: { ...current, quantity, touched: true } };
    });
  }

  // Preview text for the confirmation dialog — the actual grouping (one
  // draft purchase order per primary supplier) happens server-side. Dedupe
  // by supplierId, not name — names aren't guaranteed unique.
  const summary = useMemo(() => {
    const suppliers = new Map<string, string>();
    let manufactureCount = 0;
    for (const [, state] of selectedEntries) {
      if ((state.kind === "purchase" || state.kind === "subcontract") && state.supplierId) {
        suppliers.set(state.supplierId, state.supplierName ?? state.supplierId);
      } else if (state.kind === "manufacture" || state.kind === "configured") {
        manufactureCount += 1;
      }
    }
    const parts: string[] = [];
    if (suppliers.size > 0) {
      const names = Array.from(suppliers.values()).join(", ");
      parts.push(`${suppliers.size} ${suppliers.size === 1 ? "inköpsorder" : "inköpsordrar"} (${names})`);
    }
    if (manufactureCount > 0) {
      parts.push(`${manufactureCount} ${manufactureCount === 1 ? "tillverkningsorder" : "tillverkningsordrar"}`);
    }
    return parts.length > 0 ? parts.join(" och ") : "Inga ordrar att skapa";
  }, [selectedEntries]);

  async function confirmCreate() {
    setSubmitError(null);

    const proposals: PlanningOrderProposal[] = [];
    for (const [, state] of selectedEntries) {
      const quantity = Number(state.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setSubmitError("Ange ett antal större än 0 för alla valda rader");
        return;
      }
      proposals.push({
        articleId: state.articleId,
        quantity,
        kind: state.kind,
        ...(state.kind === "configured" && state.salesOrderRowId ? { salesOrderRowId: state.salesOrderRowId } : {}),
        // Subcontract proposals are keyed by the MO operation they buy.
        ...(state.kind === "subcontract" && state.moOperationId ? { moOperationId: state.moOperationId } : {}),
      });
    }
    if (proposals.length === 0) {
      setSubmitError("Ange ett antal större än 0 för alla valda rader");
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<PlanningOrdersResult>("/api/v1/planning/orders", {
        method: "POST",
        body: JSON.stringify({ proposals }),
      });
      setResult(res);
      setModalOpen(false);
      // The created orders are new supply — clear rowStates and refetch so
      // proposals that are now satisfied disappear (a full rebuild, unlike
      // the merge above); router.refresh() covers any server component
      // elsewhere on the page.
      router.refresh();
      setRowStates({});
      reload();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Kunde inte skapa ordrar");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmCreateInquiry() {
    if (legoSupplierIds.length === 0) {
      setLegoSubmitError("Välj minst en leverantör");
      return;
    }

    const legoRows: LegoInquiryRowInput[] = [];
    for (const [, state] of legoEntries) {
      const quantity = Number(state.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setLegoSubmitError("Ange ett antal större än 0 för alla lego-rader");
        return;
      }
      legoRows.push({
        articleId: state.articleId,
        articleNumber: state.articleNumber,
        quantity,
        ...(state.moOperationId ? { moOperationId: state.moOperationId } : {}),
      });
    }

    setLegoSubmitError(null);
    setLegoSubmitting(true);
    try {
      const selectedSuppliers = suppliers
        .filter((s) => legoSupplierIds.includes(s.id))
        .map((s) => ({ id: s.id, name: s.name }));
      const res = await createLegoInquiries({ suppliers: selectedSuppliers, rows: legoRows });
      setInquiryResult(res);
      setLegoModalOpen(false);
      // Inquiries aren't orders — the proposed rows are still open, so
      // rowStates (selection + edited quantities) is left untouched, unlike
      // confirmCreate's full rebuild. reloadKey still bumps so the table
      // picks up the fresh openInquiries links.
      reload();
    } catch (err) {
      setLegoSubmitError(err instanceof Error ? err.message : "Kunde inte skapa förfrågan");
    } finally {
      setLegoSubmitting(false);
    }
  }

  // The selection summary and the two action buttons render twice — under
  // the table on desktop, above it in the mobile stack — so build them once.
  const selectedSummary =
    otherPageCount > 0
      ? `${selectedCount} rader valda (varav ${otherPageCount} på annan sida)`
      : `${selectedCount} av ${rows.length} rader valda`;
  const actionButtons = (
    <span className={styles.selectionActions}>
      {canInkop && (
        <Button
          type="button"
          variant="secondary"
          disabled={legoEntries.length === 0}
          onClick={() => {
            setLegoSubmitError(null);
            setLegoSupplierIds([]);
            setLegoModalOpen(true);
          }}
        >
          Skapa förfrågan
        </Button>
      )}
      <Button
        type="button"
        variant="primary"
        disabled={selectedCount === 0}
        onClick={() => {
          setSubmitError(null);
          setModalOpen(true);
        }}
      >
        Skapa ordrar
      </Button>
    </span>
  );

  return (
    <>
      <ListToolbar placeholder="Sök artikelnummer eller benämning…">
        <ListFilterSelect param="type" allLabel="Alla typer" ariaLabel="Filtrera på typ" options={TYPE_OPTIONS} />
        <ListFilterSelect param="kind" allLabel="Alla" ariaLabel="Filtrera på artikel/lego" options={KIND_OPTIONS} />
        <ListFilterSelect
          param="groupId"
          allLabel="Alla varugrupper"
          ariaLabel="Filtrera på varugrupp"
          options={groups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))}
        />
        <ListToggleFilter param="showAll" label="Visa alla artiklar" />
        <ListExportLink endpoint="/api/v1/planning/requirements/csv" />
        <span className={styles.computedAt}>
          {computedAt && (
            <span title="Resultatet återanvänds i upp till en minut — Uppdatera räknar om direkt">
              Beräknad {formatComputedAt(computedAt)}
            </span>
          )}
          <Button type="button" variant="ghost" size="small" disabled={loading} onClick={reload}>
            Uppdatera
          </Button>
        </span>
      </ListToolbar>

      <FormError margin="below">{loadError}</FormError>

      {result && (
        <Card maxWidth="none" style={{ marginBottom: 20 }}>
          <SectionHeading>Skapade ordrar</SectionHeading>
          {result.purchaseOrders.length === 0 && result.manufacturingOrders.length === 0 && (
            <p>Inga ordrar skapades.</p>
          )}
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.purchaseOrders.map((po) => (
              <li key={po.id} className={styles.createdOrder}>
                <GatedLink href={`/inkop/ordrar/${po.id}`} className={styles.rowLink}>
                  {po.orderNumber} – {po.supplierName} ({po.rowCount} {po.rowCount === 1 ? "rad" : "rader"})
                </GatedLink>
                <span className={styles.createdOrderActions}>
                  <PdfActions href={`/api/v1/purchase-orders/${po.id}/pdf`} />
                  {canInkop && (
                    <Button type="button" variant="ghost" size="small" onClick={() => setMailTarget(po)}>
                      Maila
                    </Button>
                  )}
                  {sentOrderIds.includes(po.id) && <StatusPill status="running" label="Skickad" compact />}
                </span>
              </li>
            ))}
            {result.manufacturingOrders.map((mo) => (
              <li key={mo.id} className={styles.createdOrder}>
                <GatedLink href={`/tillverkning/ordrar/${mo.id}`} className={styles.rowLink}>
                  {mo.orderNumber} – {mo.articleNumber}
                </GatedLink>
                {/* No mail button: tillverkningsordrar have no send-email
                    route (they're not sent to anyone outside the workshop). */}
                <span className={styles.createdOrderActions}>
                  <PdfActions href={`/api/v1/manufacturing-orders/${mo.id}/pdf`} />
                </span>
              </li>
            ))}
          </ul>
          {/* Everything at once (NOTES.md #9): one PDF per kind, orders in
              list order. With a single order the row's own buttons already
              do the job, so the batch rows appear from two. */}
          {result.purchaseOrders.length > 1 && (
            <div className={styles.createdOrderBatch}>
              <span>Alla inköpsorder ({result.purchaseOrders.length} st):</span>
              <span className={styles.createdOrderActions}>
                <PdfActions href={`/api/v1/purchase-orders/pdf?ids=${result.purchaseOrders.map((po) => po.id).join(",")}`} />
              </span>
            </div>
          )}
          {result.manufacturingOrders.length > 1 && (
            <div className={styles.createdOrderBatch}>
              <span>Alla tillverkningsorder ({result.manufacturingOrders.length} st):</span>
              <span className={styles.createdOrderActions}>
                <PdfActions
                  href={`/api/v1/manufacturing-orders/pdf?ids=${result.manufacturingOrders.map((mo) => mo.id).join(",")}`}
                />
              </span>
            </div>
          )}
          {result.purchaseOrders.length > 0 && (
            <FormHint style={{ marginTop: 10 }}>
              Inköpsordrarna skapas som <strong>Utkast</strong> — att mejla en order skickar den och sätter den
              samtidigt till <strong>Bekräftad</strong>.
            </FormHint>
          )}
          {result.warnings.length > 0 && (
            <FormNotice style={{ marginTop: "var(--space-4)" }}>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {result.warnings.map((w, i) => (
                  <li key={`${w.orderNumber}-${w.articleNumber}-${i}`}>
                    {w.orderNumber} · {w.articleNumber}: {w.message}
                  </li>
                ))}
              </ul>
            </FormNotice>
          )}
          {result.errors.length > 0 && (
            <FormError margin="above">
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {/* Index key: two lego operations on the same article can
                    both error, so articleId is not unique here. */}
                {result.errors.map((e, i) => (
                  <li key={`${e.articleId}-${i}`}>
                    {e.articleNumber} — {e.message}
                  </li>
                ))}
              </ul>
            </FormError>
          )}
        </Card>
      )}

      {inquiryResult && <CreatedInquiriesPanel result={inquiryResult} />}

      {/* Mobile stack (≤640px, see Table.module.css): the header row — and
          the select-all checkbox in it — is hidden, and the bar under the
          stacked cards is out of reach. This sticky bar above the list
          carries "Välj alla" and the actions instead; CSS hides it on wider
          screens. Same pattern as the TO list (ManufacturingOrdersPageClient). */}
      <div className={styles.selectBar} role="region" aria-label="Markera rader">
        <label className={styles.selectAllLabel}>
          <SelectAllCheckbox
            checked={allSelectedOnPage}
            indeterminate={selectedOnPage > 0 && !allSelectedOnPage}
            disabled={selectableRows.length === 0}
            onChange={toggleAll}
            ariaLabel="Välj alla rader på sidan"
          />
          Välj alla på sidan ({selectableRows.length})
        </label>
        {selectedCount > 0 && (
          <>
            <span>{selectedSummary}</span>
            {actionButtons}
          </>
        )}
      </div>

      {(articleRows.length > 0 || configuredRows.length === 0) && (
      <Table<DisplayRow>
        columns={[
          {
            key: "select",
            label: "",
            width: "36px",
            header: (
              <SelectAllCheckbox
                checked={allSelectedOnPage}
                indeterminate={selectedOnPage > 0 && !allSelectedOnPage}
                disabled={selectableRows.length === 0}
                onChange={toggleAll}
                ariaLabel="Välj alla rader på sidan"
              />
            ),
          },
          // Eleven columns have to share ~1100px next to the sidebar, so the
          // numeric columns are kept tight and Artikel takes the slack (with
          // a floor so a long name wraps to two lines, not five). Källa is
          // fixed at the width of its widest pill ("Saknar huvudleverantör"
          // wraps to two lines) instead of competing with Artikel for `fr`.
          { key: "article", label: "Artikel", width: "minmax(180px, 2fr)" },
          { key: "type", label: "Typ", width: "70px" },
          { key: "onHand", label: "Saldo", width: "70px", align: "right" },
          { key: "demand", label: "Behov", width: "70px", align: "right" },
          { key: "incoming", label: "Inkommande", width: "80px", align: "right" },
          { key: "projected", label: "Netto", width: "70px", align: "right" },
          { key: "reorderPoint", label: "BP / SL", width: "60px", align: "right" },
          { key: "proposal", label: "Förslag", width: "120px", align: "right" },
          { key: "leadTime", label: "Ledtid", width: "60px", align: "right" },
          { key: "source", label: "Källa", width: "140px" },
        ]}
        rows={articleRows}
        emptyText={loading ? "Hämtar…" : "Inga artiklar matchar filtren"}
        renderCell={(row, key) => {
          const state = rowStates[row.id] ?? makeRowState(row);
          const demand = row.demandSales + row.demandMo + row.demandDerived;
          const incoming = row.supplyPo + row.supplyPoDraft + row.supplyMo;
          const isLego = row.proposalKind === "subcontract";
          const rowDisabled = !isSelectable(row);

          switch (key) {
            case "select":
              return (
                <Checkbox
                  checked={state.selected}
                  disabled={rowDisabled}
                  onChange={(e) => toggleRow(row, e.target.checked)}
                  aria-label={`Välj ${row.articleNumber}`}
                />
              );
            case "article":
              return (
                <>
                  <GatedLink href={`/artiklar/${row.articleId}`} className={styles.rowLink}>
                    {row.articleNumber} — {row.articleName}
                    {!row.active && (
                      <>
                        {" "}
                        <StatusPill status="draft" label="Inaktiv" compact />
                      </>
                    )}
                  </GatedLink>
                  <ArticleOverviewButton articleId={row.articleId} articleNumber={row.articleNumber} />
                  {isLego && (
                    // Which TO operation this lego proposal buys.
                    <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                      {row.moOrderNumber} · {row.moOperationLabel}
                    </div>
                  )}
                  {isLego &&
                    (row.openInquiries ?? []).map((inq) => (
                      // Existing förfrågningar already covering this
                      // operation — so a rerun of the routine doesn't read
                      // as "nothing's been requested yet".
                      <div key={inq.id} style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                        <GatedLink href={`/inkop/forfragningar/${inq.id}`}>Förfrågan {inq.inquiryNumber}</GatedLink> (
                        {INQUIRY_STATUS_PILL[inq.status].label})
                      </div>
                    ))}
                </>
              );
            case "type":
              if (isLego) return <StatusPill status="running" label="Lego" compact />;
              return row.type === "manufactured" ? "Tillverkad" : "Inköp";
            case "onHand":
              return row.onHand.toLocaleString("sv-SE");
            case "demand":
              return (
                <span title={`KO: ${row.demandSales} · TO-material: ${row.demandMo} · Härlett: ${row.demandDerived}`}>
                  {demand.toLocaleString("sv-SE")}
                </span>
              );
            case "incoming":
              return (
                <span title={`IO: ${row.supplyPo} · IO-utkast: ${row.supplyPoDraft} · TO: ${row.supplyMo}`}>
                  {incoming.toLocaleString("sv-SE")}
                </span>
              );
            case "projected":
              return (
                <span style={row.projected < 0 ? { color: "var(--status-stopped-text)" } : undefined}>
                  {row.projected.toLocaleString("sv-SE")}
                </span>
              );
            case "reorderPoint":
              // BP on the first line, Säkerhetslager (SL) below it when set.
              return (
                <span title={`Beställningspunkt: ${row.reorderPoint ?? "—"} · Säkerhetslager: ${row.safetyStock ?? "—"}`}>
                  {row.reorderPoint !== null ? row.reorderPoint.toLocaleString("sv-SE") : "—"}
                  {row.safetyStock !== null && (
                    <span style={{ display: "block", color: "var(--color-text-muted)" }}>
                      {row.safetyStock.toLocaleString("sv-SE")}
                    </span>
                  )}
                </span>
              );
            case "proposal":
              if (row.configuredTemplate) {
                // A beställningsvara template never gets a proposal of its own — its
                // configured sales-order rows below do.
                return <span style={{ color: "var(--color-text-muted)" }}>Beställningsvara</span>;
              }
              return (
                <Input
                  type="number"
                  min="0"
                  step="any"
                  size="sm"
                  value={state.quantity}
                  disabled={rowDisabled}
                  onChange={(e) => setQuantity(row, e.target.value)}
                  aria-label={`Förslagskvantitet för ${row.articleNumber}`}
                />
              );
            case "leadTime":
              return row.primarySupplier?.leadTimeDays != null ? `${row.primarySupplier.leadTimeDays} dgr` : "—";
            case "source":
              if (row.proposalKind === "manufacture") return "Ny TO";
              if (row.primarySupplier) return row.primarySupplier.supplierName;
              if (row.proposalKind === "purchase") {
                return <StatusPill status="stopped" label="Saknar huvudleverantör" compact />;
              }
              if (isLego) {
                // The operation has no supplier — set one in the beredning.
                return <StatusPill status="stopped" label="Saknar leverantör" compact />;
              }
              return "—";
            default:
              return null;
          }
        }}
      />
      )}

      {configuredRows.length > 0 && (
        <>
          <SectionHeading spaced>Konfigurerade kundorderrader</SectionHeading>
          <Table<DisplayRow>
            columns={[
              { key: "select", label: "", width: "36px" },
              { key: "order", label: "Kundorder", width: "minmax(110px, 1fr)" },
              { key: "customer", label: "Kund", width: "minmax(120px, 1fr)" },
              { key: "article", label: "Artikel", width: "minmax(160px, 1.5fr)" },
              { key: "selection", label: "Val", width: "minmax(200px, 2fr)" },
              { key: "delivery", label: "Leveransdatum", width: "110px" },
              { key: "proposal", label: "Antal", width: "110px", align: "right" },
            ]}
            rows={configuredRows}
            renderCell={(row, key) => {
              const state = rowStates[row.id] ?? makeRowState(row);
              const rowDisabled = !isSelectable(row);
              switch (key) {
                case "select":
                  return (
                    <Checkbox
                      checked={state.selected}
                      disabled={rowDisabled}
                      onChange={(e) => toggleRow(row, e.target.checked)}
                      aria-label={`Välj ${row.salesOrderNumber} ${row.articleNumber}`}
                    />
                  );
                case "order":
                  return row.salesOrderId ? (
                    <GatedLink href={`/forsaljning/ordrar/${row.salesOrderId}`} className={styles.rowLink}>
                      {row.salesOrderNumber}
                    </GatedLink>
                  ) : (
                    ""
                  );
                case "customer":
                  return row.customerName ?? "";
                case "article":
                  return (
                    <>
                      <GatedLink href={`/artiklar/${row.articleId}`} className={styles.rowLink}>
                        {row.articleNumber} — {row.articleName}
                        {/* An inactive template proposes nothing, as an inactive article. */}
                        {!row.active && (
                          <>
                            {" "}
                            <StatusPill status="draft" label="Inaktiv" compact />
                          </>
                        )}
                      </GatedLink>
                      <ArticleOverviewButton articleId={row.articleId} articleNumber={row.articleNumber} />
                    </>
                  );
                case "selection":
                  return (
                    <>
                      <div style={{ overflowWrap: "anywhere" }}>{row.configurationSummary}</div>
                      {row.configurationError && (
                        <div style={{ color: "var(--status-stopped-text)", fontSize: 12, marginTop: 2 }}>
                          {row.configurationError}
                        </div>
                      )}
                    </>
                  );
                case "delivery":
                  return row.expectedDeliveryDate ?? "—";
                case "proposal":
                  return (
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      size="sm"
                      value={state.quantity}
                      disabled={rowDisabled}
                      onChange={(e) => setQuantity(row, e.target.value)}
                      aria-label={`Antal att tillverka för ${row.salesOrderNumber} ${row.articleNumber}`}
                    />
                  );
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      {data && <Pagination total={data.total} pageSize={pageSize} />}

      {/* Desktop: summary + actions under the table. Hidden by CSS in the
          mobile stack, where .selectBar above the table carries them. */}
      <div className={styles.bulkBar}>
        <span>{selectedSummary}</span>
        {actionButtons}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Skapa ordrar">
        <p>{summary}</p>
        <FormHint>Kvantiteterna som visas i tabellen används — redigera dem där innan du bekräftar.</FormHint>
        <FormError>{submitError}</FormError>
        <FormActions>
          <Button type="button" variant="primary" disabled={submitting} onClick={confirmCreate}>
            {submitting ? "Skapar…" : "Bekräfta"}
          </Button>
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => setModalOpen(false)}>
            Avbryt
          </Button>
        </FormActions>
      </Modal>

      <Modal open={legoModalOpen} onClose={() => setLegoModalOpen(false)} title="Skapa förfrågan">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {legoEntries.map(([key, state]) => (
            <li key={key}>
              {state.articleNumber} — {state.moOrderNumber} · {state.moOperationLabel} · {state.quantity}{" "}
              {state.unitCode}
            </li>
          ))}
        </ul>
        <FormHint>Endast lego-rader ingår — övriga markerade rader lämnas orörda.</FormHint>
        <SupplierCheckboxList
          value={legoSupplierIds}
          onChange={setLegoSupplierIds}
          preselect={legoSupplierPreselect}
          // Pass the already-fetched list once it's actually loaded — the
          // page's own fetch (above) runs on mount, well before this modal
          // can open. undefined while still empty so a fast click still
          // falls back to the component's own fetch instead of rendering a
          // permanently empty list.
          suppliers={suppliers.length > 0 ? suppliers : undefined}
        />
        <FormError>{legoSubmitError}</FormError>
        <FormActions>
          <Button type="button" variant="primary" disabled={legoSubmitting} onClick={confirmCreateInquiry}>
            {legoSubmitting ? "Skapar…" : "Bekräfta"}
          </Button>
          <Button type="button" variant="ghost" disabled={legoSubmitting} onClick={() => setLegoModalOpen(false)}>
            Avbryt
          </Button>
        </FormActions>
      </Modal>

      {/* Same dialog as the inköpsorder card's "Skicka via e-post", opened
          straight from the result list. Held back until the recipient lookup
          resolves so the address is prefilled. drawingCount is 0: the count
          belongs to the order card, and lego rows attach their drawings
          server-side regardless. */}
      {mailTarget && mailTo !== null && (
        <SendEmailModal
          open
          onClose={() => setMailTarget(null)}
          config={{
            label: "Maila",
            modalTitle: `Skicka ${mailTarget.orderNumber} via e-post`,
            endpoint: `/api/v1/purchase-orders/${mailTarget.id}/send-email`,
            subject: `Inköpsorder ${mailTarget.orderNumber}`,
            message: `Hej!\n\nSe bifogad inköpsorder ${mailTarget.orderNumber}.\n\nMed vänliga hälsningar`,
          }}
          defaultTo={mailTo}
          drawingCount={0}
          onSuccess={() => {
            setSentOrderIds((prev) => [...prev, mailTarget.id]);
            setMailTarget(null);
          }}
        />
      )}
    </>
  );
}

// "Beräknad 08:12:03" — when the server computed the cached result.
function formatComputedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
