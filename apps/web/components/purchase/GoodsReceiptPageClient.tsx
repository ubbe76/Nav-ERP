"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { ScanPanel } from "../ui/ScanInput";
import { useCountState, useScanFeedback, useScanQueue, useScanState } from "../ui/useOrderScan";
import { apiFetch } from "../../lib/api";
import { locationOptionLabel } from "../../lib/stockLocations";
import { confirmDialog } from "../../lib/confirm";
import { notify } from "../../lib/notice";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import { SERIAL_NUMBERS_MAX, serialCountOf } from "../../lib/serialInput";
import { SerialNumbersInput, isStockSerial, useSerialModes } from "../stock/SerialNumbers";
import {
  countScan,
  enteredQuantity,
  hasCounted,
  isScannableRow,
  placeBatchScan,
  purchaseScanDate,
  receiptScanFields,
  resolveOrderScan,
  serialScanDuplicate,
  serialScanRow,
  type OrderCountState,
  type OrderScanRow,
} from "../../lib/orderScan";
import {
  PURCHASE_ORDER_STATUS_PILL,
  type Paged,
  type PurchaseOrder,
  type PurchaseOrderRow,
  type PurchaseOrderStatus,
  type ScanGs1,
  type ScanMatch,
  type StockLocation,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError } from "../ui/Form";
import styles from "./GoodsReceiptPageClient.module.css";
import { formatStockholmDate } from "../../lib/date";

const RECEIVABLE: PurchaseOrderStatus[] = ["confirmed", "partially_received"];
const NO_COUNT: OrderCountState = { counting: false, quantities: {} };

type ArticleMatch = Extract<ScanMatch, { kind: "article" }>;
type LocationOption = Pick<StockLocation, "id" | "name" | "warehouseName">;

// Batch (#8): one batch number per batch-tracked row (empty = the order's
// number) plus extra parts when the row is split over several batches.
interface BatchPart {
  key: number;
  quantity: string;
  batchNumber: string;
  expiresOn: string;
}
interface RowBatches {
  batchNumber: string;
  expiresOn: string;
  parts: BatchPart[];
}
const NO_BATCHES: RowBatches = { batchNumber: "", expiresOn: "", parts: [] };

const articleLabel = (a: { articleNumber: string; name: string }) => `${a.articleNumber} · ${a.name}`;

// Inleverans routine — report a whole goods receipt in one go. Quantities are
// prefilled with each row's remaining amount; rows set to 0 are skipped. Each
// row is booked via the existing per-row endpoint (atomic per row, order
// status recomputed per call).
//
// Skanning (#4, etapp 2): the scan field takes an IO number (picks the
// order), a lagerplats label (picks the location) or an article/EAN, which
// counts one per scan on the article's row — the first article scan clears
// the prefilled amounts, so only what was counted is received (the rules are
// lib/orderScan.ts, shared with Utleverans).
//
// GS1 (#8 etapp 2 steg 6): a code that carries a batch (AI 10) and an
// utgångsdatum (17) counts in that batch on a batchstyrd rad — the row's
// Batch/Utgångsdatum are filled when empty (a typed value is never
// overwritten), another batch than the row's becomes a batch part. On a
// serienummerrad a code with a serienummer (21) adds the number to the
// row's list; scanned without one, the row waits for its numbers — the next
// codes that are nothing else are taken as them. Everything scanned lands in
// fields shown on the row, to be checked before Rapportera.
export function GoodsReceiptPageClient({
  locations,
  selected,
  rows,
  openOrders,
}: {
  locations: StockLocation[];
  selected: PurchaseOrder | null;
  rows: PurchaseOrderRow[];
  // Every receivable order (status confirmed/partially_received) — browsable
  // list shown below the picker while no order is selected, so the routine
  // works without knowing the order number (like Monitor's ankomstlista).
  openOrders: PurchaseOrder[];
}) {
  const router = useRouter();
  const order = selected;
  const selectedId = order?.id ?? null;
  const openRows = useMemo(
    () => rows.filter((r) => Number(r.quantityReceived) < Number(r.quantityOrdered)),
    [rows]
  );
  // The open rows as the scan rules see them: remaining in the row's unit.
  const scanRows = useMemo<OrderScanRow[]>(
    () =>
      openRows.map((r) => ({
        id: r.id,
        articleId: r.articleId,
        remaining: toUnitQuantity(Number(r.quantityOrdered) - Number(r.quantityReceived), r.unitFactor),
        scannable: isScannableRow(r),
        // The over-receipt tolerance is the server's to apply.
        max: null,
        date: purchaseScanDate(r, order),
      })),
    [openRows, order]
  );

  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  // A scanned lagerplats that GET /stock/locations leaves out (inactive — a
  // receipt into it reactivates it), added to the select so it can be shown.
  const [scannedLocation, setScannedLocation] = useState<LocationOption | null>(null);
  const { count, countRef, setCount } = useCountState(NO_COUNT);
  useUnsavedGuard(hasCounted(count));
  const { feedback, ok, warn, clear: clearFeedback } = useScanFeedback();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [batches, batchesRef, setBatches] = useScanState<Record<string, RowBatches>>({});
  // Serienummer (#8 etapp 2) per row: one number per styck, for the articles
  // whose numbers are created at the receipt.
  const [serials, serialsRef, setSerials] = useScanState<Record<string, string[]>>({});
  // The serienummerrad that an article scan without a number left waiting
  // for its numbers.
  const awaitingSerialRow = useRef<string | null>(null);
  const serialModes = useSerialModes(openRows.map((r) => ({ articleId: r.articleId, tracking: r.articleTracking })));
  const nextPartKey = useRef(1);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [lastRowId, setLastRowId] = useState<string | null>(null);
  // An article scanned before an order was chosen that is open on several
  // orders: the list narrows to them until one is picked.
  const [articleOrders, setArticleOrders] = useState<{ article: ArticleMatch; orders: PurchaseOrder[]; gs1: ScanGs1 | null } | null>(null);
  // The scan that chose the order: counted once the order's rows have loaded.
  const pendingCount = useRef<{ orderId: string; article: ArticleMatch; gs1: ScanGs1 | null } | null>(null);
  const scanField = useRef<HTMLInputElement>(null);
  // A queued scan that switched order waits here until the new order has
  // loaded, so the next scan in the queue counts against it, not the old one.
  const orderWaiter = useRef<{ orderId: string; resolve: () => void } | null>(null);
  function waitForOrder(orderId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        orderWaiter.current = null;
        resolve();
      }, 5000);
      orderWaiter.current = {
        orderId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
  }
  // The props the queued scan handlers read — a handler may run after a
  // navigation it did not see.
  const latest = useRef({ order, openRows, scanRows, rows, serialModes });
  useEffect(() => {
    latest.current = { order, openRows, scanRows, rows, serialModes };
    const waiter = orderWaiter.current;
    if (waiter && waiter.orderId === selectedId) {
      orderWaiter.current = null;
      waiter.resolve();
    }
  });

  const locationOptions: LocationOption[] =
    scannedLocation && !locations.some((l) => l.id === scannedLocation.id) ? [...locations, scannedLocation] : locations;

  function goToOrder(id: string) {
    setCount(NO_COUNT);
    setBatches({});
    setSerials({});
    awaitingSerialRow.current = null;
    setRowErrors({});
    setDone(null);
    setLastRowId(null);
    setArticleOrders(null);
    router.replace(`/inkop/inleverans?order=${id}`);
  }

  // The SearchPicker also fires onChange(null) while the user is typing (it
  // invalidates the previous pick) — only a definite pick should navigate.
  async function selectOrder(next: PurchaseOrder | null) {
    if (!next) return;
    // The same question as switching by scanning — the counted quantities
    // would go without a word.
    if (
      next.id !== latest.current.order?.id &&
      hasCounted(countRef.current) &&
      !(await confirmDialog(`Byta till ${next.orderNumber}? Det du har räknat på ${latest.current.order?.orderNumber ?? "ordern"} tas inte emot.`, { confirmLabel: "Byt order" }))
    ) {
      return;
    }
    pendingCount.current = null;
    clearFeedback();
    goToOrder(next.id);
  }

  // How the row's article is tracked in stock, as the scan rules ask: a
  // serienummerrad only when the numbers are created at the receipt.
  function rowTracking(row: PurchaseOrderRow): "batch" | "serial" | null {
    if (isStockSerial(row.articleTracking, latest.current.serialModes, row.articleId)) return "serial";
    return row.articleBatchTracked ? "batch" : null;
  }

  // The serienummerrader of an article, in styck (one number each).
  function serialRowsOf(articleId: string) {
    return latest.current.openRows
      .filter((r) => r.articleId === articleId && rowTracking(r) === "serial")
      .map((r) => ({
        id: r.id,
        articleId: r.articleId,
        remainingStyck: Number(r.quantityOrdered) - Number(r.quantityReceived),
        maxStyck: null,
        date: purchaseScanDate(r, latest.current.order),
      }));
  }

  // A scanned serienummer into a row's list; Ta emot nu follows the list.
  function addScannedSerial(rowId: string, serialNumber: string) {
    const row = latest.current.openRows.find((r) => r.id === rowId);
    if (!row) return;
    const label = articleLabel({ articleNumber: row.articleNumber, name: row.articleName });
    setLastRowId(rowId);
    if (serialScanDuplicate(serialsRef.current, serialNumber) !== null) {
      warn(`Serienummer ${serialNumber} är redan skannat — ${label}`);
      return;
    }
    const list = [...(serialsRef.current[rowId] ?? []), serialNumber];
    if (list.length > SERIAL_NUMBERS_MAX) {
      warn(`Högst ${SERIAL_NUMBERS_MAX} serienummer åt gången — ${label}`);
      return;
    }
    setSerials((prev) => ({ ...prev, [rowId]: list }));
    setCount({
      counting: true,
      quantities: { ...countRef.current.quantities, [rowId]: String(toUnitQuantity(list.length, row.unitFactor)) },
    });
    setDone(null);
    const styck = Number(row.quantityOrdered) - Number(row.quantityReceived);
    const text = `${label}: serienummer ${serialNumber} — ${list.length} av ${styck}`;
    if (list.length > styck) warn(`${text} — mer än restantalet`);
    else ok(text);
  }

  // An article scan, with what a GS1 code said next to the article.
  function applyScan(article: ArticleMatch, gs1: ScanGs1 | null) {
    const { scanRows: currentRows, openRows: currentOpen } = latest.current;
    const serialRows = serialRowsOf(article.id);
    const serialTarget =
      serialRows.length > 0
        ? serialScanRow(serialRows, article.id, Object.fromEntries(serialRows.map((r) => [r.id, (serialsRef.current[r.id] ?? []).length]))) ?? serialRows[0]!
        : null;
    // The row an ordinary count would take (Inleverans has no cap, so there
    // always is one).
    const counted = countScan(currentRows, countRef.current, article.id);
    const targetId = serialTarget?.id ?? (counted.counted ? counted.rowId : null);
    const row = currentOpen.find((r) => r.id === targetId);
    const fields = receiptScanFields(row ? rowTracking(row) : null, gs1);
    awaitingSerialRow.current = null;
    if (!row || fields.kind === "plain") {
      applyCount(article);
      return;
    }
    if (fields.kind === "serial") {
      addScannedSerial(row.id, fields.serialNumber);
      // More numbers of the same article may follow as bare codes.
      awaitingSerialRow.current = row.id;
      return;
    }
    if (fields.kind === "awaitSerial") {
      awaitingSerialRow.current = row.id;
      setLastRowId(row.id);
      // Counting starts — the prefilled restantal cannot stand without numbers.
      setCount({ counting: true, quantities: { ...countRef.current.quantities, [row.id]: countRef.current.quantities[row.id] ?? "0" } });
      ok(`${articleLabel(article)} har serienummer — skanna serienumren, ett per styck`);
      return;
    }
    // A batch: on the row's own part, an extra part that has it, or a new one.
    const current = batchesRef.current[row.id] ?? NO_BATCHES;
    const placement = placeBatchScan(current, fields);
    if (placement.target === "main") {
      setBatches((prev) => ({ ...prev, [row.id]: { ...current, batchNumber: placement.batchNumber, expiresOn: placement.expiresOn } }));
      applyCount(article, row.id, `batch ${fields.batchNumber}`);
      return;
    }
    const parts =
      placement.target === "part"
        ? current.parts.map((p, i) => (i === placement.index ? { ...p, quantity: placement.quantity, expiresOn: placement.expiresOn } : p))
        : [...current.parts, { key: nextPartKey.current++, quantity: placement.quantity, batchNumber: placement.batchNumber, expiresOn: placement.expiresOn }];
    setBatches((prev) => ({ ...prev, [row.id]: { ...current, parts } }));
    // Counting starts here too: the row's own part is not received unasked.
    setCount({ counting: true, quantities: { ...countRef.current.quantities, [row.id]: countRef.current.quantities[row.id] ?? "0" } });
    setLastRowId(row.id);
    setDone(null);
    ok(`${articleLabel(article)}: batch ${fields.batchNumber} — ${placement.quantity} ${row.unitCode ?? ""} i egen batchdel`.replace("  ", " "));
  }

  function applyCount(article: ArticleMatch, onlyRowId?: string, note?: string) {
    const outcome = countScan(latest.current.scanRows, countRef.current, article.id, onlyRowId);
    if (!outcome.counted) return;
    setCount(outcome.state);
    setLastRowId(outcome.rowId);
    setDone(null);
    const row = latest.current.openRows.find((r) => r.id === outcome.rowId);
    const text = `${articleLabel(article)}: ${outcome.quantity} av ${outcome.remaining} ${row?.unitCode ?? ""}`.trim() + (note ? ` — ${note}` : "");
    if (outcome.over) warn(`${text} — mer än restantalet`);
    else ok(text);
  }

  // The order's rows arrive with the navigation the scan started.
  useEffect(() => {
    const waiting = pendingCount.current;
    if (!waiting || waiting.orderId !== selectedId) return;
    pendingCount.current = null;
    applyScan(waiting.article, waiting.gs1);
    // applyScan reads refs only; rerun when the order's rows arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, scanRows]);

  const onScan = useScanQueue(handleScan, warn);

  async function handleScan(code: string, matches: ScanMatch[], gs1: ScanGs1 | null) {
    const { order: current, scanRows: currentRows, rows: allRows } = latest.current;
    const intent = resolveOrderScan(
      matches,
      "purchaseOrder",
      current ? { openRows: currentRows, articleIds: allRows.map((r) => r.articleId) } : null
    );
    switch (intent.kind) {
      case "location": {
        const m = intent.match;
        if (!locations.some((l) => l.id === m.id)) {
          setScannedLocation({ id: m.id, name: m.name, warehouseName: m.warehouseName });
        }
        setLocationId(m.id);
        ok(`Lagerplats: ${m.warehouseName} — ${m.name}${m.active ? "" : " (inaktiv, aktiveras vid inleveransen)"}`);
        return;
      }
      case "count":
        applyScan(intent.match, gs1);
        return;
      case "order": {
        const m = intent.match;
        if (m.id === current?.id) {
          ok(`${m.orderNumber} är redan vald`);
          return;
        }
        if (!RECEIVABLE.includes(m.status as PurchaseOrderStatus)) {
          warn(`${m.orderNumber} kan inte tas emot — ${PURCHASE_ORDER_STATUS_PILL[m.status as PurchaseOrderStatus]?.label ?? m.status}`);
          return;
        }
        if (hasCounted(countRef.current) && !(await confirmDialog(`Byta till ${m.orderNumber}? Det du har räknat på ${current?.orderNumber} tas inte emot.`, { confirmLabel: "Byt order" }))) {
          return;
        }
        pendingCount.current = null;
        ok(`${m.orderNumber} — ${m.partyName}`);
        goToOrder(m.id);
        await waitForOrder(m.id);
        return;
      }
      case "articleManual":
        warn(`${articleLabel(intent.match)} är en tjänst — skriv antalet för hand`);
        return;
      case "articleDone":
        warn(`${articleLabel(intent.match)} är redan mottagen på ${current?.orderNumber}`);
        return;
      case "articleNotOnOrder":
        warn(`${articleLabel(intent.match)} finns inte på ${current?.orderNumber}`);
        return;
      case "articleWithoutOrder": {
        const article = intent.match;
        let found: PurchaseOrder[];
        try {
          found = (
            await apiFetch<Paged<PurchaseOrder>>(
              `/api/v1/purchase-orders?status=${RECEIVABLE.join(",")}&withOpenRows=true&openArticleId=${article.id}&limit=100`
            )
          ).rows;
        } catch (err) {
          warn(apiErrorMessage(err, "Kunde inte hämta ordrarna"));
          return;
        }
        if (found.length === 0) {
          warn(`Ingen inköpsorder väntar på ${articleLabel(article)}`);
          return;
        }
        if (found.length === 1) {
          pendingCount.current = { orderId: found[0]!.id, article, gs1 };
          goToOrder(found[0]!.id);
          await waitForOrder(found[0]!.id);
          return;
        }
        setArticleOrders({ article, orders: found, gs1 });
        ok(`${articleLabel(article)} väntas på ${found.length} ordrar — välj en`);
        return;
      }
      case "wrongKind":
        warn(
          `${code} är en ${intent.match.kind === "salesOrder" ? "kundorder" : "tillverkningsorder"} — skanna en inköpsorder, en artikel eller en lagerplats`
        );
        return;
      case "unknown": {
        // A serienummerrad is waiting for its numbers: a code that is nothing
        // else is one of them (a GS1 code without an article: its AI 21).
        const waiting = awaitingSerialRow.current;
        const serialNumber = gs1 ? gs1.serial : code;
        if (waiting && serialNumber && latest.current.openRows.some((r) => r.id === waiting)) {
          addScannedSerial(waiting, serialNumber);
          return;
        }
        warn(`Ingen träff för ${code}`);
        return;
      }
    }
  }

  // Picked from the list of orders waiting for a scanned article: that scan
  // counts on the chosen order.
  function pickArticleOrder(o: PurchaseOrder) {
    if (articleOrders) pendingCount.current = { orderId: o.id, article: articleOrders.article, gs1: articleOrders.gs1 };
    clearFeedback();
    goToOrder(o.id);
  }

  async function resetToRemaining() {
    if (hasCounted(count) && !(await confirmDialog("Det du har räknat ersätts med restantalen.", { confirmLabel: "Fyll i restantal" }))) {
      return;
    }
    setCount(NO_COUNT);
    setLastRowId(null);
    clearFeedback();
  }

  async function report() {
    setRowErrors({});
    setDone(null);
    setPending(true);
    const errors: Record<string, string> = {};
    let booked = 0;
    // The rows this run booked — after a partial failure they are set to 0 so
    // a second Rapportera after fixing the failed row never receives them
    // again (webbgranskningen 2026-11-11: the 5 counted on row A stood in Ta
    // emot nu and were received a second time; the API has no such guard —
    // every /receive is a new receipt).
    const bookedRowIds: string[] = [];
    let reportedOperations = 0;
    // The receipts this run booked — the notice's Ångra takes them back.
    const receiptIds: string[] = [];
    const orderId = selectedId;
    const orderNumber = order?.orderNumber ?? "";
    // Extra batch parts a run booked, removed from the form afterwards so a
    // second Rapportera never receives them again.
    const bookedParts: Record<string, number> = {};
    for (const row of openRows) {
      const scanRow = scanRows.find((r) => r.id === row.id)!;
      const quantity = Number(enteredQuantity(scanRow, count));
      const rowBatches = row.articleBatchTracked ? (batches[row.id] ?? NO_BATCHES) : NO_BATCHES;
      const serialRow = isStockSerial(row.articleTracking, serialModes, row.articleId);
      const rowSerials = serialRow ? (serials[row.id] ?? []) : [];
      if (serialRow && quantity > 0) {
        const styck = toBaseQuantity(quantity, row.unitFactor);
        if (rowSerials.length !== styck) {
          errors[row.id] = `Ange ett serienummer per styck — ${rowSerials.length} av ${styck} angivna.`;
          continue;
        }
      }
      // One call per batch part (the main part first); a failed part stops
      // the row so the booked ones are always a prefix.
      const parts: { quantity: number; batchNumber: string; expiresOn: string; extraIndex: number | null }[] = [];
      if (quantity) parts.push({ quantity, batchNumber: rowBatches.batchNumber.trim(), expiresOn: rowBatches.expiresOn, extraIndex: null });
      rowBatches.parts.forEach((p, i) => {
        const q = Number(p.quantity);
        if (q > 0) parts.push({ quantity: q, batchNumber: p.batchNumber.trim(), expiresOn: p.expiresOn, extraIndex: i });
      });
      if (parts.length === 0) continue;
      let rowBooked = false;
      for (const part of parts) {
        try {
          const result = await runWithShortageConfirm((allowMaterialShortage) =>
            apiFetch<{ operationReport?: { ok: boolean; message?: string }; receiptId?: string; receiptIds?: string[] }>(
              `/api/v1/purchase-orders/${selectedId}/rows/${row.id}/receive`,
              {
                method: "POST",
                body: JSON.stringify({
                  locationId: locationId || undefined,
                  quantity: toBaseQuantity(part.quantity, row.unitFactor),
                  ...(serialRow ? { serialNumbers: rowSerials } : {}),
                  ...(row.articleBatchTracked && part.batchNumber ? { batchNumber: part.batchNumber } : {}),
                  // "" = no date (the API keeps the batch's own, or none).
                  ...(row.articleBatchTracked && part.expiresOn ? { expiresOn: part.expiresOn } : {}),
                  allowMaterialShortage,
                }),
              }
            )
          );
          // Declined "Rapportera ändå?": this row is left unreceived — say so on
          // the row, or it would look like it was simply forgotten.
          if (result === null) {
            errors[row.id] = "Inte inlevererad — avbröts på grund av materialbrist.";
            break;
          }
          if (!rowBooked) {
            booked += 1;
            rowBooked = true;
          }
          if (part.extraIndex === null) bookedRowIds.push(row.id);
          else bookedParts[row.id] = (bookedParts[row.id] ?? 0) + 1;
          // A serial row books one receipt per styck (receiptIds), the others one.
          if (result.receiptIds && result.receiptIds.length > 0) receiptIds.push(...result.receiptIds);
          else if (result.receiptId) receiptIds.push(result.receiptId);
          // Lego row: the receipt auto-reports the linked TO operation. The
          // receipt itself stands even when the report fails (e.g. the TO is
          // already done) — surface that as a row warning, not a failure.
          if (result.operationReport) {
            if (result.operationReport.ok) reportedOperations += 1;
            else {
              errors[row.id] =
                `Inlevererad, men operationen kunde inte avrapporteras: ${result.operationReport.message ?? "okänt fel"}`;
            }
          }
        } catch (err) {
          errors[row.id] = apiErrorMessage(err, "Kunde inte ta emot raden");
          break;
        }
      }
    }
    // The numbers of the rows this run booked are used up.
    if (bookedRowIds.length > 0) {
      setSerials((prev) => {
        const next = { ...prev };
        for (const id of bookedRowIds) delete next[id];
        return next;
      });
    }
    // Drop the booked extra parts (the form keeps the failed ones).
    if (Object.keys(bookedParts).length > 0) {
      setBatches((prev) => {
        const next = { ...prev };
        for (const [rowId, n] of Object.entries(bookedParts)) {
          const cur = next[rowId];
          if (cur) next[rowId] = { ...cur, parts: cur.parts.filter((p) => Number(p.quantity) > 0).slice(n) };
        }
        return next;
      });
    }
    setRowErrors(errors);
    if (booked > 0 && Object.keys(errors).length === 0) {
      setDone(
        `${booked} rad${booked === 1 ? "" : "er"} inlevererade` +
          (reportedOperations > 0
            ? ` — ${reportedOperations} legooperation${reportedOperations === 1 ? "" : "er"} avrapporterade`
            : "")
      );
      setCount(NO_COUNT);
      setBatches({});
      setSerials({});
      setLastRowId(null);
      clearFeedback();
    } else if (bookedRowIds.length > 0) {
      setCount({
        ...countRef.current,
        quantities: { ...countRef.current.quantities, ...Object.fromEntries(bookedRowIds.map((id) => [id, "0"])) },
      });
    }
    setPending(false);
    // Återkoppling (punkt 7): Ångra takes back every receipt of this run, last
    // first — each is its own transaction, so a refusal part-way says how far
    // it got.
    if (booked > 0) {
      notify({
        message: `Inlevererat ${booked} rad${booked === 1 ? "" : "er"} på ${orderNumber}.`,
        action:
          receiptIds.length > 0
            ? {
                label: "Ångra",
                run: async () => {
                  let undone = 0;
                  try {
                    for (const receiptId of [...receiptIds].reverse()) {
                      await apiFetch(`/api/v1/purchase-orders/${orderId}/receipts/${receiptId}/undo`, { method: "POST" });
                      undone += 1;
                    }
                  } catch (err) {
                    router.refresh();
                    if (undone === 0) throw err;
                    throw new Error(
                      `${undone} av ${receiptIds.length} inleveranser ångrades: ${apiErrorMessage(err, "resten kunde inte ångras")}`
                    );
                  }
                  setDone(null);
                  router.refresh();
                  return receiptIds.length === 1 ? "Inleveransen är ångrad." : `${receiptIds.length} inleveranser är ångrade.`;
                },
              }
            : undefined,
      });
    }
    router.refresh();
  }

  const pill = order ? PURCHASE_ORDER_STATUS_PILL[order.status] : null;
  const listedOrders = articleOrders?.orders ?? openOrders;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inleverans</div>
          <div className={shellStyles.meta}>Rapportera mottagning mot inköpsorder</div>
        </div>
        <HelpLink chapter="inkop" anchor="inleverans" label="Hjälp om inleverans" />
      </div>

      <ScanPanel
        inputRef={scanField}
        placeholder="Skanna inköpsorder, artikel eller lagerplats…"
        onScan={onScan}
        feedback={feedback}
      />

      <div className={styles.controls}>
        <Field label="Inköpsorder" htmlFor="receiptOrder">
          <SearchPicker
            id="receiptOrder"
            endpoint={`/api/v1/purchase-orders?status=${RECEIVABLE.join(",")}&withOpenRows=true`}
            value={order}
            onChange={selectOrder}
            formatLabel={(o) => `${o.orderNumber} — ${o.supplierName}`}
            placeholder="Sök ordernummer, leverantör, artikelnummer eller benämning…"
            emptyText="Inga inköpsordrar matchar sökningen"
            renderOption={(o) => (
              <span className={styles.optionRows}>
                <span className={styles.optionTitle}>
                  {o.orderNumber} — {o.supplierName}
                </span>
                <span className={styles.optionMeta}>
                  {formatStockholmDate(o.createdAt)} · {PURCHASE_ORDER_STATUS_PILL[o.status].label}
                  {o.openRowCount != null ? ` · ${o.openRowCount} restrad${o.openRowCount === 1 ? "" : "er"}` : ""}
                </span>
              </span>
            )}
          />
        </Field>
        {locationOptions.length > 0 && (
          <Field label="Lagerplats" htmlFor="receiptLocation">
            <Select id="receiptLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Artikelns lagerplats</option>
              {locationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationOptionLabel(l)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {order && pill && (
          <div className={styles.orderStatus}>
            <StatusPill status={pill.status} label={pill.label} />
            <Link href={`/inkop/ordrar/${order.id}`} style={{ fontWeight: 600, color: "inherit" }}>
              Öppna {order.orderNumber}
            </Link>
          </div>
        )}
      </div>

      {done && <p style={{ fontWeight: 600, marginTop: 0 }}>{done}</p>}

      {!order && (
        <div className={styles.openOrders}>
          <SectionHeading
            actions={
              articleOrders && (
                <Button type="button" variant="secondary" size="small" onClick={() => setArticleOrders(null)}>
                  Visa alla
                </Button>
              )
            }
          >
            {articleOrders ? `Ordrar som väntar på ${articleLabel(articleOrders.article)}` : "Mottagbara ordrar"}
          </SectionHeading>
          <Table<PurchaseOrder>
            columns={[
              { key: "orderNumber", label: "Ordernummer", width: "140px" },
              { key: "supplierName", label: "Leverantör", width: "1fr" },
              { key: "createdAt", label: "Orderdatum", width: "130px" },
              { key: "status", label: "Status", width: "160px" },
              { key: "openRowCount", label: "Restrader", width: "110px", align: "right" },
            ]}
            rows={listedOrders}
            emptyText="Inga ordrar väntar på inleverans."
            renderCell={(o, key) => {
              switch (key) {
                case "orderNumber":
                  return (
                    <button
                      type="button"
                      className={styles.rowLink}
                      onClick={() => (articleOrders ? pickArticleOrder(o) : selectOrder(o))}
                    >
                      {o.orderNumber}
                    </button>
                  );
                case "supplierName":
                  return o.supplierName;
                case "createdAt":
                  return formatStockholmDate(o.createdAt);
                case "status": {
                  const p = PURCHASE_ORDER_STATUS_PILL[o.status];
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

      {order && openRows.length === 0 && <p>Alla rader på ordern är redan mottagna.</p>}

      {order && openRows.length > 0 && (
        <>
          {count.counting && (
            <div className={styles.countingNote}>
              <span>Räknar skannade artiklar — rader med 0 tas inte emot.</span>
              <Button type="button" variant="secondary" size="small" onClick={() => void resetToRemaining()}>
                Fyll i restantal
              </Button>
            </div>
          )}
          <Table<PurchaseOrderRow>
            columns={[
              { key: "articleNumber", label: "Artikelnummer", width: "150px" },
              { key: "articleName", label: "Benämning", width: "1fr" },
              { key: "quantityOrdered", label: "Beställt", width: "100px", align: "right" },
              { key: "unitCode", label: "Enhet", width: "70px" },
              { key: "quantityReceived", label: "Mottaget", width: "100px", align: "right" },
              { key: "remaining", label: "Rest", width: "100px", align: "right" },
              { key: "id", label: "Ta emot nu", width: "340px", align: "right" },
            ]}
            rows={openRows}
            highlightedRowId={lastRowId}
            renderCell={(row, key) => {
              switch (key) {
                case "quantityOrdered":
                case "quantityReceived":
                  return toUnitQuantity(Number(row[key]), row.unitFactor);
                case "remaining":
                  return (
                    <strong>
                      {toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityReceived), row.unitFactor)}
                    </strong>
                  );
                case "id":
                  return (
                    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        size="sm"
                        aria-label={`Ta emot nu — ${row.articleNumber}`}
                        value={enteredQuantity(scanRows.find((r) => r.id === row.id)!, count)}
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
                      {isStockSerial(row.articleTracking, serialModes, row.articleId) && (
                        <SerialNumbersInput
                          ariaLabel={`Serienummer — ${row.articleNumber}`}
                          value={serials[row.id] ?? []}
                          count={serialCountOf(toBaseQuantity(Number(enteredQuantity(scanRows.find((r) => r.id === row.id)!, count)), row.unitFactor))}
                          onChange={(next) => {
                            setSerials((prev) => ({ ...prev, [row.id]: next }));
                            // The quantity follows the numbers: one styck each.
                            if (next.length > 0) {
                              setCount({
                                ...countRef.current,
                                quantities: { ...countRef.current.quantities, [row.id]: String(toUnitQuantity(next.length, row.unitFactor)) },
                              });
                            }
                          }}
                        />
                      )}
                      {row.articleBatchTracked && (
                        <RowBatchFields
                          row={row}
                          orderNumber={order.orderNumber}
                          value={batches[row.id] ?? NO_BATCHES}
                          onChange={(v) => setBatches((prev) => ({ ...prev, [row.id]: v }))}
                          newKey={() => nextPartKey.current++}
                        />
                      )}
                      {rowErrors[row.id] && (
                        <FormError inline>{rowErrors[row.id]}</FormError>
                      )}
                    </span>
                  );
                default:
                  return row[key as keyof PurchaseOrderRow];
              }
            }}
          />

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <Button type="button" variant="primary" disabled={pending} onClick={report}>
              {pending ? "Rapporterar…" : "Rapportera inleverans"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

// Batch fields under "Ta emot nu" on a batch-tracked row: the main part's
// batch and, via "Dela på flera batcher", extra parts with their own amount.
function RowBatchFields({
  row,
  orderNumber,
  value,
  onChange,
  newKey,
}: {
  row: PurchaseOrderRow;
  orderNumber: string;
  value: RowBatches;
  onChange: (v: RowBatches) => void;
  newKey: () => number;
}) {
  const setPart = (key: number, patch: Partial<BatchPart>) =>
    onChange({ ...value, parts: value.parts.map((p) => (p.key === key ? { ...p, ...patch } : p)) });
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <Input
        type="text"
        size="sm"
        aria-label={`Batch — ${row.articleNumber}`}
        placeholder={orderNumber}
        value={value.batchNumber}
        onChange={(e) => onChange({ ...value, batchNumber: e.target.value })}
      />
      <Input
        type="date"
        size="sm"
        aria-label={`Utgångsdatum — ${row.articleNumber}`}
        title="Utgångsdatum (valfritt)"
        value={value.expiresOn}
        onChange={(e) => onChange({ ...value, expiresOn: e.target.value })}
      />
      {value.parts.map((p) => (
        <span key={p.key} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Input
            type="number"
            min="0"
            step="any"
            size="sm"
            aria-label={`Antal i delbatch — ${row.articleNumber}`}
            style={{ width: 96 }}
            placeholder="Antal"
            value={p.quantity}
            onChange={(e) => setPart(p.key, { quantity: e.target.value })}
          />
          <Input
            type="text"
            size="sm"
            aria-label={`Batch för delen — ${row.articleNumber}`}
            style={{ width: 140 }}
            placeholder={orderNumber}
            value={p.batchNumber}
            onChange={(e) => setPart(p.key, { batchNumber: e.target.value })}
          />
          <Input
            type="date"
            size="sm"
            aria-label={`Utgångsdatum för delen — ${row.articleNumber}`}
            title="Utgångsdatum (valfritt)"
            value={p.expiresOn}
            onChange={(e) => setPart(p.key, { expiresOn: e.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            size="small"
            aria-label="Ta bort batchdelen"
            onClick={() => onChange({ ...value, parts: value.parts.filter((x) => x.key !== p.key) })}
          >
            Ta bort
          </Button>
        </span>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={() => onChange({ ...value, parts: [...value.parts, { key: newKey(), quantity: "", batchNumber: "", expiresOn: "" }] })}
      >
        Dela på flera batcher
      </Button>
    </span>
  );
}
