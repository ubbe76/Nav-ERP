import { GatedLink } from "../ui/GatedLink";
import cardStyles from "./DashboardCard.module.css";
import styles from "./OrdersCard.module.css";
import { StatusDot } from "../ui/StatusPill";
import { MANUFACTURING_ORDER_STATUS_PILL, type ManufacturingOrder } from "../../lib/types";

// Active MOs (released / in progress) — what the shop floor is working on now.
export function OrdersCard({ orders }: { orders: ManufacturingOrder[] }) {
  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.header}>
        <div className={cardStyles.title}>Pågående tillverkning</div>
        <GatedLink href="/tillverkning/ordrar" className={cardStyles.link}>
          Se alla
        </GatedLink>
      </div>
      <div>
        {orders.length === 0 ? (
          <p className={styles.empty}>Inga aktiva tillverkningsordrar.</p>
        ) : (
          orders.map((order) => {
            const pill = MANUFACTURING_ORDER_STATUS_PILL[order.status];
            return (
              <GatedLink href={`/tillverkning/ordrar/${order.id}`} className={styles.row} key={order.id}>
                <span className={styles.texts}>
                  <span className={styles.orderNumber}>{order.orderNumber}</span>
                  <span className={styles.product}>
                    {order.articleName} · <span className="num">{Number(order.quantity).toLocaleString("sv-SE")}</span> st
                  </span>
                </span>
                <StatusDot status={pill.status} label={pill.label} />
              </GatedLink>
            );
          })
        )}
      </div>
    </div>
  );
}
