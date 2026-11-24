"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { ArticleOverviewContent } from "./ArticleOverviewContent";
import { useArticleOverview } from "./ArticleOverviewProvider";
import styles from "./ArticleOverview.module.css";

// Where the panel was last dragged to and how big it was made — per browser,
// like the sidebar's collapsed state (Nav.tsx). Wrapped in try/catch
// everywhere: storage can be unavailable (private mode, blocked site data)
// and the panel must still work.
const POSITION_KEY = "nav-erp-article-overview-pos";
const SIZE_KEY = "nav-erp-article-overview-size";
const EDGE = 8;
// Keep at least the header on screen so a panel can always be grabbed back.
const MIN_VISIBLE = 48;
// The smallest panel that still shows the picker and a few rows (the row
// list scrolls sideways inside the body below its ~810 px).
const MIN_WIDTH = 420;
const MIN_HEIGHT = 220;

interface Position {
  left: number;
  top: number;
}

interface Size {
  width: number;
  height: number;
}

function clampPosition(pos: Position, width: number): Position {
  const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
  const maxTop = Math.max(EDGE, window.innerHeight - MIN_VISIBLE);
  return {
    left: Math.min(Math.max(pos.left, EDGE), maxLeft),
    top: Math.min(Math.max(pos.top, EDGE), maxTop),
  };
}

// The panel's bottom-right corner stays inside the window: the size is
// capped by the room right of and below the panel's top-left corner.
function clampSize(size: Size, pos: Position | null): Size {
  const roomWidth = window.innerWidth - (pos ? pos.left : EDGE) - EDGE;
  const roomHeight = window.innerHeight - (pos ? pos.top : EDGE) - EDGE;
  return {
    width: Math.round(Math.min(Math.max(size.width, MIN_WIDTH), Math.max(MIN_WIDTH, roomWidth))),
    height: Math.round(Math.min(Math.max(size.height, MIN_HEIGHT), Math.max(MIN_HEIGHT, roomHeight))),
  };
}

// A stored { left, top } or { width, height } — null when missing, corrupt or
// storage is unavailable (the panel then uses its CSS default).
function readStored<K extends string>(key: string, fields: readonly K[]): Record<K, number> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const out = {} as Record<K, number>;
    for (const field of fields) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      out[field] = value;
    }
    return out;
  } catch {
    // Unavailable or corrupt storage — fall back to the CSS default.
    return null;
  }
}

function store(key: string, value: Position | Size) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisting is fine; the panel still moves/resizes for this page view.
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
  // null = never resized → the CSS default size (880 px wide, at most 70vh).
  const [size, setSize] = useState<Size | null>(null);
  const sizeRef = useRef<Size | null>(null);
  // Phone layout: bottom sheet, no dragging (CSS media query does the layout;
  // this flag only stops the inline left/top from overriding it).
  const [narrow, setNarrow] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const applyPosition = useCallback((next: Position | null) => {
    posRef.current = next;
    setPos(next);
  }, []);

  const applySize = useCallback((next: Size | null) => {
    sizeRef.current = next;
    setSize(next);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Restore the last position and size once mounted (the position needs the
  // panel's width to clamp). A size only comes with a position — resizing
  // always pins the panel's top-left corner first.
  useEffect(() => {
    if (!panelRef.current || window.matchMedia("(max-width: 640px)").matches) return;
    const storedPos = readStored(POSITION_KEY, ["left", "top"] as const);
    if (!storedPos) return;
    const storedSize = readStored(SIZE_KEY, ["width", "height"] as const);
    const width = storedSize ? Math.min(Math.max(storedSize.width, MIN_WIDTH), window.innerWidth - 2 * EDGE) : panelRef.current.offsetWidth;
    const nextPos = clampPosition(storedPos, width);
    applyPosition(nextPos);
    if (storedSize) applySize(clampSize(storedSize, nextPos));
  }, [applyPosition, applySize]);

  // A window that shrinks must not leave the panel stranded off-screen.
  useEffect(() => {
    const onResize = () => {
      if (!posRef.current || !panelRef.current) return;
      const nextPos = clampPosition(posRef.current, sizeRef.current?.width ?? panelRef.current.offsetWidth);
      applyPosition(nextPos);
      if (sizeRef.current) applySize(clampSize(sizeRef.current, nextPos));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyPosition, applySize]);

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
    if (posRef.current) store(POSITION_KEY, posRef.current);
  }

  // The grip in the bottom-right corner (user's request 2026-11-24: keep the
  // panel open beside the Behovsberäkning list — at 880 px it covered the
  // rows). Resizing pins the top-left corner, so a panel still sitting in its
  // CSS corner (right/bottom) gets its current place as left/top first.
  function onResizeDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (narrow || e.button !== 0 || !panelRef.current) return;
    e.preventDefault();
    const rect = panelRef.current.getBoundingClientRect();
    if (!posRef.current) applyPosition({ left: Math.round(rect.left), top: Math.round(rect.top) });
    resizeRef.current = { x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeRef.current;
    if (!start) return;
    applySize(
      clampSize({ width: start.width + e.clientX - start.x, height: start.height + e.clientY - start.y }, posRef.current)
    );
  }

  function onResizeUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (posRef.current) store(POSITION_KEY, posRef.current);
    if (sizeRef.current) store(SIZE_KEY, sizeRef.current);
  }

  const style =
    narrow || !pos
      ? undefined
      : {
          left: pos.left,
          top: pos.top,
          right: "auto",
          bottom: "auto",
          ...(size ? { width: size.width, height: size.height, maxHeight: "none" } : {}),
        };

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
      <div
        className={styles.resizeGrip}
        title="Ändra storlek"
        aria-hidden="true"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </div>
  );
}
