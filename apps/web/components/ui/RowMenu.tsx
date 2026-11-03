"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ToggleEvent } from "react";
import styles from "./RowMenu.module.css";

export interface RowMenuItem {
  label: string;
  // A button item runs onSelect; a link item navigates to href.
  onSelect?: () => void;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
}

// Rough item height for the first placement — the menu is not laid out yet
// when beforetoggle fires; onToggle corrects it from the real size.
const ESTIMATED_ITEM_HEIGHT = 34;
const GAP = 4;
const VIEWPORT_MARGIN = 8;

// The ⋯ button at the end of a table row: the row's less frequent actions
// (Ta bort, Ändra konfiguration, Reklamera …) in a small menu, so the row
// stays one line high and the action column narrow.
//
// The menu is a popover (top layer, light dismiss and Esc from the
// browser): an absolutely positioned list would be clipped by the Table's
// overflow-x: auto and scroll inside the table on the last rows. It is
// placed with position: fixed under the button's right edge — above it when
// there is no room below — and closes on scroll and resize, since a fixed
// box does not follow the page. popoverTarget makes the button the invoker,
// so a click on it while open closes the menu instead of reopening it.
export function RowMenu({ items, label = "Fler åtgärder" }: { items: (RowMenuItem | false | null | undefined)[]; label?: string }) {
  const visible = items.filter((i): i is RowMenuItem => Boolean(i));
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const close = (e: Event) => {
      if (e.type === "scroll" && menu && e.target instanceof Node && menu.contains(e.target)) return;
      menu?.hidePopover();
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (visible.length === 0) return null;

  function place(menuHeight: number) {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const below = rect.bottom + GAP;
    const fitsBelow = below + menuHeight <= window.innerHeight - VIEWPORT_MARGIN;
    const above = rect.top - GAP - menuHeight;
    menu.style.top = `${fitsBelow || above < VIEWPORT_MARGIN ? below : above}px`;
    menu.style.right = `${Math.max(document.documentElement.clientWidth - rect.right, VIEWPORT_MARGIN)}px`;
  }

  function onBeforeToggle(e: ToggleEvent<HTMLDivElement>) {
    if (e.newState === "open") place(visible.length * ESTIMATED_ITEM_HEIGHT + 2 * GAP);
  }

  function onToggle(e: ToggleEvent<HTMLDivElement>) {
    const isOpen = e.newState === "open";
    setOpen(isOpen);
    if (!isOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    place(menu.getBoundingClientRect().height);
    // preventScroll: the menu is already inside the viewport, and a scroll
    // caused by the focus would trip the close-on-scroll listener.
    menu.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }

  // Arrow keys walk the items (wrapping), Home/End jump; Tab closes the menu
  // so focus never wanders off with it still open. Esc is the popover's own.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const menu = menuRef.current;
    if (!menu) return;
    if (e.key === "Tab") {
      menu.hidePopover();
      return;
    }
    const enabled = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)")];
    if (enabled.length === 0) return;
    const current = enabled.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (current + 1) % enabled.length;
    else if (e.key === "ArrowUp") next = (current - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next === null) return;
    e.preventDefault();
    enabled[next]?.focus({ preventScroll: true });
  }

  function select(item: RowMenuItem) {
    menuRef.current?.hidePopover();
    item.onSelect?.();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={label}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="3" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="13" cy="8" r="1.5" fill="currentColor" />
        </svg>
      </button>
      <div
        ref={menuRef}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className={styles.menu}
        onBeforeToggle={onBeforeToggle}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
      >
        {visible.map((item) => {
          const className = `${styles.item}${item.danger ? ` ${styles.danger}` : ""}`;
          return item.href && !item.disabled ? (
            <Link key={item.label} href={item.href} role="menuitem" className={className} onClick={() => menuRef.current?.hidePopover()}>
              {item.label}
            </Link>
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={className}
              disabled={item.disabled}
              onClick={() => select(item)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
