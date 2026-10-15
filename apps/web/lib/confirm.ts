// In-app confirmation. window.confirm is not reliable: Safari on iPhone can
// stop showing it, and then it answers "cancel" without a word, so a Ta bort
// button silently does nothing. confirmDialog opens the app's own dialog
// (ConfirmDialogHost, mounted once in AppShell) and resolves true for the
// confirm button, false for Avbryt/Esc/backdrop. Outside AppShell (no host
// mounted) it falls back to window.confirm.

export interface ConfirmOptions {
  // Label of the confirming button; defaults to "OK".
  confirmLabel?: string;
  // Destructive action: the confirming button uses the danger style.
  danger?: boolean;
}

type ConfirmOpener = (message: string, options: ConfirmOptions) => Promise<boolean>;

let opener: ConfirmOpener | null = null;

export function registerConfirmOpener(next: ConfirmOpener | null): void {
  opener = next;
}

export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (opener) return opener(message, options);
  return Promise.resolve(window.confirm(message));
}

// Shorthand for the common "Ta bort …?" question.
export function confirmDelete(message: string): Promise<boolean> {
  return confirmDialog(message, { confirmLabel: "Ta bort", danger: true });
}
