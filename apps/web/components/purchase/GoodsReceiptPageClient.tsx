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
import { useCountState, useScanFeedback, useScanQueue } from "../ui/useOrderScan";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import {
  countScan,
  enteredQuantity,
  hasCounted,
  isScannableRow,
  resolveOrderScan,
  type OrderCountState,
  type OrderScanRow,
} from "../../lib/orderScan";
import {
  PURCHASE_ORDER_STATUS_PILL,
  type Paged,
  type PurchaseOrder,
  type PurchaseOrderRow,
  type PurchaseOrderStatus,
  type ScanMatch,
  type StockLocation,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError } from "../ui/Form";
import styles from "./GoodsReceiptPageClient.module.css";

const RECEIVABLE: PurchaseOrderStatus[] = ["confirmed", "partially_received"];
const NO_COUNT: OrderCountState = { counting: false, quantities: {} };

type ArticleMatch = Extract<ScanMatch, { kind: "article" }>;
type LocationOption = Pick<StockLocation, "id" | "name" | "warehouseName">;

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
      })),
    [openRows]
  );

  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  // A scanned lagerplats that GET /stock/locations leaves out (inactive — a
  // receipt into it reactivates it), added to the select so it can be shown.
  const [scannedLocation, setScannedLocation] = useState<LocationOption | null>(null);
  const { count, countRef, setCount } = useCountState(NO_COUNT);
  const { feedback, ok, warn, clear: clearFeedback } = useScanFeedback();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [lastRowId, setLastRowId] = useState<string | null>(null);
  // An article scanned before an order was chosen that is open on several
  // orders: the list narrows to them until one is picked.
  const [articleOrders, setArticleOrders] = useState<{ article: ArticleMatch; orders: PurchaseOrder[] } | null>(null);
  // The scan that chose the order: counted once the order's rows have loaded.
  const pendingCount = useRef<{ orderId: string; article: ArticleMatch } | null>(null);
  const scanField = useRef<HTMLInputElement>(null);
  // The props the queued scan handlers read — a handler may run after a
  // navigation it did not see.
  const latest = useRef({ order, openRows, scanRows, rows });
  useEffect(() => {
    latest.current = { order, openRows, scanRows, rows };
  });

  const locationOptions: LocationOption[] =
    scannedLocation && !locations.some((l) => l.id === scannedLocation.id) ? [...locations, scannedLocation] : locations;

  function goToOrder(id: string) {
    setCount(NO_COUNT);
    setRowErrors({});
    setDone(null);
    setLastRowId(null);
    setArticleOrders(null);
    router.replace(`/inkop/inleverans?order=${id}`);
  }

  // The SearchPicker also fires onChange(null) while the user is typing (it
  // invalidates the previous pick) — only a definite pick should navigate.
  function selectOrder(next: PurchaseOrder | null) {
    if (!next) return;
    pendingCount.current = null;
    clearFeedback();
    goToOrder(next.id);
  }

  function applyCount(article: ArticleMatch) {
    const outcome = countScan(latest.current.scanRows, countRef.current, article.id, { capped: false });
    if (!outcome.counted) return;
    setCount(outcome.state);
    setLastRowId(outcome.rowId);
    setDone(null);
    const row = latest.current.openRows.find((r) => r.id === outcome.rowId);
    const text = `${articleLabel(article)}: ${outcome.quantity} av ${outcome.remaining} ${row?.unitCode ?? ""}`.trim();
    if (outcome.over) warn(`${text} — mer än restantalet`);
    else ok(text);
  }

  // The order's rows arrive with the navigation the scan started.
  useEffect(() => {
    const waiting = pendingCount.current;
    if (!waiting || waiting.orderId !== selectedId) return;
    pendingCount.current = null;
    applyCount(waiting.article);
    // applyCount reads refs only; rerun when the order's rows arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, scanRows]);

  const onScan = useScanQueue(handleScan, warn);

  async function handleScan(code: string, matches: ScanMatch[]) {
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
        applyCount(intent.match);
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
          pendingCount.current = { orderId: found[0]!.id, article };
          goToOrder(found[0]!.id);
          return;
        }
        setArticleOrders({ article, orders: found });
        ok(`${articleLabel(article)} väntas på ${found.length} ordrar — välj en`);
        return;
      }
      case "wrongKind":
        warn(
          `${code} är en ${intent.match.kind === "salesOrder" ? "kundorder" : "tillverkningsorder"} — skanna en inköpsorder, en artikel eller en lagerplats`
        );
        return;
      case "unknown":
        warn(`Ingen träff för ${code}`);
        return;
    }
  }

  // Picked from the list of orders waiting for a scanned article: that scan
  // counts on the chosen order.
  function pickArticleOrder(o: PurchaseOrder) {
    if (articleOrders) pendingCount.current = { orderId: o.id, article: articleOrders.article };
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
    let reportedOperations = 0;
    for (const row of openRows) {
      const scanRow = scanRows.find((r) => r.id === row.id)!;
      const quantity = Number(enteredQuantity(scanRow, count));
      if (!quantity) continue;
      try {
        const result = await runWithShortageConfirm((allowMaterialShortage) =>
          apiFetch<{ operationReport?: { ok: boolean; message?: string } }>(
            `/api/v1/purchase-orders/${selectedId}/rows/${row.id}/receive`,
            {
              method: "POST",
              body: JSON.stringify({
                locationId: locationId || undefined,
                quantity: toBaseQuantity(quantity, row.unitFactor),
                allowMaterialShortage,
              }),
            }
          )
        );
        // Declined "Rapportera ändå?": this row is left unreceived — say so on
        // the row, or it would look like it was simply forgotten.
        if (result === null) {
          errors[row.id] = "Inte inlevererad — avbröts på grund av materialbrist.";
          continue;
        }
        booked += 1;
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
      }
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
      setLastRowId(null);
      clearFeedback();
    }
    setPending(false);
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
                  {new Date(o.createdAt).toLocaleDateString("sv-SE")} · {PURCHASE_ORDER_STATUS_PILL[o.status].label}
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
                  {l.warehouseName} — {l.name}
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
                  return new Date(o.createdAt).toLocaleDateString("sv-SE");
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
              { key: "id", label: "Ta emot nu", width: "220px", align: "right" },
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
