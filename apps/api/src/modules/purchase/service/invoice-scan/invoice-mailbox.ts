// Fakturaskanning — the ONE seam between Nav and the IMAP mailbox (spec §4).
// The e-mail job only ever speaks this interface; imapflow-mailbox.ts is the
// only file that knows imapflow, and tests inject a fake
// (test/helpers/fake-invoice-mailbox.ts). The factory is called per run and
// per Testa anslutning with the settings read at that moment — a changed
// password needs no restart. The letter itself comes back as its raw source;
// mail-mime.ts (mailparser) parses it, so a fake mailbox serves real MIME.
//
// The password is handed to the mailbox and nowhere else: never logged, never
// part of an error.

export interface InvoiceMailboxConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  // The folder that is read (INBOX) and where read letters are moved
  // (Nav/Inlästa — "/" separates the levels whatever the server's delimiter).
  folder: string;
  processedFolder: string;
}

export interface MailboxMessageRef {
  uid: number;
  // RFC822 size as the server reports it (null when it does not).
  size: number | null;
}

export interface InvoiceMailbox {
  // Logs in, opens `folder` and makes sure `processedFolder` exists (created
  // on the first run). Throws InvoiceMailboxError.
  connect(): Promise<void>;
  // Every letter in `folder`, oldest first, at most `limit` — read letters
  // are moved out, so everything still there is unprocessed (a letter
  // someone already opened in a mail client counts too).
  listUnprocessed(limit: number): Promise<MailboxMessageRef[]>;
  // The letter's raw source (RFC822).
  fetch(uid: number): Promise<Buffer>;
  moveToProcessed(uid: number): Promise<void>;
  // Never throws.
  close(): Promise<void>;
  // Testa anslutning: log in, check `folder`, count its unseen letters and
  // whether `processedFolder` exists — creates nothing. Logs out itself.
  inspect(): Promise<{ unseen: number; processedFolderExists: boolean }>;
}

export type InvoiceMailboxFactory = (config: InvoiceMailboxConfig) => InvoiceMailbox;

// What went wrong, as the job and Testa anslutning need it — never the
// server's own text.
export type InvoiceMailboxErrorKind =
  | "not_configured" // server, user or password missing
  | "connection" // DNS, refused, reset, closed
  | "timeout" // no answer in time
  | "tls" // certificate or handshake
  | "auth" // the server refused the login
  | "folder_missing" // `folder` does not exist
  | "processed_folder" // `processedFolder` could not be created
  | "move_failed" // a letter could not be moved to `processedFolder`
  | "unexpected";

export class InvoiceMailboxError extends Error {
  constructor(
    public readonly kind: InvoiceMailboxErrorKind,
    // For the server log only: the error class and code, never a message
    // (an IMAP server's answer may echo the command).
    public readonly detail: string | null = null
  ) {
    super(`Invoice mailbox failed: ${kind}`);
    this.name = "InvoiceMailboxError";
  }
}

// The Swedish texts written to invoice_scan_mail_last_error and returned by
// Testa anslutning.
export function mailboxErrorText(kind: InvoiceMailboxErrorKind, config?: { folder: string; processedFolder: string }): string {
  switch (kind) {
    case "not_configured":
      return "E-postlådan saknar server, användare eller lösenord";
    case "connection":
      return "Kunde inte ansluta till e-postservern — kontrollera server och port";
    case "timeout":
      return "E-postservern svarade inte";
    case "tls":
      return "Den krypterade anslutningen (TLS) till e-postservern misslyckades";
    case "auth":
      return "Inloggningen till e-postlådan misslyckades — kontrollera användare och lösenord";
    case "folder_missing":
      return config ? `Mappen ${config.folder} finns inte i e-postlådan` : "Mappen finns inte i e-postlådan";
    case "processed_folder":
      return config ? `Mappen ${config.processedFolder} kunde inte skapas i e-postlådan` : "Mappen för inlästa kunde inte skapas";
    case "move_failed":
      return config
        ? `Lästa brev kunde inte flyttas till mappen ${config.processedFolder} — de läses igen vid nästa körning`
        : "Lästa brev kunde inte flyttas till mappen för inlästa";
    case "unexpected":
      return "Oväntat fel när e-postlådan lästes";
  }
}
