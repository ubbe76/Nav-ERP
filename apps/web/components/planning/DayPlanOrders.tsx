"use client";

import { allocationHref, allocationText, COMPONENT_LATE_LABEL, outlookDate, outlookLabel, outlookTone, uncoveredText } from "../../lib/deliveryOutlook";
import { arrivalConfirmationText, legoText, orderRowQuantity, orderRowsSummary, splitOverdue, type DayPlanOrdersView } from "../../lib/dayPlan";
import { weekdayShortDate } from "../../lib/planning";
import { PURCHASE_ORDER_STATUS_PILL, type DayPlanArrival, type DayPlanOrdersResult, type DayPlanShipment } from "../../lib/types";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import styles from "./DayPlanOrders.module.css";

// Dagplanens Utleveranser och Inleveranser: the kundorder rows to ship and the
// inköpsorder rows to arrive on the shown day (GET /planning/day-plan/orders;
// the API decides the day, the order and the readiness — nothing here).
// Today first lists what has passed (Försenade). Read-only; `meeting` =
// Mötesläget, without links. Two row layouts share the markup: a table when
// the box is at least 900px wide, cards below that.

const TEXTS: Record<DayPlanOrdersView, { title: string; empty: string; dayLabel: string }> = {
  shipments: { title: "Utleveranser", empty: "Inga kundorderrader att skicka den dagen.", dayLabel: "Avsändning" },
  arrivals: { title: "Inleveranser", empty: "Inga inköpsorderrader väntas den dagen.", dayLabel: "Ankomst" },
};

export function DayPlanOrders({ view, result, meeting }: { view: DayPlanOrdersView; result: DayPlanOrdersResult; meeting: boolean }) {
  const texts = TEXTS[view];
  const rows: (DayPlanShipment | DayPlanArrival)[] = view === "shipments" ? result.shipments : result.arrivals;
  const { overdue, day } = splitOverdue(rows);
  const isToday = result.date === result.today;
  // A Friday also lists the weekend: say which days the list covers.
  const span = result.through !== result.date ? `${weekdayShortDate(result.date)}–${weekdayShortDate(result.through)}` : null;

  // Mötesläget has no links: the order number keeps its look, a covering
  // document is plain text.
  const link = (href: string, text: string, kind: "order" | "document") =>
    meeting ? (
      <span className={kind === "order" ? styles.orderLink : undefined}>{text}</span>
    ) : (
      <GatedLink href={href} className={kind === "order" ? styles.orderLink : styles.documentLink}>
        {text}
      </GatedLink>
    );

  function renderShipment(s: DayPlanShipment) {
    const quantity = (q: number) => orderRowQuantity(q, s.unit);
    return (
      <li key={s.key} className={styles.row} data-overdue={s.overdue ? "true" : undefined}>
        <span className={styles.order}>{link(`/forsaljning/ordrar/${s.salesOrderId}`, s.orderNumber, "order")}</span>
        <span className={styles.party} title={s.customerName}>
          {s.customerName}
        </span>
        <span className={styles.article} title={`${s.articleNumber} ${s.articleName}`}>
          <span className="num">{s.articleNumber}</span> <span className={styles.articleName}>{s.articleName}</span>
        </span>
        <span className={styles.facts}>
          <span className={`${styles.quantity} num`} data-label="Antal kvar">
            {quantity(s.restQuantity)}
          </span>
          <span className={`${styles.day} num`} data-label={texts.dayLabel}>
            {weekdayShortDate(s.shipDate)}
            {s.promisedDate && s.promisedDate !== s.shipDate && (
              <span className={styles.dayNote}>lev. {outlookDate(s.promisedDate, result.today)}</span>
            )}
          </span>
        </span>
        <span className={styles.status}>
          <StatusPill status={outlookTone(s)} label={outlookLabel(s)} compact={!meeting} />
          {s.componentLate && <StatusPill status="delayed" label={COMPONENT_LATE_LABEL} compact={!meeting} />}
        </span>
        <ul className={styles.detail} data-label="Täcks av">
          {s.allocations.map((a, i) => {
            const text = allocationText(a, quantity(a.quantity), result.today);
            const href = allocationHref(a);
            return (
              <li key={i}>
                {href ? link(href, text.label, "document") : text.label} {a.kind === "stock" ? "" : "· "}
                {text.detail}
                {text.late && <span className={styles.late}> · {text.late}</span>}
              </li>
            );
          })}
          {s.uncovered > 0 && <li className={styles.late}>{uncoveredText(quantity(s.uncovered))}</li>}
        </ul>
      </li>
    );
  }

  function renderArrival(a: DayPlanArrival) {
    const pill = PURCHASE_ORDER_STATUS_PILL[a.orderStatus];
    return (
      <li key={a.key} className={styles.row} data-overdue={a.overdue ? "true" : undefined}>
        <span className={styles.order}>{link(`/inkop/ordrar/${a.purchaseOrderId}`, a.orderNumber, "order")}</span>
        <span className={styles.party} title={a.supplierName}>
          {a.supplierName}
        </span>
        <span className={styles.article} title={`${a.articleNumber} ${a.articleName}`}>
          <span className="num">{a.articleNumber}</span> <span className={styles.articleName}>{a.articleName}</span>
        </span>
        <span className={styles.facts}>
          <span className={`${styles.quantity} num`} data-label="Antal kvar">
            {orderRowQuantity(a.restQuantity, a.unit)}
          </span>
          <span className={`${styles.day} num`} data-label={texts.dayLabel}>
            {weekdayShortDate(a.arrivalDate)}
          </span>
        </span>
        <span className={styles.status}>
          <StatusPill status={pill.status} label={pill.label} compact={!meeting} />
        </span>
        <ul className={styles.detail} data-label="Bekräftelse">
          <li className={a.confirmed ? undefined : styles.unconfirmed}>{arrivalConfirmationText(a.confirmed)}</li>
          {a.lego && (
            <li>
              {meeting ? (
                legoText(a.lego)
              ) : (
                <>
                  Lego ·{" "}
                  <GatedLink href={`/tillverkning/ordrar/${a.lego.manufacturingOrderId}`} className={styles.documentLink}>
                    {a.lego.orderNumber}
                  </GatedLink>{" "}
                  op {a.lego.sequenceNo}
                </>
              )}
            </li>
          )}
        </ul>
      </li>
    );
  }

  const render = (row: DayPlanShipment | DayPlanArrival) =>
    view === "shipments" ? renderShipment(row as DayPlanShipment) : renderArrival(row as DayPlanArrival);

  return (
    <section className={styles.box} aria-label={texts.title} data-meeting={meeting ? "true" : undefined}>
      <header className={styles.header}>
        <h3 className={styles.title}>{texts.title}</h3>
        {rows.length > 0 && <span className={styles.count}>{orderRowsSummary(rows)}</span>}
        {overdue.length > 0 && <span className={styles.overdueCount}>{overdue.length} {overdue.length === 1 ? "försenad" : "försenade"}</span>}
        {span && <span className={styles.span}>{span}</span>}
      </header>
      {rows.length === 0 ? (
        <p className={styles.empty}>{texts.empty}</p>
      ) : (
        <div className={styles.list} data-view={view}>
          <div className={styles.headRow} aria-hidden="true">
            <span>{view === "shipments" ? "Kundorder" : "Inköpsorder"}</span>
            <span>{view === "shipments" ? "Kund" : "Leverantör"}</span>
            <span>Artikel</span>
            <span className={styles.right}>Antal kvar</span>
            <span>{texts.dayLabel}</span>
            <span>{view === "shipments" ? "Leveransläge" : "Status"}</span>
            <span>{view === "shipments" ? "Täcks av" : "Bekräftelse"}</span>
          </div>
          {overdue.length > 0 && (
            <>
              <div className={styles.band}>Försenade ({overdue.length})</div>
              <ul className={styles.rows}>{overdue.map(render)}</ul>
              {day.length > 0 && <div className={styles.band}>{isToday ? "I dag" : "Dagens"} ({day.length})</div>}
            </>
          )}
          {day.length > 0 && <ul className={styles.rows}>{day.map(render)}</ul>}
        </div>
      )}
    </section>
  );
}
