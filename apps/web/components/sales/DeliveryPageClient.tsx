"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { ScanPanel } from "../ui/ScanInput";
import { useCountState, useScanFeedback, useScanQueue, useScanState } from "../ui/useOrderScan";
import { ApiError, apiFetch } from "../../lib/api";
import { BatchSelect, useBatchBalances } from "../stock/BatchSelect";
import { BATCH_AUTO, batchIdField, expiredBatchLocationId } from "../../lib/batch";
import { compressSerialNumbers } from "../../lib/serials";
import { serialCountOf } from "../../lib/serialInput";
import { DeliverySerialsField, SerialCellPicker, isDeliverySerial, isStockSerial, useSerialModes } from "../stock/SerialNumbers";
import { outflowLocationChoices } from "../../lib/stockLocations";
import { confirmDialog } from "../../lib/confirm";
import { notify } from "../../lib/notice";
import { apiErrorMessage } from "../../lib/errorMessages";
import { configuredDeliveryWarning } from "../../lib/configuredDelivery";
import { deliveryBlockedText } from "../../lib/deliveryBlocked";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import {
  countScan,
  enteredQuantity,
  hasCounted,
  isScannableRow,
  leftToCount,
  matchBatchScan,
  matchSerialScan,
  resolveOrderScan,
  salesScanDate,
  type OrderCountState,
  type OrderScanRow,
} from "../../lib/orderScan";
import {
  SALES_ORDER_STATUS_PILL,
  type SalesOrder,
  type SalesOrderRow,
  type SalesOrderStatus,
  type ArticleLocationBalance,
  type ScanGs1,
  type ScanMatch,
  type StockLocation,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError, FormHint, FormNotice } from "../ui/Form";
import { BookTransportButton } from "../shipping/BookTransportButton";
import { PalletCardDialog } from "../documents/PalletCardDialog";
import { UndoDeliveryDialog } from "./UndoDeliveryDialog";
import styles from "./DeliveryPageClient.module.css";
import { formatStockholmDate } from "../../lib/date";

const NO_COUNT: OrderCountState = { counting: false, quantities: {} };

type ArticleMatch = Extract<ScanMatch, { kind: "article" }>;
type LocationOption = Pick<StockLocation, "id" | "name" | "warehouseName"> & { blocked?: boolean };

const articleLabel = (a: { articleNumber: string; name: string }) => `${a.articleNumber} · ${a.name}`;

// Utleverans routine — report a whole delivery in one go. Quantities are
// prefilled with each row's remaining amount; rows set to 0 are skipped. All
// filled-in rows are booked in ONE POST /sales-orders/:id/deliver call —
// C2's batch endpoint — so the whole occasion becomes a single delivery
// (följesedel), atomic across every row. Delivery requires status
// "Under tillverkning".
//
// Skanning (#4, etapp 3): the scan field takes a KO number (picks the
// order), a lagerplats label (picks where the goods are taken from) or an
// article/EAN, which counts one picked per scan on the article's row — the
// first article scan clears the prefilled amounts, so only what was picked is
// delivered, and a scan beyond the customer's Tillåten överleverans (#24; by
// default none) is refused, as the server refuses it. Tjänster and ställkostnadsrader keep
// their remaining amount. The rules are lib/orderScan.ts, shared with
// Inleverans.
//
// GS1 (#8 etapp 2 steg 6): a scanned serienummer (a GS1 code's AI 21, or
// the number itself) picks that number on its article's row — the article
// need not be scanned first — and a scanned batch (AI 10, or the batch
// number) chooses the batch on the row: one chosen batch per row. Both land
// in the row's own fields (Serienummer, Batch), to be seen before Rapportera.
export function DeliveryPageClient({
  locations,
  selected,
  rows,
  openOrders,
}: {
  locations: StockLocation[];
  selected: SalesOrder | null;
  rows: SalesOrderRow[];
  // Every deliverable order (status in_production) — browsable list shown
  // below the picker while no order is selected, so the routine works
  // without knowing the order number (mirrors inleverans' "Mottagbara
  // ordrar").
  openOrders: SalesOrder[];
}) {
  const router = useRouter();
  const order = selected;
  const selectedId = order?.id ?? null;
  const remainingRows = useMemo(
    () => rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered)),
    [rows]
  );
  // ?order=<id> may name an order that is not Under tillverkning (a quote, a
  // Bekräftad order, an avbruten one): say so at once and offer no rows to
  // deliver, instead of a 409 at Rapportera. A fully delivered order keeps
  // "Alla rader … redan levererade" (the routine's own result).
  const blockedText = order && remainingRows.length > 0 ? deliveryBlockedText(order) : null;
  const openRows = useMemo(() => (blockedText ? [] : remainingRows), [blockedText, remainingRows]);
  // Tillåten överleverans for the order's customer (#24): null = no limit.
  const overDeliveryPercent = order?.overDeliveryPercent === undefined ? 0 : order.overDeliveryPercent;
  // The open rows as the scan rules see them: remaining in the row's unit,
  // and the most this delivery may take — the remaining amount plus the
  // allowed överleverans (the server refuses beyond it).
  const scanRows = useMemo<OrderScanRow[]>(
    () =>
      openRows.map((r) => ({
        id: r.id,
        articleId: r.articleId,
        remaining: toUnitQuantity(Number(r.quantityOrdered) - Number(r.quantityDelivered), r.unitFactor),
        scannable: isScannableRow(r),
        max:
          overDeliveryPercent === null
            ? null
            : toUnitQuantity(
                Number(r.quantityOrdered) * (1 + overDeliveryPercent / 100) - Number(r.quantityDelivered),
                r.unitFactor
              ),
        date: salesScanDate(r, order),
      })),
    [openRows, overDeliveryPercent, order]
  );
  const scanRowOf = (row: SalesOrderRow) => scanRows.find((r) => r.id === row.id)!;

  const [locationId, setLocationId] = useState(""); // "" = Automatiskt
  // Lagerplats per rad: "" = Som ovan (follows the field above). Balances of
  // the open rows' articles per location, fetched once per order (and again
  // after a delivery changed them).
  const [rowLocations, rowLocationsRef, setRowLocations] = useScanState<Record<string, string>>({});
  const [balances, setBalances] = useState<Record<string, ArticleLocationBalance[]>>({});
  // Batch (#8) per row: "" = Automatiskt. Only batch-tracked rows have a choice.
  const [rowBatches, rowBatchesRef, setRowBatches] = useScanState<Record<string, string>>({});
  // Serienummer (#8 etapp 2): numbers picked in stock (serialIds, stock per
  // number) or given at the delivery (serialNumbers, Vid utleverans).
  const serialModes = useSerialModes(openRows.map((r) => ({ articleId: r.articleId, tracking: r.articleTracking })));
  const [rowSerialIds, rowSerialIdsRef, setRowSerialIds] = useScanState<Record<string, string[]>>({});
  const [rowGivenSerials, setRowGivenSerials] = useState<Record<string, string[]>>({});
  const stockSerial = (r: SalesOrderRow) => isStockSerial(r.articleTracking, serialModes, r.articleId);
  const deliverySerial = (r: SalesOrderRow) => isDeliverySerial(r.articleTracking, serialModes, r.articleId);
  const trackedArticleIds = useMemo(
    () => openRows.filter((r) => r.articleBatchTracked).map((r) => r.articleId),
    [openRows]
  );
  const serialStockArticleIds = useMemo(
    () => openRows.filter((r) => isStockSerial(r.articleTracking, serialModes, r.articleId)).map((r) => r.articleId),
    [openRows, serialModes]
  );
  const hasSerialRows = serialStockArticleIds.length > 0 || openRows.some((r) => isDeliverySerial(r.articleTracking, serialModes, r.articleId));
  const { rows: batchRows, reload: reloadBatches } = useBatchBalances([...trackedArticleIds, ...serialStockArticleIds]);
  // A scanned lagerplats that GET /stock/locations leaves out (inactive: it
  // holds nothing), added to the select so the choice can be shown.
  const [scannedLocation, setScannedLocation] = useState<LocationOption | null>(null);
  const { count, countRef, setCount } = useCountState(NO_COUNT);
  const { feedback, ok, warn, clear: clearFeedback } = useScanFeedback();
  const [lastRowId, setLastRowId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [palletCardDeliveryId, setPalletCardDeliveryId] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; orderId: string; deliveryId: string; deliveryNumber: string } | null>(
    null
  );
  // Ångra… from the result block or the notice: the order card's own dialog,
  // row by row (Ångra utleverans is per delivery row).
  const [undoDelivery, setUndoDelivery] = useState<{ orderId: string; deliveryId: string } | null>(null);
  const scanField = useRef<HTMLInputElement>(null);
  // The props the queued scan handlers read — a handler may run after a
  // navigation it did not see.
  const latest = useRef({ order, openRows, scanRows, rows, overDeliveryPercent, batchRows, serialModes, locationId, blockedText });
  useEffect(() => {
    latest.current = { order, openRows, scanRows, rows, overDeliveryPercent, batchRows, serialModes, locationId, blockedText };
  });

  // Frakt: "Boka transport" on the result block only when freight is
  // enabled under System → Frakt — fetched once; an error hides the button.
  const [freightEnabled, setFreightEnabled] = useState(false);
  useEffect(() => {
    apiFetch<{ enabled: boolean }>("/api/v1/freight-settings/status")
      .then((r) => setFreightEnabled(r.enabled))
      .catch(() => setFreightEnabled(false));
  }, []);

  const openArticleKey = useMemo(
    () => Array.from(new Set(openRows.map((r) => r.articleId))).sort().join(","),
    [openRows]
  );
  useEffect(() => {
    setRowLocations({});
    setRowBatches({});
    setRowSerialIds({});
    setRowGivenSerials({});
  }, [selectedId]);
  useEffect(() => {
    if (!openArticleKey) {
      setBalances({});
      return;
    }
    let cancelled = false;
    const ids = openArticleKey.split(",");
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    Promise.all(
      chunks.map((chunk) =>
        apiFetch<{ rows: ArticleLocationBalance[] }>(`/api/v1/stock/balances?articleIds=${chunk.join(",")}&limit=1000`)
      )
    )
      .then((pages) => {
        if (cancelled) return;
        const byArticle: Record<string, ArticleLocationBalance[]> = {};
        for (const b of pages.flatMap((p) => p.rows)) (byArticle[b.articleId] ??= []).push(b);
        setBalances(byArticle);
      })
      .catch(() => {
        // The per-row choice just offers no balances; Som ovan still works.
        if (!cancelled) setBalances({});
      });
    return () => {
      cancelled = true;
    };
  }, [openArticleKey, rows]);

  const locationOptions: LocationOption[] =
    scannedLocation && !locations.some((l) => l.id === scannedLocation.id) ? [...locations, scannedLocation] : locations;

  function goToOrder(id: string) {
    setCount(NO_COUNT);
    setLastRowId(null);
    setRowErrors({});
    setFormError(null);
    setDone(null);
    router.replace(`/forsaljning/utleverans?order=${id}`);
  }

  // The SearchPicker also fires onChange(null) while the user is typing (it
  // invalidates the previous pick) — only a definite pick should navigate.
  function selectOrder(next: SalesOrder | null) {
    if (!next) return;
    clearFeedback();
    goToOrder(next.id);
  }

  const numberText = (cell: { batchNumber: string | null }, rowId?: string) => {
    const row = latest.current.openRows.find((r) => r.id === rowId) ?? null;
    return `${cell.batchNumber ?? ""}${row ? ` — ${articleLabel({ articleNumber: row.articleNumber, name: row.articleName })}` : ""}`;
  };
  const placeText = (cell: { warehouseName: string | null; locationName: string | null }) =>
    cell.locationName ? `${cell.warehouseName ? `${cell.warehouseName} — ` : ""}${cell.locationName}` : "en annan lagerplats";

  // A scanned serienummer: picks the number on its row (Serienummer), and
  // Leverera nu follows the picked numbers. true = the scan was a
  // serienummer of this order (handled, whatever came of it).
  function applySerialScan(serialNumber: string, articleIds: string[] | null): boolean {
    const { openRows: currentOpen, batchRows: cells, serialModes: modes, locationId: place, overDeliveryPercent: allowed } = latest.current;
    const serialRows = currentOpen
      .filter((r) => isStockSerial(r.articleTracking, modes, r.articleId))
      .map((r) => {
        const left = Number(r.quantityOrdered) - Number(r.quantityDelivered);
        return {
          id: r.id,
          articleId: r.articleId,
          remainingStyck: left,
          // One styck per number: the allowed överleverans in whole styck.
          maxStyck: allowed === null ? null : Math.floor(Number(r.quantityOrdered) * (1 + allowed / 100) - Number(r.quantityDelivered) + 1e-9),
          date: salesScanDate(r, latest.current.order),
          locationId: rowLocationsRef.current[r.id] || place || null,
        };
      });
    const outcome = matchSerialScan(serialNumber, cells, serialRows, rowSerialIdsRef.current, articleIds);
    if (!outcome) return false;
    switch (outcome.kind) {
      case "picked": {
        const row = currentOpen.find((r) => r.id === outcome.rowId)!;
        setRowSerialIds((prev) => ({ ...prev, [row.id]: [...(prev[row.id] ?? []), outcome.serialId] }));
        setCount({
          counting: true,
          quantities: { ...countRef.current.quantities, [row.id]: String(toUnitQuantity(outcome.count, row.unitFactor)) },
        });
        setLastRowId(row.id);
        setDone(null);
        const text = `Serienummer ${numberText(outcome.cell, row.id)}: ${outcome.count} av ${serialRows.find((r) => r.id === row.id)!.remainingStyck}`;
        if (outcome.over) warn(`${text} — överleverans`);
        else ok(text);
        return true;
      }
      case "already":
        setLastRowId(outcome.rowId);
        warn(`Serienummer ${numberText(outcome.cell, outcome.rowId)} är redan plockat`);
        return true;
      case "blocked":
        warn(`Serienummer ${outcome.cell.batchNumber} står på en spärrad lagerplats (${placeText(outcome.cell)}) — uttag görs inte därifrån`);
        return true;
      case "otherLocation":
        setLastRowId(outcome.rowId);
        warn(`Serienummer ${numberText(outcome.cell, outcome.rowId)} står på ${placeText(outcome.cell)}, inte på radens valda lagerplats`);
        return true;
      case "full":
        warn(`Överplock — serienummer ${outcome.cell.batchNumber}: raden är redan plockad`);
        return true;
    }
  }

  // A scanned batch: chooses the batch on its row (Batch). Returns the row
  // the batch is chosen on (null = not chosen, already explained), or
  // undefined when the scan was no batch of this order.
  function applyBatchScan(batchNumber: string, articleIds: string[] | null): string | null | undefined {
    const { openRows: currentOpen, batchRows: cells, locationId: place } = latest.current;
    const batchScanRows = currentOpen
      .filter((r) => r.articleBatchTracked)
      .map((r) => ({
        id: r.id,
        articleId: r.articleId,
        chosen: rowBatchesRef.current[r.id] ?? BATCH_AUTO,
        date: salesScanDate(r, latest.current.order),
        locationId: rowLocationsRef.current[r.id] || place || null,
      }));
    const outcome = matchBatchScan(batchNumber, cells, batchScanRows, articleIds);
    if (!outcome) return undefined;
    switch (outcome.kind) {
      case "chosen":
        setRowBatches((prev) => ({ ...prev, [outcome.rowId]: outcome.batchId }));
        setLastRowId(outcome.rowId);
        ok(`Batch ${numberText(outcome.cell, outcome.rowId)} vald`);
        return outcome.rowId;
      case "otherBatch":
        setLastRowId(outcome.rowId);
        warn(`Batch ${numberText(outcome.cell, outcome.rowId)}: raden har redan en annan batch vald — en batch per rad, dela leveransen eller byt batch på raden`);
        return null;
      case "blocked":
        warn(`Batch ${outcome.cell.batchNumber} står på en spärrad lagerplats (${placeText(outcome.cell)}) — uttag görs inte därifrån`);
        return null;
      case "otherLocation":
        setLastRowId(outcome.rowId);
        warn(`Batch ${numberText(outcome.cell, outcome.rowId)} finns inte på radens valda lagerplats — den står på ${placeText(outcome.cell)}`);
        return null;
    }
  }

  function applyCount(article: ArticleMatch, onlyRowId?: string, note?: string) {
    const outcome = countScan(latest.current.scanRows, countRef.current, article.id, onlyRowId);
    if (!outcome.counted && !outcome.full) return;
    setLastRowId(outcome.rowId);
    const row = latest.current.openRows.find((r) => r.id === outcome.rowId);
    const amount = `${outcome.quantity} av ${outcome.remaining} ${row?.unitCode ?? ""}`.trim() + (note ? ` — ${note}` : "");
    const allowed = latest.current.overDeliveryPercent;
    const allowance = allowed ? `tillåten överleverans ${allowed.toLocaleString("sv-SE")} %` : null;
    if (!outcome.counted) {
      warn(`Överplock — ${articleLabel(article)} är redan plockad (${amount}${allowance ? `, ${allowance}` : ""})`);
      return;
    }
    setCount(outcome.state);
    setDone(null);
    if (outcome.over) {
      warn(`${articleLabel(article)}: ${amount} — överleverans${allowance ? ` (${allowance})` : ""}`);
    } else {
      ok(`${articleLabel(article)}: ${amount}`);
    }
  }

  const onScan = useScanQueue(handleScan, warn);

  async function handleScan(code: string, matches: ScanMatch[], gs1: ScanGs1 | null) {
    const { order: current, scanRows: currentRows, rows: allRows } = latest.current;
    const intent = resolveOrderScan(
      matches,
      "salesOrder",
      current ? { openRows: currentRows, articleIds: allRows.map((r) => r.articleId) } : null
    );
    // An order that cannot be delivered has no rows to count on: an article
    // scan gets the reason, not "redan levererad" / "finns inte på".
    const blocked = latest.current.blockedText;
    if (blocked && ["count", "articleManual", "articleDone", "articleNotOnOrder"].includes(intent.kind)) {
      warn(blocked);
      return;
    }
    switch (intent.kind) {
      case "location": {
        const m = intent.match;
        const text = `Lagerplats: ${m.warehouseName} — ${m.name}`;
        // A spärrad lagerplats is never drawn from (409 stock-location-blocked): not selected.
        if (m.blocked) {
          warn(`${text} — spärrad, uttag görs inte därifrån`);
          return;
        }
        if (!locations.some((l) => l.id === m.id)) {
          setScannedLocation({ id: m.id, name: m.name, warehouseName: m.warehouseName });
        }
        setLocationId(m.id);
        if (m.active) ok(text);
        else warn(`${text} — inaktiv, det finns inget saldo på den`);
        return;
      }
      case "count": {
        const article = intent.match;
        // A GS1 code named the article and, next to it, a serienummer or a
        // batch: the number is picked / the batch chosen on the row.
        const row = latest.current.openRows.find((r) => r.articleId === article.id && isScannableRow(r));
        if (gs1?.serial && row && isStockSerial(row.articleTracking, latest.current.serialModes, row.articleId)) {
          if (!applySerialScan(gs1.serial, [article.id])) {
            warn(`Serienummer ${gs1.serial} finns inte i lager — ${articleLabel(article)}`);
          }
          return;
        }
        if (gs1?.batch && row?.articleBatchTracked) {
          const rowId = applyBatchScan(gs1.batch, [article.id]);
          if (rowId === undefined) warn(`Batch ${gs1.batch} finns inte i lager — ${articleLabel(article)}`);
          else if (rowId !== null) applyCount(article, rowId, `batch ${gs1.batch}`);
          return;
        }
        applyCount(article);
        return;
      }
      case "order": {
        const m = intent.match;
        if (m.id === current?.id) {
          ok(`${m.orderNumber} är redan vald`);
          return;
        }
        if (m.status !== "in_production") {
          warn(`${m.orderNumber} kan inte levereras — ${SALES_ORDER_STATUS_PILL[m.status as SalesOrderStatus]?.label ?? m.status}`);
          return;
        }
        if (hasCounted(countRef.current) && !(await confirmDialog(`Byta till ${m.orderNumber}? Det du har plockat på ${current?.orderNumber} levereras inte.`, { confirmLabel: "Byt order" }))) {
          return;
        }
        ok(`${m.orderNumber} — ${m.partyName}`);
        goToOrder(m.id);
        return;
      }
      case "articleManual":
        warn(`${articleLabel(intent.match)} räknas inte vid plock — skriv antalet för hand`);
        return;
      case "articleDone":
        warn(`${articleLabel(intent.match)} är redan levererad på ${current?.orderNumber}`);
        return;
      case "articleNotOnOrder":
        warn(`${articleLabel(intent.match)} finns inte på ${current?.orderNumber}`);
        return;
      case "articleWithoutOrder":
        warn(`Skanna eller välj kundordern först — ${articleLabel(intent.match)}`);
        return;
      case "wrongKind":
        warn(
          `${code} är en ${intent.match.kind === "purchaseOrder" ? "inköpsorder" : "tillverkningsorder"} — skanna en kundorder, en artikel eller en lagerplats`
        );
        return;
      case "unknown": {
        // No article, order or place: the number itself — a serienummer
        // that stands in stock for a row here, or a batch (which is chosen,
        // not counted: the code named no article to count).
        const serialNumber = gs1 ? gs1.serial : code;
        const batchNumber = gs1 ? gs1.batch : code;
        if (current && serialNumber && applySerialScan(serialNumber, null)) return;
        if (current && batchNumber && applyBatchScan(batchNumber, null) !== undefined) return;
        warn(`Ingen träff för ${code}`);
        return;
      }
    }
  }

  async function resetToRemaining() {
    if (hasCounted(count) && !(await confirmDialog("Det du har plockat ersätts med restantalen.", { confirmLabel: "Fyll i restantal" }))) {
      return;
    }
    setCount(NO_COUNT);
    setLastRowId(null);
    clearFeedback();
  }

  async function report() {
    setRowErrors({});
    setFormError(null);
    setDone(null);

    const toDeliver = openRows
      .map((row) => ({ row, quantity: Number(enteredQuantity(scanRowOf(row), count)) }))
      .filter(({ quantity }) => quantity > 0);
    if (toDeliver.length === 0 || !selectedId) return;
    const deliveredOrderId = selectedId;

    // Vid utleverans: the numbers shown must be one per styck.
    const serialErrors: Record<string, string> = {};
    for (const { row, quantity } of toDeliver) {
      if (!deliverySerial(row)) continue;
      const given = rowGivenSerials[row.id] ?? [];
      const styck = toBaseQuantity(quantity, row.unitFactor);
      if (given.length > 0 && given.length !== styck) {
        serialErrors[row.id] = `Ange ett serienummer per styck — ${given.length} av ${styck} angivna.`;
      }
    }
    if (Object.keys(serialErrors).length > 0) {
      setRowErrors(serialErrors);
      return;
    }

    setPending(true);
    try {
      const result = await apiFetch<{ deliveryId: string; deliveryNumber: string; orderStatus: string; assignedSerials?: { rowId: string; serialNumbers: string[] }[] }>(
        `/api/v1/sales-orders/${selectedId}/deliver`,
        {
          method: "POST",
          body: JSON.stringify({
            locationId: locationId || undefined,
            rows: toDeliver.map(({ row, quantity }) => ({
              rowId: row.id,
              quantity: toBaseQuantity(quantity, row.unitFactor),
              // Only a row that overrides the field above carries its own plats.
              locationId:
                rowLocations[row.id] ||
                (row.articleBatchTracked
                  ? expiredBatchLocationId(batchRows, row.articleId, rowBatches[row.id] ?? BATCH_AUTO, locationId)
                  : undefined) ||
                undefined,
              ...(row.articleBatchTracked ? batchIdField(rowBatches[row.id] ?? BATCH_AUTO) : {}),
              ...(stockSerial(row) && (rowSerialIds[row.id] ?? []).length > 0 ? { serialIds: rowSerialIds[row.id] } : {}),
              ...(deliverySerial(row) && (rowGivenSerials[row.id] ?? []).length > 0 ? { serialNumbers: rowGivenSerials[row.id] } : {}),
            })),
          }),
        }
      );
      // Serienummer given at the delivery, per row.
      const assignedText = (result.assignedSerials ?? [])
        .map((a) => `${openRows.find((r) => r.id === a.rowId)?.articleNumber ?? ""} ${compressSerialNumbers(a.serialNumbers)}`.trim())
        .join("; ");
      setDone({
        message: `${toDeliver.length} rad${toDeliver.length === 1 ? "" : "er"} utlevererade${assignedText ? ` — serienummer: ${assignedText}` : ""}`,
        orderId: deliveredOrderId,
        deliveryId: result.deliveryId,
        deliveryNumber: result.deliveryNumber,
      });
      notify({
        message: `Utlevererat ${toDeliver.length} rad${toDeliver.length === 1 ? "" : "er"} på ${order?.orderNumber ?? ""} — följesedel ${result.deliveryNumber}.${assignedText ? ` Serienummer: ${assignedText}.` : ""}`,
        action: {
          label: "Ångra…",
          run: async () => {
            setUndoDelivery({ orderId: deliveredOrderId, deliveryId: result.deliveryId });
            return null;
          },
        },
      });
      setCount(NO_COUNT);
      setLastRowId(null);
      setRowLocations({});
      setRowBatches({});
      setRowSerialIds({});
      setRowGivenSerials({});
      reloadBatches();
      clearFeedback();
      // Pallkort: auto-open the cards for the delivery (one page per row) —
      // best effort (a popup blocker may stop it); the Pallkort (PDF) link
      // in the result block is the always-there fallback.
      window.open(`/api/v1/deliveries/${result.deliveryId}/pallet-card`, "_blank", "noopener");
    } catch (err) {
      const message = apiErrorMessage(err, "Kunde inte leverera");
      // The API names the row only for sales-order-row-not-found (its English
      // text carries the row id); over-delivery names none, but its rows are
      // the ones whose entered amount exceeds what the row may take, so they
      // are found the same way the scan rules find them. Anything else (a
      // blocked location, a wrong status) stays at the button.
      const apiCode = err instanceof ApiError ? err.code : undefined;
      const apiText = err instanceof ApiError ? err.message : "";
      let attributed: string[] = [];
      if (apiCode === "sales-order-row-not-found") {
        attributed = toDeliver.filter(({ row }) => apiText.includes(row.id)).map(({ row }) => row.id);
      } else if (apiCode === "over-delivery") {
        attributed = toDeliver
          .filter(({ row, quantity }) => {
            const max = scanRowOf(row).max;
            return max !== null && quantity > max;
          })
          .map(({ row }) => row.id);
      }
      if (attributed.length > 0) {
        setRowErrors(Object.fromEntries(attributed.map((id) => [id, message])));
      } else {
        setFormError(message);
      }
    }
    setPending(false);
    router.refresh();
  }

  // Serienummer under "Leverera nu": picked in stock, or given at the delivery.
  function serialControl(row: SalesOrderRow) {
    if (stockSerial(row)) {
      return (
        <SerialCellPicker
          ariaLabel={`Serienummer — ${row.articleNumber}`}
          rows={batchRows}
          articleId={row.articleId}
          locationId={rowLocations[row.id] || locationId || null}
          value={rowSerialIds[row.id] ?? []}
          onChange={(next) => {
            setRowSerialIds((prev) => ({ ...prev, [row.id]: next }));
            // One styck per number: Leverera nu follows the picked numbers.
            const quantities = { ...countRef.current.quantities };
            if (next.length > 0) quantities[row.id] = String(toUnitQuantity(next.length, row.unitFactor));
            else delete quantities[row.id];
            setCount({ ...countRef.current, quantities });
          }}
        />
      );
    }
    if (deliverySerial(row)) {
      return (
        <DeliverySerialsField
          ariaLabel={`Serienummer — ${row.articleNumber}`}
          articleId={row.articleId}
          count={serialCountOf(toBaseQuantity(Number(enteredQuantity(scanRowOf(row), count)), row.unitFactor))}
          value={rowGivenSerials[row.id] ?? []}
          onChange={(next) => setRowGivenSerials((prev) => ({ ...prev, [row.id]: next }))}
        />
      );
    }
    return null;
  }


  const pill = order ? SALES_ORDER_STATUS_PILL[order.status] : null;
  // Kvar att plocka, shown once counting has started.
  const rowsLeft = count.counting ? scanRows.filter((r) => (leftToCount(r, count) ?? 0) > 0).length : 0;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Utleverans</div>
          <div className={shellStyles.meta}>Rapportera leverans mot kundorder</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="utleverans" label="Hjälp om utleverans" />
      </div>

      <ScanPanel
        inputRef={scanField}
        placeholder="Skanna kundorder, artikel eller lagerplats…"
        onScan={onScan}
        feedback={feedback}
      />

      <div className={styles.controls}>
        <Field label="Kundorder" htmlFor="deliveryOrder">
          <SearchPicker
            id="deliveryOrder"
            endpoint="/api/v1/sales-orders?status=in_production&withOpenRows=true"
            value={order}
            onChange={selectOrder}
            formatLabel={(o) => `${o.orderNumber} — ${o.customerName}`}
            placeholder="Sök ordernummer, kund, artikelnummer eller benämning…"
            emptyText="Inga kundordrar under tillverkning matchar sökningen"
            renderOption={(o) => (
              <span className={styles.optionRows}>
                <span className={styles.optionTitle}>
                  {o.orderNumber} — {o.customerName}
                </span>
                <span className={styles.optionMeta}>
                  {formatStockholmDate(o.createdAt)} · {SALES_ORDER_STATUS_PILL[o.status].label}
                  {o.openRowCount != null ? ` · ${o.openRowCount} restrad${o.openRowCount === 1 ? "" : "er"}` : ""}
                </span>
              </span>
            )}
          />
        </Field>
        {locationOptions.length > 0 && (
          <Field label="Lagerplats" htmlFor="deliveryLocation">
            <Select id="deliveryLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Automatiskt</option>
              {outflowLocationChoices(locationOptions).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.warehouseName} — {l.name}
                </option>
              ))}
            </Select>
            <FormHint>Tas från artikelns lagerplats och sedan från andra platser med saldo.</FormHint>
          </Field>
        )}
        {order && pill && (
          <div className={styles.orderStatus}>
            <StatusPill status={pill.status} label={pill.label} />
            <Link href={`/forsaljning/ordrar/${order.id}`} style={{ fontWeight: 600, color: "inherit" }}>
              Öppna {order.orderNumber}
            </Link>
            <a
              href={`/api/v1/sales-orders/${order.id}/pick-list`}
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              download
            >
              Plocklista (PDF)
            </a>
          </div>
        )}
      </div>

      {done && (
        <div className={styles.done}>
          <p style={{ fontWeight: 600, margin: 0 }}>{done.message}</p>
          <a
            href={`/api/v1/deliveries/${done.deliveryId}/pdf`}
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Följesedel {done.deliveryNumber} (PDF)
          </a>
          <button
            type="button"
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            onClick={() => setPalletCardDeliveryId(done.deliveryId)}
          >
            Pallkort (PDF)
          </button>
          <PalletCardDialog
            target={palletCardDeliveryId ? { kind: "delivery", deliveryId: palletCardDeliveryId } : null}
            onClose={() => setPalletCardDeliveryId(null)}
          />
          <BookTransportButton deliveryId={done.deliveryId} shipment={null} enabled={freightEnabled} />
          <button
            type="button"
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            onClick={() => setUndoDelivery({ orderId: done.orderId, deliveryId: done.deliveryId })}
          >
            Ångra…
          </button>
        </div>
      )}
      {undoDelivery && (
        <UndoDeliveryDialog
          orderId={undoDelivery.orderId}
          deliveryId={undoDelivery.deliveryId}
          open
          onClose={() => setUndoDelivery(null)}
        />
      )}

      {blockedText && <FormNotice role="status">{blockedText}</FormNotice>}

      {(!order || blockedText) && (
        <div className={styles.openOrders}>
          <SectionHeading>Levererbara ordrar</SectionHeading>
          <Table<SalesOrder>
            columns={[
              { key: "orderNumber", label: "Ordernummer", width: "140px" },
              { key: "customerName", label: "Kund", width: "1fr" },
              { key: "createdAt", label: "Orderdatum", width: "130px" },
              { key: "status", label: "Status", width: "160px" },
              { key: "openRowCount", label: "Restrader", width: "110px", align: "right" },
            ]}
            rows={openOrders}
            emptyText="Inga ordrar väntar på utleverans."
            renderCell={(o, key) => {
              switch (key) {
                case "orderNumber":
                  return (
                    <button type="button" className={styles.rowLink} onClick={() => selectOrder(o)}>
                      {o.orderNumber}
                    </button>
                  );
                case "customerName":
                  return o.customerName;
                case "createdAt":
                  return formatStockholmDate(o.createdAt);
                case "status": {
                  const p = SALES_ORDER_STATUS_PILL[o.status];
                  return <StatusPill status={p.status} label={p.label} compact />;
                }
                case "openRowCount":
                  return o.openRowCount ?? "–";
                default:
                  return null;
              }
            }}
          />
        </div>
      )}

      {order && remainingRows.length === 0 && <p>Alla rader på ordern är redan levererade.</p>}

      {order && openRows.length > 0 && (
        <>
          {count.counting && (
            <div className={styles.countingNote}>
              <span>
                Räknar plockade artiklar — rader med 0 levereras inte.{" "}
                <strong>
                  {rowsLeft === 0 ? "Allt är plockat." : `Kvar att plocka på ${rowsLeft} rad${rowsLeft === 1 ? "" : "er"}.`}
                </strong>
              </span>
              <Button type="button" variant="secondary" size="small" onClick={() => void resetToRemaining()}>
                Fyll i restantal
              </Button>
            </div>
          )}
          <Table<SalesOrderRow>
            columns={[
              // Narrower than Inleverans' columns: counting adds Kvar att
              // plocka and the row must still fit beside the menu.
              { key: "articleNumber", label: "Artikelnummer", width: "130px" },
              { key: "articleName", label: "Benämning", width: "1fr" },
              { key: "quantityOrdered", label: "Beställt", width: "80px", align: "right" },
              { key: "unitCode", label: "Enhet", width: "60px" },
              { key: "quantityDelivered", label: "Levererat", width: "80px", align: "right" },
              { key: "remaining", label: "Rest", width: "70px", align: "right" },
              ...(count.counting
                ? [{ key: "left", label: "Kvar att plocka", width: "110px", align: "right" as const }]
                : []),
              { key: "location", label: "Lagerplats", width: "190px" },
              ...(trackedArticleIds.length > 0 ? [{ key: "batch", label: "Batch", width: "170px" }] : []),
              // Serienummer sit under the amount (no column of their own: the
              // table would overflow beside the menu).
              { key: "id", label: "Leverera nu", width: hasSerialRows ? "240px" : "180px", align: "right" },
            ]}
            rows={openRows}
            highlightedRowId={lastRowId}
            renderCell={(row, key) => {
              switch (key) {
                case "quantityOrdered":
                case "quantityDelivered":
                  return toUnitQuantity(Number(row[key]), row.unitFactor);
                case "remaining":
                  return (
                    <strong>
                      {toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityDelivered), row.unitFactor)}
                    </strong>
                  );
                case "left": {
                  const left = leftToCount(scanRowOf(row), count);
                  return left === null ? "–" : left;
                }
                case "location": {
                  const onHand = (balances[row.articleId] ?? []).filter((b) => Number(b.quantityOnHand) > 0 && !b.locationBlocked);
                  return (
                    <Select
                      aria-label={`Lagerplats — ${row.articleNumber}`}
                      value={rowLocations[row.id] ?? ""}
                      onChange={(e) => setRowLocations((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      style={{ maxWidth: "100%" }}
                    >
                      <option value="">Som ovan</option>
                      {onHand.map((b) => (
                        <option key={b.locationId} value={b.locationId}>
                          {b.warehouseName} — {b.locationName} ({Number(b.quantityOnHand).toLocaleString("sv-SE")}{" "}
                          {b.unitCode})
                        </option>
                      ))}
                    </Select>
                  );
                }
                case "batch":
                  return row.articleBatchTracked ? (
                    <BatchSelect
                      aria-label={`Batch — ${row.articleNumber}`}
                      rows={batchRows}
                      articleId={row.articleId}
                      locationId={rowLocations[row.id] || locationId || null}
                      value={rowBatches[row.id] ?? BATCH_AUTO}
                      onChange={(v) => setRowBatches((prev) => ({ ...prev, [row.id]: v }))}
                    />
                  ) : null;
                case "id":
                  return (
                    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        size="sm"
                        aria-label={`Leverera nu — ${row.articleNumber}`}
                        value={enteredQuantity(scanRowOf(row), count)}
                        onChange={(e) =>
                          setCount({ ...countRef.current, quantities: { ...countRef.current.quantities, [row.id]: e.target.value } })
                        }
                        // Enter hands the next scan back to the scan field.
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          scanField.current?.focus();
                        }}
                      />
                      {serialControl(row)}
                      {(() => {
                        const warning = configuredDeliveryWarning(
                          row,
                          toBaseQuantity(Number(enteredQuantity(scanRowOf(row), count)), row.unitFactor)
                        );
                        return warning ? <FormNotice>{warning}</FormNotice> : null;
                      })()}
                      {rowErrors[row.id] && (
                        <FormError inline>{rowErrors[row.id]}</FormError>
                      )}
                    </span>
                  );
                default:
                  // E3 added non-primitive row fields (manufacturingOrders) to
                  // SalesOrderRow; the default fallback is only ever reached
                  // for plain string columns (articleNumber/articleName/
                  // unitCode) here, so String() keeps those unchanged while
                  // widening the switch's return type to something
                  // ReactNode-compatible.
                  return String(row[key as keyof SalesOrderRow] ?? "");
              }
            }}
          />

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <Button type="button" variant="primary" disabled={pending} onClick={report}>
              {pending ? "Rapporterar…" : "Rapportera utleverans"}
            </Button>
          </div>
          <FormError margin="above">{formError}</FormError>
        </>
      )}
    </>
  );
}
