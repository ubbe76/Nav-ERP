import { Fragment } from "react";
import { GatedLink } from "../ui/GatedLink";
import styles from "./FlowStrip.module.css";

export type FlowTone = "neutral" | "ok" | "warn" | "alert";

export interface FlowStation {
  label: string;
  href: string;
  value: number;
  unit: string;
  signal: string;
  tone: FlowTone;
}

// The dashboard's signature: the four headline counts rendered as stations in
// the core material flow (inköp → lager → tillverkning → försäljning), not as
// four unrelated KPI cards. Each station links to its module.
export function FlowStrip({ stations }: { stations: FlowStation[] }) {
  return (
    <section className={styles.strip} aria-label="Flödet: inköp, lager, tillverkning, försäljning">
      {stations.map((station, index) => (
        <Fragment key={station.label}>
          {index > 0 && <span className={styles.connector} aria-hidden="true" />}
          <GatedLink href={station.href} className={styles.station}>
            <span className={styles.stationLabel}>{station.label}</span>
            <span className={styles.value}>
              {station.value}
              <span className={styles.unit}>{station.unit}</span>
            </span>
            <span className={styles.signal} data-tone={station.tone}>
              {station.signal}
            </span>
          </GatedLink>
        </Fragment>
      ))}
    </section>
  );
}
