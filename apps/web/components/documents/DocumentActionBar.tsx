"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusPill, type Status } from "../ui/StatusPill";
import { FormError } from "../ui/Form";
import styles from "./DocumentActionBar.module.css";

// The document's toolbar (Nav som program, punkt 3): the flow actions in one
// row at the top of the card, which stays under the app toolbar while the
// rows scroll by. Once the page header has scrolled away the bar also shows
// the document's number and status. Dumb layout — every button keeps its own
// handler in the card that renders it. On a phone it is an ordinary row.
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
        <div className={styles.actions}>{children}</div>
        {trailing && <div className={styles.trailing}>{trailing}</div>}
      </div>
      <FormError margin="below">{error}</FormError>
    </>
  );
}
