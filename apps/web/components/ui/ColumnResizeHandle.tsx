"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clampColumnWidth } from "../../lib/listColumns";
import styles from "./Table.module.css";

// Kolumnbredd (Nav som program, punkt 6): the edge of a header cell. While
// dragging, the table's grid is changed directly (no re-render per pixel);
// on release the new content width goes to onResize, whose saved setting
// re-renders the table with it. A double click resets the column; with the
// keyboard ←/→ change it 16 px at a time.
export function ColumnResizeHandle({
  label,
  extra,
  onResize,
}: {
  label: string;
  // The padding the cell adds to its content width (Table's trackWidth).
  extra: number;
  onResize: (width: number | null) => void;
}) {
  const drag = useRef<{ x: number; tracks: number[]; index: number; template: string; table: HTMLElement } | null>(null);

  function start(handle: HTMLElement) {
    const cell = handle.parentElement;
    const table = handle.closest<HTMLElement>("[data-table]");
    if (!cell || !table) return null;
    const index = [...cell.parentElement!.children].indexOf(cell);
    // The computed template is every track resolved to px.
    const tracks = getComputedStyle(table)
      .gridTemplateColumns.split(" ")
      .map((t) => parseFloat(t));
    if (index < 0 || tracks.length <= index || tracks.some((t) => Number.isNaN(t))) return null;
    return { tracks, index, template: table.style.gridTemplateColumns, table };
  }

  function show(state: NonNullable<typeof drag.current>, trackPx: number) {
    const tracks = [...state.tracks];
    tracks[state.index] = trackPx;
    state.table.style.gridTemplateColumns = tracks.map((t) => `${t}px`).join(" ");
  }

  function contentWidth(trackPx: number) {
    return clampColumnWidth(trackPx - extra);
  }

  function onPointerDown(e: PointerEvent<HTMLSpanElement>) {
    if (e.button !== 0) return;
    const state = start(e.currentTarget);
    if (!state) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { ...state, x: e.clientX };
  }

  function trackFor(state: NonNullable<typeof drag.current>, dx: number) {
    return contentWidth(state.tracks[state.index]! + dx) + extra;
  }

  function onPointerMove(e: PointerEvent<HTMLSpanElement>) {
    const state = drag.current;
    if (!state) return;
    show(state, trackFor(state, e.clientX - state.x));
  }

  function onPointerUp(e: PointerEvent<HTMLSpanElement>) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    const dx = e.clientX - state.x;
    if (Math.abs(dx) < 2) {
      // A click, not a drag: leave the table as it was.
      state.table.style.gridTemplateColumns = state.template;
      return;
    }
    onResize(contentWidth(state.tracks[state.index]! + dx));
  }

  function onKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const state = start(e.currentTarget);
    if (!state) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.key === "ArrowRight" ? 16 : -16;
    onResize(contentWidth(state.tracks[state.index]! + step));
  }

  return (
    <span
      className={styles.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Ändra bredd på kolumnen ${label}`}
      title="Dra för att ändra bredden, dubbelklicka för att återställa"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        if (drag.current) drag.current.table.style.gridTemplateColumns = drag.current.template;
        drag.current = null;
      }}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
    />
  );
}
