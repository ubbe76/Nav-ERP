"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Modal.module.css";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  // Wider box for dialogs built around a many-column table.
  wide?: boolean;
  // Small centered card on phones too, instead of the full-screen sheet
  // (short questions such as the confirmation dialog).
  compact?: boolean;
}

export function Modal({ open, onClose, title, children, wide = false, compact = false }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={[styles.dialog, wide && styles.wide, compact && styles.compact].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        // A dialog opened from inside another (Kopiera från in Ny artikel)
        // closes alone on Esc instead of taking its parent with it.
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Stäng">
          ✕
        </button>
      </div>
      {/* Children are unmounted while closed so form state (field values,
          pending flags) resets on every open instead of leaking between
          uses of the same modal. */}
      <div className={styles.body}>{open ? children : null}</div>
    </dialog>
  );
}
