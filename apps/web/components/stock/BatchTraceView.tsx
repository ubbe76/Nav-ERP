"use client";

import type { ReactNode } from "react";
import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import { formatQuantity } from "../../lib/format";
import { formatStockholmDate } from "../../lib/date";
import type {
  BackwardTraceNode,
  BatchTrace,
  ForwardTraceNode,
  TraceBatchRef,
  TraceEvent,
  TraceSerialGroup,
  TraceStop,
} from "../../lib/types";
import styles from "./BatchTraceView.module.css";

const qty = (value: number, unit: string) => `${formatQuantity(value)} ${unit}`;

// A batch's name: the number, "Okänd" for stock without a batch on a batchstyrd
// article, "ej batchstyrd" for one that has none at all.
function batchLabel(batch: TraceBatchRef): string {
  const unknown = batch.tracking === "serial" ? "Okänt serienummer" : "Okänd batch";
  return batch.batchNumber ?? (batch.batchTracked ? unknown : "Ej batchstyrd");
}

// A group of serial numbers merged into one node: "12 serienummer: SN-1001–SN-1012".
function groupLabel(group: TraceSerialGroup): string {
  return `${group.count} serienummer: ${group.numbers}`;
}

function Burnt({ batch }: { batch: TraceBatchRef }) {
  return batch.burnt ? <span className={styles.muted}> — Bränt (utleveransen ångrad)</span> : null;
}

function BatchHead({
  batch,
  linkBatch,
  serials,
}: {
  batch: TraceBatchRef;
  linkBatch: boolean;
  serials?: TraceSerialGroup;
}) {
  const link = serials && serials.batchIds.length === 1 ? serials.batchIds[0] : batch.batchId;
  return (
    <>
      {serials ? (
        groupLabel(serials)
      ) : linkBatch && link ? (
        <GatedLink href={`/lager/sparbarhet?batch=${link}`} style={{ color: "var(--accent-fg)" }}>
          {batchLabel(batch)}
        </GatedLink>
      ) : (
        batchLabel(batch)
      )}
      <Burnt batch={batch} />
      {" — "}
      <GatedLink href={`/artiklar/${batch.articleId}`} style={{ color: "var(--accent-fg)" }}>
        {batch.articleNumber}
      </GatedLink>{" "}
      {batch.articleName}
    </>
  );
}

function StopNote({ stop }: { stop: TraceStop }) {
  // "unknown": the batch head above already says Okänd batch.
  if (!stop || stop === "unknown") return null;
  const text = stop === "repeated" ? "visas ovan" : "(fortsättningen visas inte)";
  return <div className={styles.muted}>{text}</div>;
}

function Line({ kind, children, amount }: { kind: string; children: ReactNode; amount?: string }) {
  return (
    <div className={styles.line}>
      <span className={styles.kind}>{kind}</span>
      <span>{children}</span>
      {amount && <span className={styles.qty}>{amount}</span>}
    </div>
  );
}

function Event({ event, unit }: { event: TraceEvent; unit: string }) {
  const signed = `${event.quantity > 0 ? "+" : ""}${formatQuantity(event.quantity)} ${unit}`;
  return (
    <Line kind={event.kind === "stock_count" ? "Inventering" : "Justering"} amount={signed}>
      {event.kind === "stock_count" && event.stockCountId ? (
        <GatedLink href={`/lager/inventering/${event.stockCountId}`} style={{ color: "var(--accent-fg)" }}>
          {event.stockCountNumber ?? "Inventering"}
        </GatedLink>
      ) : null}{" "}
      {formatStockholmDate(event.at)}
      {event.note ? ` — ${event.note}` : ""}
    </Line>
  );
}

function BackwardNode({ node, root }: { node: BackwardTraceNode; root: boolean }) {
  const unit = node.batch.unitCode;
  const origin = node.deliveryOrigin ?? null;
  const empty = !origin && node.receipts.length === 0 && node.manufacturingOrders.length === 0 && node.events.length === 0;
  return (
    <div className={styles.node}>
      {!root && (
        <div className={styles.line}>
          <span className={styles.nodeHead}>
            <BatchHead batch={node.batch} linkBatch serials={node.serials} />
          </span>
          {node.quantity != null && <span className={styles.qty}>{qty(node.quantity, unit)}</span>}
        </div>
      )}
      <StopNote stop={node.stop} />
      {origin && (
        <Line kind="Skapat vid utleverans" amount={qty(1, unit)}>
          {origin.rowQuantity !== 1 ? `(rad om ${qty(origin.rowQuantity, unit)}) ` : ""}följesedel {origin.deliveryNumber},{" "}
          <GatedLink href={`/forsaljning/ordrar/${origin.salesOrderId}`} style={{ color: "var(--accent-fg)" }}>
            {origin.orderNumber}
          </GatedLink>{" "}
          till{" "}
          <GatedLink href={`/kunder/${origin.customerId}`} style={{ color: "var(--accent-fg)" }}>
            {origin.customerName}
          </GatedLink>
          , {formatStockholmDate(origin.deliveredAt)}
          {origin.undoneAt ? ` — ångrad ${formatStockholmDate(origin.undoneAt)}` : ""}
        </Line>
      )}
      {node.receipts.map((r, i) => (
        <Line key={`r${i}`} kind="Inleverans" amount={qty(r.quantity, unit)}>
          <GatedLink href={`/inkop/ordrar/${r.purchaseOrderId}`} style={{ color: "var(--accent-fg)" }}>
            {r.orderNumber}
          </GatedLink>{" "}
          från{" "}
          <GatedLink href={`/leverantorer/${r.supplierId}`} style={{ color: "var(--accent-fg)" }}>
            {r.supplierName}
          </GatedLink>
          , {formatStockholmDate(r.receivedAt)}
        </Line>
      ))}
      {node.manufacturingOrders.map((mo) => (
        <div key={mo.manufacturingOrderId} className={styles.node}>
          <Line kind="Tillverkningsorder" amount={qty(mo.quantity, unit)}>
            <GatedLink href={`/tillverkning/ordrar/${mo.manufacturingOrderId}`} style={{ color: "var(--accent-fg)" }}>
              {mo.orderNumber}
            </GatedLink>
          </Line>
          {mo.materials.length > 0 && (
            <div className={styles.children}>
              <div className={styles.muted}>Material</div>
              {mo.materials.map((m, i) => (
                <BackwardNode key={`${m.batch.batchId ?? "unknown"}-${m.batch.articleId}-${i}`} node={m} root={false} />
              ))}
            </div>
          )}
        </div>
      ))}
      {node.events.map((e, i) => (
        <Event key={`e${i}`} event={e} unit={unit} />
      ))}
      {empty && root && <p className={styles.empty}>Inget känt ursprung för batchen.</p>}
    </div>
  );
}

function ForwardNode({ node, root }: { node: ForwardTraceNode; root: boolean }) {
  const unit = node.batch.unitCode;
  const empty = node.consumedBy.length === 0 && node.deliveries.length === 0 && node.events.length === 0 && node.onHand.length === 0;
  return (
    <div className={styles.node}>
      {!root && (
        <div className={styles.line}>
          <span className={styles.nodeHead}>
            <BatchHead batch={node.batch} linkBatch serials={node.serials} />
          </span>
          {node.quantity != null && <span className={styles.qty}>{qty(node.quantity, unit)}</span>}
        </div>
      )}
      <StopNote stop={node.stop} />
      {node.consumedBy.map((c) => (
        <div key={c.manufacturingOrderId} className={styles.node}>
          <Line kind="Förbrukad i" amount={qty(c.quantity, unit)}>
            <GatedLink href={`/tillverkning/ordrar/${c.manufacturingOrderId}`} style={{ color: "var(--accent-fg)" }}>
              {c.orderNumber}
            </GatedLink>{" "}
            ({c.articleNumber} {c.articleName})
          </Line>
          {c.produced.length > 0 ? (
            <div className={styles.children}>
              <div className={styles.muted}>Tillverkad batch</div>
              {c.produced.map((p, i) => (
                <ForwardNode key={`${p.batch.batchId ?? "unknown"}-${p.batch.articleId}-${i}`} node={p} root={false} />
              ))}
            </div>
          ) : (
            <div className={styles.muted}>Inget inlevererat ännu.</div>
          )}
        </div>
      ))}
      {node.deliveries.map((d, i) => (
        <Line key={`d${i}`} kind={d.undoneAt ? "Utleverans (ångrad)" : "Utleverans"} amount={qty(d.quantity, unit)}>
          <GatedLink href={`/forsaljning/ordrar/${d.salesOrderId}`} style={{ color: "var(--accent-fg)" }}>
            {d.orderNumber}
          </GatedLink>{" "}
          till{" "}
          <GatedLink href={`/kunder/${d.customerId}`} style={{ color: "var(--accent-fg)" }}>
            {d.customerName}
          </GatedLink>
          , följesedel {d.deliveryNumber}, {formatStockholmDate(d.deliveredAt)}
          {d.undoneAt ? ` — ångrad ${formatStockholmDate(d.undoneAt)}` : ""}
          {d.serialNumbers ? ` — serienummer ${d.serialNumbers}` : ""}
        </Line>
      ))}
      {node.events.map((e, i) => (
        <Event key={`e${i}`} event={e} unit={unit} />
      ))}
      {node.onHand.length > 0 && (
        <div className={styles.node}>
          <div className={styles.muted}>Kvar i lager</div>
          {node.onHand.map((o) => (
            <Line key={o.locationId} kind="" amount={qty(o.quantity, unit)}>
              {o.warehouseName} — {o.locationName}
              {o.blocked ? " (spärrad)" : ""}
            </Line>
          ))}
        </div>
      )}
      {empty && root && <p className={styles.empty}>Batchen har inte gått vidare och finns inte kvar i lager.</p>}
    </div>
  );
}

export function BatchTraceView({ trace }: { trace: BatchTrace }) {
  return (
    <>
      {trace.truncated && (
        <p className={styles.notice} role="status">
          Spårningen är avkortad: den är för djup eller stor för att visas helt, så delar av trädet saknas.
        </p>
      )}
      <div className={styles.columns}>
        <section className={styles.column}>
          <SectionHeading>Bakåt — varifrån batchen kommer</SectionHeading>
          <div className={styles.tree}>
            <BackwardNode node={trace.backward} root />
          </div>
        </section>
        <section className={styles.column}>
          <SectionHeading>Framåt — vart batchen har tagit vägen</SectionHeading>
          <div className={styles.tree}>
            <ForwardNode node={trace.forward} root />
          </div>
        </section>
      </div>
    </>
  );
}
