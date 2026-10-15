import type { ReactNode } from "react";
import Link from "next/link";
import type { FlowTone } from "./FlowStrip";
import styles from "./KpiTile.module.css";

export interface KpiTileProps {
  label: string;
  value: string | number;
  unit?: string;
  signal?: string;
  tone?: FlowTone;
  href?: string;
}

// Module-dashboard KPI tile: FlowStrip's station typography as a standalone
// card (DashboardCard chrome), linked when href is given. This contract is
// FROZEN — shared by the module dashboards (försäljning, inköp, tillverkning).
export function KpiTile({ label, value, unit, signal, tone = "neutral", href }: KpiTileProps) {
  const body = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {typeof value === "number" ? value.toLocaleString("sv-SE") : value}
        {unit !== undefined && <span className={styles.unit}>{unit}</span>}
      </span>
      {signal !== undefined && (
        <span className={styles.signal} data-tone={tone}>
          {signal}
        </span>
      )}
    </>
  );
  return href !== undefined ? (
    <Link href={href} className={styles.tile}>
      {body}
    </Link>
  ) : (
    <div className={styles.tile}>{body}</div>
  );
}

// Responsive grid for the KPI row — four tiles wide, collapsing on small
// screens. Kept next to KpiTile so every dashboard composes the same row.
export function KpiRow({ children }: { children: ReactNode }) {
  return <section className={styles.row}>{children}</section>;
}
