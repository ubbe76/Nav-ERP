"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { registerConfirmOpener, type ConfirmOptions } from "../../lib/confirm";
import styles from "./ConfirmDialogHost.module.css";

interface Pending extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

// The one in-app confirmation dialog (see lib/confirm.ts). Mounted once in
// AppShell; a second question while one is open answers the first with false.
export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerConfirmOpener(
      (message, options) =>
        new Promise<boolean>((resolve) => {
          pendingRef.current?.resolve(false);
          const next = { ...options, message, resolve };
          pendingRef.current = next;
          setPending(next);
        })
    );
    return () => {
      registerConfirmOpener(null);
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  // Focus the confirming button rather than the dialog's ✕, so Enter
  // confirms like the native dialog did. Modal's effect (showModal) runs
  // before this one, since it is the child.
  useEffect(() => {
    if (pending) actionsRef.current?.querySelector<HTMLButtonElement>("button:last-child")?.focus();
  }, [pending]);

  function answer(ok: boolean) {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
  }

  return (
    <Modal open={pending !== null} onClose={() => answer(false)} title="Bekräfta" compact>
      {pending && (
        <>
          <p className={styles.message}>{pending.message}</p>
          <div ref={actionsRef} className={styles.actions}>
            <Button type="button" variant="ghost" onClick={() => answer(false)}>
              Avbryt
            </Button>
            <Button
              type="button"
              variant={pending.danger ? "danger" : "primary"}
              onClick={() => answer(true)}
            >
              {pending.confirmLabel ?? "OK"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
