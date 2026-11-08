"use client";

import { useEffect, type KeyboardEvent, type MouseEvent } from "react";
import { Columns2, X } from "lucide-react";
import { useDocumentTabs } from "./DocumentTabs";
import styles from "./TabStrip.module.css";

// The strip under the toolbar (Nav som program, punkt 5): the page first,
// then the open documents, and Delad vy at the right end. Shown only with
// at least one document open. Mounting it also tells the provider that an
// app frame is on screen.
export function TabStrip() {
  const { available, tabs, activeId, split, pageTitle, activate, close, setSplit, registerShell } = useDocumentTabs();

  useEffect(() => registerShell(), [registerShell]);

  if (!available || tabs.length === 0) return null;

  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const ids: (string | null)[] = [null, ...tabs.map((t) => t.id)];
    const index = ids.indexOf(activeId);
    const next = ids[(index + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length] ?? null;
    e.preventDefault();
    activate(next);
    const key = next ?? "page";
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)?.focus());
  }

  function onAuxClick(e: MouseEvent, id: string) {
    // Middle click closes, as in a browser.
    if (e.button === 1) {
      e.preventDefault();
      close(id);
    }
  }

  return (
    <div className={styles.strip}>
      <div className={styles.tabs} role="tablist" aria-label="Öppna dokument" onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          aria-selected={activeId === null}
          tabIndex={activeId === null ? 0 : -1}
          data-tab-key="page"
          className={`${styles.tab} ${styles.pageTab}`}
          onClick={() => activate(null)}
        >
          <span className={styles.title}>{pageTitle || "Sidan"}</span>
        </button>
        {tabs.map((tab) => (
          <div key={tab.id} className={styles.tabWrap} data-active={tab.id === activeId || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              tabIndex={tab.id === activeId ? 0 : -1}
              data-tab-key={tab.id}
              className={styles.tab}
              title={tab.title}
              onClick={() => activate(tab.id)}
              onAuxClick={(e) => onAuxClick(e, tab.id)}
            >
              <span className={styles.title}>{tab.title}</span>
            </button>
            <button
              type="button"
              className={styles.close}
              aria-label={`Stäng ${tab.title}`}
              title="Stäng fliken"
              onClick={() => close(tab.id)}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={styles.split}
        aria-pressed={split}
        title="Delad vy: sidan till vänster, dokumentet till höger"
        onClick={() => setSplit(!split)}
      >
        <Columns2 size={15} strokeWidth={1.8} aria-hidden="true" />
        Delad vy
      </button>
    </div>
  );
}
