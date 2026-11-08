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

// A question with more than two answers (Kopierat: Lägg till / Ersätt).
// Resolves the chosen value, or null for Avbryt/Esc/backdrop. The Avbryt
// button is always added by the dialog itself. Without a mounted host
// nothing can be asked, so it resolves null (no native fallback — a native
// confirm cannot offer three choices).
export interface ChooseChoice<T> {
  label: string;
  value: T;
  variant?: "primary" | "secondary" | "danger";
}

export interface ChooseOptions<T> {
  choices: ChooseChoice<T>[];
}

type ChooseOpener = (message: string, choices: ChooseChoice<unknown>[]) => Promise<unknown>;

let chooseOpener: ChooseOpener | null = null;

export function registerChooseOpener(next: ChooseOpener | null): void {
  chooseOpener = next;
}

export function chooseDialog<T>(message: string, options: ChooseOptions<T>): Promise<T | null> {
  if (!chooseOpener) return Promise.resolve(null);
  return chooseOpener(message, options.choices) as Promise<T | null>;
}
