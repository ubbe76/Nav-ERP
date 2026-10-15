import { GatedLink } from "../ui/GatedLink";
import cardStyles from "./DashboardCard.module.css";
import styles from "./StockActivityCard.module.css";
import { STOCK_TRANSACTION_TYPE_LABELS, type StockTransaction } from "../../lib/types";

function formatDelta(quantityDelta: string) {
  const qty = Number(quantityDelta);
  return `${qty > 0 ? "+" : ""}${qty.toLocaleString("sv-SE")}`;
}

// The stock ledger's pulse: the latest rows from the append-only
// stock_transactions log (lagerhändelser).
export function StockActivityCard({ transactions }: { transactions: StockTransaction[] }) {
  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.header}>
        <div className={cardStyles.title}>Senaste lagerhändelser</div>
        <GatedLink href="/lager/transaktioner" className={cardStyles.link}>
          Se alla
        </GatedLink>
      </div>
      <div>
        {transactions.length === 0 ? (
          <p className={styles.empty}>Inga lagertransaktioner registrerade än.</p>
        ) : (
          transactions.map((tx) => (
            <div className={styles.row} key={tx.id}>
              <span className={`${styles.delta} num`}>{formatDelta(tx.quantityDelta)}</span>
              <span className={styles.texts}>
                <span className={styles.article}>{tx.articleName}</span>
                <span className={styles.type}>{STOCK_TRANSACTION_TYPE_LABELS[tx.transactionType]}</span>
              </span>
              <span className={styles.date}>
                {new Date(tx.createdAt).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
