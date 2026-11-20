"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./CardTabs.module.css";

export interface CardTab {
  key: string;
  label: string;
  // Shown after the label (Rader 5); null/undefined = none.
  count?: number | null;
  node: ReactNode;
}

// The card's own tabs (Programramen steg 3, the user's sketch): Rader,
// Leverans, Dokument, Historik … under the head. The first is the default;
// another is kept in ?flik= (replaceState — nothing is fetched), so a reload
// or a link shows it. Every panel stays mounted (hidden), so a half-written
// mail or a scrolled table survives a switch.
export function CardTabs({ tabs, label }: { tabs: CardTab[]; label: string }) {
  const searchParams = useSearchParams();
  const asked = searchParams.get("flik");
  const [active, setActive] = useState(tabs.some((t) => t.key === asked) ? asked! : tabs[0]!.key);

  function pick(key: string) {
    setActive(key);
    const url = new URL(window.location.href);
    if (key === tabs[0]!.key) url.searchParams.delete("flik");
    else url.searchParams.set("flik", key);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.strip} role="tablist" aria-label={label}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`card-tab-${tab.key}`}
            aria-selected={tab.key === active}
            aria-controls={`card-panel-${tab.key}`}
            className={styles.tab}
            onClick={() => pick(tab.key)}
          >
            {tab.label}
            {tab.count != null && <span className={styles.count}>{tab.count}</span>}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`card-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`card-tab-${tab.key}`}
          hidden={tab.key !== active}
          className={styles.panel}
        >
          {tab.node}
        </div>
      ))}
    </div>
  );
}
