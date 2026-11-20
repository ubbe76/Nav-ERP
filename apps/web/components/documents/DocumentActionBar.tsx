"use client";

import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { PrintButton } from "./PrintButton";
import { actionIcon } from "./actionIcons";
import { StatusPill, type Status } from "../ui/StatusPill";
import { FormError } from "../ui/Form";
import { RowMenu, type RowMenuItem } from "../ui/RowMenu";
import styles from "./DocumentActionBar.module.css";

interface Overflowed {
  label: string;
  disabled: boolean;
  danger: boolean;
  element: HTMLElement;
}

const isAction = (el: HTMLElement) => el.matches("button, a");

function textOf(node: ReactNode): string | null {
  if (typeof node === "string") return node;
  if (Array.isArray(node) && node.every((n) => typeof n === "string" || typeof n === "number")) return node.join("");
  return null;
}

function iconFor(label: string | null): ReactNode {
  const Icon = label ? actionIcon(label) : null;
  return Icon ? <Icon size={15} strokeWidth={1.9} aria-hidden="true" /> : null;
}

type ActionElement = ReactElement<{ children?: ReactNode; label?: string; className?: string; icon?: ReactNode }>;

// Programramen (the user's sketch): every action gets the icon for its label
// (actionIcons.tsx) — the cards pass plain labelled buttons and links,
// through conditionals and fragments. A link styled as a button gets the
// variant as data-variant, like a Button, so the bar can place it.
function decorate(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const el = child as ActionElement;
    if (el.type === Fragment) return <>{decorate(el.props.children)}</>;
    if (el.type === Button) {
      const icon = iconFor(textOf(el.props.children));
      return icon ? cloneElement(el, { icon }) : el;
    }
    if (el.type === PrintButton) return cloneElement(el, { icon: iconFor(el.props.label ?? "Skriv ut") });
    if (el.type === Link || el.type === "a") {
      const className = el.props.className ?? "";
      const variant = (["primary", "danger", "ghost", "secondary"] as const).find((v) => className.split(" ").includes(buttonStyles[v]!));
      return cloneElement(el, {
        children: (
          <>
            {iconFor(textOf(el.props.children))}
            {el.props.children}
          </>
        ),
        ...(variant ? { "data-variant": variant } : {}),
      } as Partial<ActionElement["props"]>);
    }
    return el;
  });
}

// The document's toolbar (Nav som program, punkt 3): the flow actions in one
// row at the top of the card, which stays under the app toolbar while the
// rows scroll by. Once the page header has scrolled away the bar also shows
// the document's number and status. Dumb layout — every button keeps its own
// handler in the card that renders it. On a phone it is an ordinary row.
//
// One line, always: when the actions do not fit, the ones that do not are
// hidden and listed in a ⋯ menu at the end, whose items click the hidden
// button or link (same handler, same dialog). The primary action and any
// text (a hint) stay in view; the rest give way from the end, so the rare
// ones — Förlorad, Avbryt order — go first.
export function DocumentActionBar({
  error,
  children,
  trailing,
  label,
  pill,
}: {
  // One error line for all the flow actions, under the bar.
  error?: string | null;
  children: ReactNode;
  // Right-aligned slot for the manual status override.
  trailing?: ReactNode;
  // The document's number and status, shown while the bar is stuck.
  label?: string;
  pill?: { status: Status; label: string };
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState<Overflowed[]>([]);

  // Measured on every size change and every change of the actions (they
  // follow the document's status). Runs in a frame before paint: every item
  // is shown, measured, and the ones that do not fit are hidden again.
  useLayoutEffect(() => {
    const box = actionsRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let lastKey = "";
    const measure = () => {
      const items = [...box.children].filter(
        (el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute("data-bar-more")
      );
      for (const el of items) el.removeAttribute("data-overflow");
      const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
      const widths = items.map((el) => el.offsetWidth);
      const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, items.length - 1);
      const available = box.clientWidth;
      let hidden: HTMLElement[] = [];
      if (total > available + 0.5) {
        const more = box.querySelector<HTMLElement>("[data-bar-more]");
        let used = (more?.offsetWidth || 36) + gap;
        const order = items
          .map((el, index) => ({ el, index }))
          .sort((a, b) => {
            // Text and the primary action first, then the rest in their order.
            const rank = (el: HTMLElement) => (!isAction(el) ? 0 : el.dataset.variant === "primary" ? 1 : 2);
            return rank(a.el) - rank(b.el) || a.index - b.index;
          });
        const keep = new Set<HTMLElement>();
        for (const { el, index } of order) {
          const width = widths[index]! + gap;
          if (!isAction(el) || used + width <= available) {
            keep.add(el);
            used += width;
          }
        }
        hidden = items.filter((el) => !keep.has(el));
        for (const el of hidden) el.setAttribute("data-overflow", "");
      }
      const next = hidden.map((el) => ({
        label: (el.textContent ?? "").replace(/\s+/g, " ").trim() || el.getAttribute("aria-label") || "Åtgärd",
        disabled: el.matches(":disabled") || el.getAttribute("aria-disabled") === "true",
        danger: el.dataset.variant === "danger",
        element: el,
      }));
      const key = next.map((o) => `${o.label}|${o.disabled}`).join("\n");
      if (key !== lastKey) {
        lastKey = key;
        setOverflowed(next);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(box);
    // Our own data-overflow is not observed — only what the card changes.
    const mutation = new MutationObserver(schedule);
    mutation.observe(box, { childList: true, subtree: true, characterData: true, attributeFilter: ["disabled"] });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  const moreItems: RowMenuItem[] = overflowed.map((o) => ({
    label: o.label,
    disabled: o.disabled,
    danger: o.danger,
    onSelect: () => o.element.click(),
  }));

  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const toolbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-toolbar-height")) || 0;
    // The sentinel sits right above the bar: once it has passed under the
    // app toolbar, the bar is stuck.
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!!entry && !entry.isIntersecting && entry.boundingClientRect.top < toolbar + 1),
      { rootMargin: `-${toolbar}px 0px 0px 0px`, threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      <div className={styles.bar} data-stuck={stuck}>
        {label && (
          <span className={styles.ident} aria-hidden={!stuck}>
            <span className={styles.number}>{label}</span>
            {pill && <StatusPill status={pill.status} label={pill.label} compact />}
          </span>
        )}
        <div ref={actionsRef} className={styles.actions}>
          {decorate(children)}
          {/* Always rendered (hidden when nothing overflows) so its width is
              known before it is needed. */}
          <span className={styles.more} data-bar-more="" hidden={moreItems.length === 0}>
            <RowMenu items={moreItems} label="Fler åtgärder" />
          </span>
        </div>
        {trailing && <div className={styles.trailing}>{trailing}</div>}
      </div>
      <FormError margin="below">{error}</FormError>
    </>
  );
}
