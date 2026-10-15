"use client";

import { configurationLines } from "../../lib/configurationLines";
import type { OrderRowConfiguration } from "../../lib/configurator";
import styles from "./TestConfigurationPanel.module.css";

// A muted list of already-built lines (a form's draft before it is saved).
export function ConfigurationLineList({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className={styles.configurationLines}>
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

// The choice lines under a configured row's article name (order card, invoice card, invoice dialog).
export function ConfigurationLines({
  configuration,
  withPrices = false,
}: {
  configuration: OrderRowConfiguration | null | undefined;
  withPrices?: boolean;
}) {
  if (!configuration) return null;
  return (
    <ConfigurationLineList
      lines={configurationLines(configuration.selection, withPrices ? configuration.price.additions : undefined)}
    />
  );
}
