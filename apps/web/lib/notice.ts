// Notiser (Nav som program, punkt 7): a short note at the corner of the
// screen after something was done — "Inlevererat 5 st 1002" — with Ångra
// where the routine can be undone. notify() hands it to NoticeHost, mounted
// once in AppShell beside ConfirmDialogHost; the host lives outside the page
// content, so the note stays while router.refresh() reloads the page's data.
// Without a mounted host (a page outside AppShell) nothing is shown — a
// notice only confirms what the page already did.

export type NoticeTone = "success" | "info" | "error";

export interface NoticeAction {
  // "Ångra", or "Ångra…" when it opens a dialog.
  label: string;
  // Runs once. Resolves the text the notice then shows (default "Ångrat."),
  // or null to close the notice without a word (it opened a dialog). A
  // throw shows the error in the notice.
  run: () => Promise<string | null | void>;
}

export interface NoticeInput {
  message: string;
  tone?: NoticeTone;
  action?: NoticeAction;
}

type NoticeOpener = (notice: NoticeInput) => void;

let opener: NoticeOpener | null = null;

export function registerNoticeHost(next: NoticeOpener | null): void {
  opener = next;
}

export function notify(notice: NoticeInput | string): void {
  opener?.(typeof notice === "string" ? { message: notice } : notice);
}

// How long a notice stays: long enough to reach Ångra, short enough not to
// pile up. Paused while the pointer or the focus is on it.
export const NOTICE_MS = 6000;
export const NOTICE_WITH_ACTION_MS = 12000;
export const NOTICE_ERROR_MS = 12000;
export const MAX_NOTICES = 3;
