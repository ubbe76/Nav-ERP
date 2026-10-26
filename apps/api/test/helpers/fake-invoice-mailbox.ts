import MailComposer from "nodemailer/lib/mail-composer/index.js";
import {
  InvoiceMailboxError,
  type InvoiceMailbox,
  type InvoiceMailboxConfig,
  type InvoiceMailboxFactory,
} from "../../src/modules/purchase/service/invoice-scan/invoice-mailbox.js";

// In-memory IMAP mailbox for the Fakturainkorg's e-mail tests — never a
// network call. The letters are real MIME (built with nodemailer's
// MailComposer), so mail-mime.ts parses them with mailparser exactly as in
// production. `state` scripts failures: at connect, on a letter's fetch or
// move, and Testa anslutning's answer.

export interface FakeLetter {
  uid: number;
  source: Buffer;
  // What the server reports as the size (defaults to the source's length).
  size?: number | null;
}

export interface FakeMailbox {
  factory: InvoiceMailboxFactory;
  // Every config the factory was called with (the job and Testa anslutning).
  configs: InvoiceMailboxConfig[];
  state: {
    inbox: FakeLetter[];
    processed: FakeLetter[];
    connectError: Error | null;
    // uid -> error for that letter's fetch / move.
    fetchErrors: Map<number, Error>;
    moveErrors: Map<number, Error>;
    inspect: { unseen: number; processedFolderExists: boolean };
    inspectError: Error | null;
    connects: number;
    closes: number;
    fetches: number[];
  };
  // Puts a letter in the inbox; the uid counts up.
  deliver(source: Buffer, size?: number | null): FakeLetter;
  reset(): void;
}

export function createFakeInvoiceMailbox(): FakeMailbox {
  const configs: InvoiceMailboxConfig[] = [];
  let nextUid = 1;
  const state: FakeMailbox["state"] = {
    inbox: [],
    processed: [],
    connectError: null,
    fetchErrors: new Map(),
    moveErrors: new Map(),
    inspect: { unseen: 3, processedFolderExists: true },
    inspectError: null,
    connects: 0,
    closes: 0,
    fetches: [],
  };

  const factory: InvoiceMailboxFactory = (config): InvoiceMailbox => {
    configs.push(config);
    let connected = false;
    return {
      async connect() {
        state.connects++;
        if (state.connectError) throw state.connectError;
        connected = true;
      },
      async listUnprocessed(limit) {
        if (!connected) throw new InvoiceMailboxError("connection", "not connected");
        return state.inbox.slice(0, limit).map((l) => ({ uid: l.uid, size: l.size === undefined ? l.source.length : l.size }));
      },
      async fetch(uid) {
        state.fetches.push(uid);
        const error = state.fetchErrors.get(uid);
        if (error) throw error;
        const letter = state.inbox.find((l) => l.uid === uid);
        if (!letter) throw new InvoiceMailboxError("unexpected", "gone");
        return letter.source;
      },
      async moveToProcessed(uid) {
        const error = state.moveErrors.get(uid);
        if (error) throw error;
        const index = state.inbox.findIndex((l) => l.uid === uid);
        if (index < 0) throw new InvoiceMailboxError("move_failed", "gone");
        state.processed.push(...state.inbox.splice(index, 1));
      },
      async close() {
        state.closes++;
        connected = false;
      },
      async inspect() {
        if (state.inspectError) throw state.inspectError;
        return { ...state.inspect };
      },
    };
  };

  return {
    factory,
    configs,
    state,
    deliver(source, size) {
      const letter: FakeLetter = { uid: nextUid++, source, ...(size !== undefined ? { size } : {}) };
      state.inbox.push(letter);
      return letter;
    },
    reset() {
      nextUid = 1;
      configs.length = 0;
      state.inbox = [];
      state.processed = [];
      state.connectError = null;
      state.fetchErrors = new Map();
      state.moveErrors = new Map();
      state.inspect = { unseen: 3, processedFolderExists: true };
      state.inspectError = null;
      state.connects = 0;
      state.closes = 0;
      state.fetches = [];
    },
  };
}

export interface LetterAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  // Inline image shown by the HTML body (signature logo).
  cid?: string;
}

// A real RFC822 letter. `messageId: null` strips the header nodemailer
// always adds (a letter without Message-ID).
export async function buildLetter(opts: {
  from?: string;
  subject?: string;
  date?: Date;
  messageId?: string | null;
  attachments?: LetterAttachment[];
  // Authentication-Results headers put on top of the letter, first = topmost
  // (what the receiving server adds). Omitted = none.
  authenticationResults?: string[];
}): Promise<Buffer> {
  const inline = (opts.attachments ?? []).filter((a) => a.cid);
  const composer = new MailComposer({
    from: opts.from ?? "Faktura <faktura@platgrossisten.example>",
    to: "fakturor@navkund.example",
    subject: opts.subject ?? "Faktura 4711",
    date: opts.date ?? new Date("2026-10-20T08:00:00Z"),
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    text: "Hej! Här kommer fakturan.",
    html: `<p>Hej! Här kommer fakturan.</p>${inline.map((a) => `<img src="cid:${a.cid}">`).join("")}`,
    attachments: (opts.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      ...(a.cid ? { cid: a.cid, contentDisposition: "inline" as const } : {}),
    })),
  });
  let built = await new Promise<Buffer>((resolve, reject) => composer.compile().build((err, message) => (err ? reject(err) : resolve(message))));
  if (opts.messageId === null) built = Buffer.from(built.toString("latin1").replace(/^Message-ID: .*\r\n/im, ""), "latin1");
  const auth = (opts.authenticationResults ?? []).map((value) => `Authentication-Results: ${value}\r\n`).join("");
  return auth ? Buffer.concat([Buffer.from(auth, "latin1"), built]) : built;
}
