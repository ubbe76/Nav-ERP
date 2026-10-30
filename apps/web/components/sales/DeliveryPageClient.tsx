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
import { useCountState, useScanFeedback, useScanQueue } from "../ui/useOrderScan";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { configuredDeliveryWarning } from "../../lib/configuredDelivery";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import {
  countScan,
  enteredQuantity,
  hasCounted,
  isScannableRow,
  leftToCount,
  resolveOrderScan,
  type OrderCountState,
  type OrderScanRow,
} from "../../lib/orderScan";
import {
  SALES_ORDER_STATUS_PILL,
  type SalesOrder,
  type SalesOrderRow,
  type SalesOrderStatus,
  type ScanMatch,
  type StockLocation,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError, FormNotice } from "../ui/Form";
import { BookTransportButton } from "../shipping/BookTransportButton";
import { PalletCardDialog } from "../documents/PalletCardDialog";
import styles from "./DeliveryPageClient.module.css";

const NO_COUNT: OrderCountState = { counting: false, quantities: {} };

type ArticleMatch = Extract<ScanMatch, { kind: "article" }>;
type LocationOption = Pick<StockLocation, "id" | "name" | "warehouseName">;

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
  const openRows = useMemo(
    () => rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered)),
    [rows]
  );
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
      })),
    [openRows, overDeliveryPercent]
  );
  const scanRowOf = (row: SalesOrderRow) => scanRows.find((r) => r.id === row.id)!;

  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
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
  const [done, setDone] = useState<{ message: string; deliveryId: string; deliveryNumber: string } | null>(null);
  const scanField = useRef<HTMLInputElement>(null);
  // The props the queued scan handlers read — a handler may run after a
  // navigation it did not see.
  const latest = useRef({ order, openRows, scanRows, rows, overDeliveryPercent });
  useEffect(() => {
    latest.current = { order, openRows, scanRows, rows, overDeliveryPercent };
  });

  // Frakt: "Boka transport" on the result block only when freight is
  // enabled under System → Frakt — fetched once; an error hides the button.
  const [freightEnabled, setFreightEnabled] = useState(false);
  useEffect(() => {
    apiFetch<{ enabled: boolean }>("/api/v1/freight-settings/status")
      .then((r) => setFreightEnabled(r.enabled))
      .catch(() => setFreightEnabled(false));
  }, []);

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

  function applyCount(article: ArticleMatch) {
    const outcome = countScan(latest.current.scanRows, countRef.current, article.id);
    if (!outcome.counted && !outcome.full) return;
    setLastRowId(outcome.rowId);
    const row = latest.current.openRows.find((r) => r.id === outcome.rowId);
    const amount = `${outcome.quantity} av ${outcome.remaining} ${row?.unitCode ?? ""}`.trim();
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

  async function handleScan(code: string, matches: ScanMatch[]) {
    const { order: current, scanRows: currentRows, rows: allRows } = latest.current;
    const intent = resolveOrderScan(
      matches,
      "salesOrder",
      current ? { openRows: currentRows, articleIds: allRows.map((r) => r.articleId) } : null
    );
    switch (intent.kind) {
      case "location": {
        const m = intent.match;
        if (!locations.some((l) => l.id === m.id)) {
          setScannedLocation({ id: m.id, name: m.name, warehouseName: m.warehouseName });
        }
        setLocationId(m.id);
        const text = `Lagerplats: ${m.warehouseName} — ${m.name}`;
        if (m.active) ok(text);
        else warn(`${text} — inaktiv, det finns inget saldo på den`);
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
      case "unknown":
        warn(`Ingen träff för ${code}`);
        return;
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
    if (toDeliver.length === 0) return;

    setPending(true);
    try {
      const result = await apiFetch<{ deliveryId: string; deliveryNumber: string; orderStatus: string }>(
        `/api/v1/sales-orders/${selectedId}/deliver`,
        {
          method: "POST",
          body: JSON.stringify({
            locationId: locationId || undefined,
            rows: toDeliver.map(({ row, quantity }) => ({
              rowId: row.id,
              quantity: toBaseQuantity(quantity, row.unitFactor),
            })),
          }),
        }
      );
      setDone({
        message: `${toDeliver.length} rad${toDeliver.length === 1 ? "" : "er"} utlevererade`,
        deliveryId: result.deliveryId,
        deliveryNumber: result.deliveryNumber,
      });
      setCount(NO_COUNT);
      setLastRowId(null);
      clearFeedback();
      // Pallkort: auto-open the cards for the delivery (one page per row) —
      // best effort (a popup blocker may stop it); the Pallkort (PDF) link
      // in the result block is the always-there fallback.
      window.open(`/api/v1/deliveries/${result.deliveryId}/pallet-card`, "_blank", "noopener");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Kunde inte leverera";
      // The batch error has no structured per-row attribution — but
      // SalesOrderRowNotFoundError's message embeds the row id, so a match
      // still gets shown inline (the raw message — that's what carries the
      // id); anything else (e.g. over-delivery, which names no row) falls
      // back to a form-level message from the shared error-code dictionary.
      const attributed = toDeliver.find(({ row }) => message.includes(row.id));
      if (attributed) {
        setRowErrors({ [attributed.row.id]: message });
      } else {
        setFormError(apiErrorMessage(err, "Kunde inte leverera"));
      }
    }
    setPending(false);
    router.refresh();
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
                  {new Date(o.createdAt).toLocaleDateString("sv-SE")} · {SALES_ORDER_STATUS_PILL[o.status].label}
                  {o.openRowCount != null ? ` · ${o.openRowCount} restrad${o.openRowCount === 1 ? "" : "er"}` : ""}
                </span>
              </span>
            )}
          />
        </Field>
        {locationOptions.length > 0 && (
          <Field label="Lagerplats" htmlFor="deliveryLocation">
            <Select id="deliveryLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
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
        </div>
      )}

      <FormError margin="below">{formError}</FormError>

      {!order && (
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
                  return new Date(o.createdAt).toLocaleDateString("sv-SE");
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

      {order && openRows.length === 0 && <p>Alla rader på ordern är redan levererade.</p>}

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
              { key: "id", label: "Leverera nu", width: "180px", align: "right" },
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
        </>
      )}
    </>
  );
}
