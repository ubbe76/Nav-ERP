"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { ArticleOverviewContent } from "./ArticleOverviewContent";
import { useArticleOverview } from "./ArticleOverviewProvider";
import styles from "./ArticleOverview.module.css";

// Where the panel was last dragged to — per browser, like the sidebar's
// collapsed state (Nav.tsx). Wrapped in try/catch everywhere: storage can be
// unavailable (private mode, blocked site data) and the panel must still work.
const POSITION_KEY = "nav-erp-article-overview-pos";
const EDGE = 8;
// Keep at least the header on screen so a panel can always be grabbed back.
const MIN_VISIBLE = 48;

interface Position {
  left: number;
  top: number;
}

function clampPosition(pos: Position, width: number): Position {
  const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
  const maxTop = Math.max(EDGE, window.innerHeight - MIN_VISIBLE);
  return {
    left: Math.min(Math.max(pos.left, EDGE), maxLeft),
    top: Math.min(Math.max(pos.top, EDGE), maxTop),
  };
}

function readStoredPosition(): Position | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Position).left === "number" &&
      typeof (parsed as Position).top === "number" &&
      Number.isFinite((parsed as Position).left) &&
      Number.isFinite((parsed as Position).top)
    ) {
      return { left: (parsed as Position).left, top: (parsed as Position).top };
    }
  } catch {
    // Unavailable or corrupt storage — fall back to the default corner.
  }
  return null;
}

function storePosition(pos: Position) {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
  } catch {
    // Not persisting is fine; the panel still moves for this page view.
  }
}

// The floating, draggable, NON-modal Artikelöversikt. Rendered by the
// provider; null while closed so the content (and its fetch) unmounts and a
// re-open always loads fresh rows. The hooks live in PanelFrame so this
// wrapper can return early.
export function ArticleOverviewPanel() {
  const { articleId, show, close } = useArticleOverview();
  if (articleId === null) return null;
  return (
    <PanelFrame onClose={close} pageHref={`/artiklar/oversikt?article=${articleId}`}>
      <ArticleOverviewContent articleId={articleId} onChangeArticle={show} pickerId="article-overview-panel-picker" />
    </PanelFrame>
  );
}

function PanelFrame({
  onClose,
  pageHref,
  children,
}: {
  onClose: () => void;
  pageHref: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // null = no stored/dragged position yet → the CSS default corner applies.
  const [pos, setPos] = useState<Position | null>(null);
  const posRef = useRef<Position | null>(null);
  // Phone layout: bottom sheet, no dragging (CSS media query does the layout;
  // this flag only stops the inline left/top from overriding it).
  const [narrow, setNarrow] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const applyPosition = useCallback((next: Position | null) => {
    posRef.current = next;
    setPos(next);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Restore the last position once mounted (needs the panel's width to clamp).
  useEffect(() => {
    const stored = readStoredPosition();
    if (!stored || !panelRef.current) return;
    applyPosition(clampPosition(stored, panelRef.current.offsetWidth));
  }, [applyPosition]);

  // A window that shrinks must not leave the panel stranded off-screen.
  useEffect(() => {
    const onResize = () => {
      if (!posRef.current || !panelRef.current) return;
      applyPosition(clampPosition(posRef.current, panelRef.current.offsetWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyPosition]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target instanceof Element ? e.target : null;
      // Esc inside an OPEN article-picker dropdown dismisses the dropdown,
      // not the panel (SearchPicker's own handler runs first, but React has
      // not re-rendered yet, so aria-expanded still reads "true" here).
      if (target?.closest('[role="combobox"][aria-expanded="true"]')) return;
      // A native <dialog> modal on top of the page owns Esc (its cancel
      // event closes it); the panel behind it stays.
      if (document.querySelector("dialog[open]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Move focus into the panel on open so keyboard users land in it (and
  // Esc works right away) instead of tabbing across the page to reach it.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (narrow || e.button !== 0) return;
    // The header's link and close button keep their own click behaviour.
    if ((e.target as HTMLElement).closest("a, button")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !panelRef.current) return;
    applyPosition(
      clampPosition({ left: e.clientX - drag.dx, top: e.clientY - drag.dy }, panelRef.current.offsetWidth)
    );
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (posRef.current) storePosition(posRef.current);
  }

  const style = pos && !narrow ? { left: pos.left, top: pos.top, right: "auto", bottom: "auto" } : undefined;

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label="Artikelöversikt"
      tabIndex={-1}
    >
      <div
        className={styles.header}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <h2 className={styles.title}>Artikelöversikt</h2>
        <Link href={pageHref} className={styles.headerLink}>
          Öppna sida
        </Link>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Stäng">
          ✕
        </button>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
