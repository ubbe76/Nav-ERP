"use client";

import { useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Columns2, X } from "lucide-react";
import { useDocumentTabs } from "./DocumentTabs";
import styles from "./TabStrip.module.css";

// The strip under the toolbar (Nav som program, punkt 5): the page first,
// then the open documents, and Delad vy at the right end. Shown only with
// at least one document open. Mounting it also tells the provider that an
// app frame is on screen. A document tab can be dragged to a new place
// (drop on a tab: before it, or after it in its right half).
export function TabStrip() {
  const { available, tabs, activeId, split, pageTitle, activate, move, close, setSplit, registerShell } = useDocumentTabs();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

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

  // The index among the documents a drop on tab `index` lands on: before it
  // in its left half, after it in its right half.
  function dropIndex(e: DragEvent<HTMLDivElement>, index: number): number {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX > box.left + box.width / 2 ? index + 1 : index;
  }

  function onDragOver(e: DragEvent<HTMLDivElement>, index: number) {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropAt(dropIndex(e, index));
  }

  function onDrop(e: DragEvent<HTMLDivElement>, index: number) {
    if (!dragging) return;
    e.preventDefault();
    const target = dropIndex(e, index);
    const from = tabs.findIndex((t) => t.id === dragging);
    // Removing the dragged tab first shifts the later places one step.
    move(dragging, from !== -1 && from < target ? target - 1 : target);
    setDragging(null);
    setDropAt(null);
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
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={styles.tabWrap}
            data-active={tab.id === activeId || undefined}
            data-dragging={dragging === tab.id || undefined}
            data-drop={dropAt === index ? "before" : dropAt === index + 1 && index === tabs.length - 1 ? "after" : undefined}
            draggable
            onDragStart={(e) => {
              setDragging(tab.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", tab.title);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropAt(null);
            }}
            onDragOver={(e) => onDragOver(e, index)}
            onDrop={(e) => onDrop(e, index)}
          >
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
