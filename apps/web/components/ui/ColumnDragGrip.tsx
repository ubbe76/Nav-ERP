"use client";

import { useEffect, useRef } from "react";
import { GripVertical } from "lucide-react";
import styles from "./Table.module.css";

// The column being dragged — one drag at a time, from a grip to a header
// cell of the same list.
let dragging: string | null = null;

// Kolumnordning (Nav som program): a grip in a movable column's header cell.
// Drag it onto another movable column's heading — the left half drops the
// column before it, the right half after it. The header cell (server-
// rendered by Table) is made a drop target here, so Table stays usable from
// server components; only useListColumns hands out onReorder. The Kolumner
// panel has ↑/↓ for the keyboard.
export function ColumnDragGrip({
  columnKey,
  label,
  onReorder,
}: {
  columnKey: string;
  label: string;
  onReorder: (fromKey: string, toKey: string, after: boolean) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    const cell = ref.current?.parentElement;
    if (!cell) return;
    const over = (e: DragEvent) => {
      if (!dragging || dragging === columnKey) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const box = cell.getBoundingClientRect();
      cell.dataset.drop = e.clientX > box.left + box.width / 2 ? "after" : "before";
    };
    const leave = () => {
      delete cell.dataset.drop;
    };
    const drop = (e: DragEvent) => {
      const from = dragging;
      if (!from) return;
      e.preventDefault();
      const after = cell.dataset.drop === "after";
      delete cell.dataset.drop;
      dragging = null;
      if (from !== columnKey) onReorderRef.current(from, columnKey, after);
    };
    cell.addEventListener("dragover", over);
    cell.addEventListener("dragleave", leave);
    cell.addEventListener("drop", drop);
    return () => {
      cell.removeEventListener("dragover", over);
      cell.removeEventListener("dragleave", leave);
      cell.removeEventListener("drop", drop);
    };
  }, [columnKey]);

  return (
    <span
      ref={ref}
      className={styles.dragGrip}
      draggable
      aria-hidden="true"
      title={`Dra för att flytta kolumnen ${label}`}
      onDragStart={(e) => {
        dragging = columnKey;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", label);
      }}
      onDragEnd={() => {
        dragging = null;
      }}
    >
      <GripVertical size={12} strokeWidth={2} />
    </span>
  );
}
