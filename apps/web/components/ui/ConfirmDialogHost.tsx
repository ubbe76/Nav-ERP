"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { registerChooseOpener, registerConfirmOpener, type ChooseChoice } from "../../lib/confirm";
import styles from "./ConfirmDialogHost.module.css";

// One shape for both questions: confirmDialog is a single choice (true),
// chooseDialog carries its own. Avbryt is always added and answers null.
interface Pending {
  message: string;
  choices: ChooseChoice<unknown>[];
  resolve: (value: unknown) => void;
}

// The one in-app confirmation dialog (see lib/confirm.ts). Mounted once in
// AppShell; a second question while one is open answers the first with false.
export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function open(message: string, choices: ChooseChoice<unknown>[]): Promise<unknown> {
      return new Promise<unknown>((resolve) => {
        pendingRef.current?.resolve(null);
        const next = { message, choices, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    }
    registerConfirmOpener(
      async (message, options) =>
        (await open(message, [
          { label: options.confirmLabel ?? "OK", value: true, variant: options.danger ? "danger" : "primary" },
        ])) === true
    );
    registerChooseOpener(open);
    return () => {
      registerConfirmOpener(null);
      registerChooseOpener(null);
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    };
  }, []);

  // Focus the confirming button rather than the dialog's ✕, so Enter
  // confirms like the native dialog did: the first choice, since Avbryt comes
  // first in the DOM. Modal's effect (showModal) runs before this one, since
  // it is the child.
  useEffect(() => {
    if (pending) actionsRef.current?.querySelector<HTMLButtonElement>("button:nth-child(2)")?.focus();
  }, [pending]);

  function answer(value: unknown) {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(value);
  }

  return (
    <Modal open={pending !== null} onClose={() => answer(null)} title="Bekräfta" compact>
      {pending && (
        <>
          <p className={styles.message}>{pending.message}</p>
          <div ref={actionsRef} className={styles.actions}>
            <Button type="button" variant="ghost" onClick={() => answer(null)}>
              Avbryt
            </Button>
            {pending.choices.map((choice) => (
              <Button key={choice.label} type="button" variant={choice.variant ?? "primary"} onClick={() => answer(choice.value)}>
                {choice.label}
              </Button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
