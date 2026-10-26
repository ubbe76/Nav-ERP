import type { ImapFlow, ImapFlowOptions, MailboxLockObject } from "imapflow";
import {
  InvoiceMailboxError,
  type InvoiceMailbox,
  type InvoiceMailboxConfig,
  type InvoiceMailboxErrorKind,
  type InvoiceMailboxFactory,
} from "./invoice-mailbox.js";

// Fakturaskanning — the IMAP mailbox through imapflow (spec §4). The ONLY
// file that imports imapflow, lazily so the app and the tests that never
// read a mailbox skip loading it. imapflow's own logging is off (it would
// write the login exchange), an error never carries the server's text out
// of here (InvoiceMailboxError.kind + class/code only), and the password
// lives only in the client's auth options.

const CONNECTION_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 5 * 60_000;
// One IMAP literal (a letter's source) at most this large — bounds memory
// against a broken server. The job skips letters over its own, smaller cap
// before fetching them.
const MAX_LITERAL_BYTES = 128 * 1024 * 1024;

const TLS_CODES = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ClosedAfterConnectTLS|STARTTLS_INJECTION|UPGRADE_TIMEOUT|EPROTO$)/;
const TIMEOUT_CODES = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "ETIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT", "LockTimeout"]);
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "StateLogout",
]);

type ImapError = Error & { code?: string; authenticationFailed?: boolean; tlsFailed?: boolean; mailboxMissing?: boolean };

// imapflow's (and Node's socket/TLS/DNS) errors as the seam's kinds. The
// detail is the class name and code — never the message.
export function toMailboxError(err: unknown, fallback: InvoiceMailboxErrorKind = "unexpected"): InvoiceMailboxError {
  if (err instanceof InvoiceMailboxError) return err;
  const e = (err ?? {}) as ImapError;
  const code = typeof e.code === "string" ? e.code : "";
  const detail = `${e.name ?? "Error"}${code ? `:${code}` : ""}`;
  let kind: InvoiceMailboxErrorKind = fallback;
  if (e.authenticationFailed) kind = "auth";
  else if (e.tlsFailed || TLS_CODES.test(code)) kind = "tls";
  else if (TIMEOUT_CODES.has(code)) kind = "timeout";
  else if (e.mailboxMissing) kind = "folder_missing";
  else if (CONNECTION_CODES.has(code)) kind = "connection";
  return new InvoiceMailboxError(kind, detail);
}

// "Nav/Inlästa" as the server's path: the levels joined with its delimiter.
function folderSegments(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// The client's options (exported for the tests: the STARTTLS requirement and
// that the password sits only in auth).
export function imapflowOptions(config: InvoiceMailboxConfig): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.tls,
    // TLS off: STARTTLS is REQUIRED (doSTARTTLS: true) — a server that does
    // not offer it (or a man in the middle stripping it) fails the login with
    // tlsFailed instead of sending the password in clear text.
    ...(config.tls ? {} : { doSTARTTLS: true }),
    auth: { user: config.user, pass: config.password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    maxLiteralSize: MAX_LITERAL_BYTES,
    maxResponseSize: MAX_LITERAL_BYTES + 1024 * 1024,
  };
}

async function createClient(config: InvoiceMailboxConfig): Promise<ImapFlow> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow(imapflowOptions(config));
  // An unhandled 'error' event would take the process down; the failing
  // command rejects on its own.
  client.on("error", () => {});
  return client;
}

async function safeLogout(client: ImapFlow) {
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // already gone
    }
  }
}

// The processed folder's path on this server, or null when it is missing.
async function findFolder(client: ImapFlow, path: string): Promise<{ path: string | null; segments: string[] }> {
  const segments = folderSegments(path);
  const list = await client.list();
  const delimiter = list.find((m) => m.delimiter)?.delimiter ?? "/";
  const wanted = segments.join(delimiter);
  const found = list.find((m) => m.path === wanted) ?? list.find((m) => m.path.toLowerCase() === wanted.toLowerCase());
  return { path: found ? found.path : null, segments };
}

export const imapflowMailboxFactory: InvoiceMailboxFactory = (config): InvoiceMailbox => {
  let client: ImapFlow | null = null;
  let lock: MailboxLockObject | null = null;
  let processedPath: string | null = null;

  function open(): ImapFlow {
    if (!client) throw new InvoiceMailboxError("connection", "not connected");
    return client;
  }

  return {
    async connect() {
      try {
        client = await createClient(config);
        await client.connect();
      } catch (err) {
        throw toMailboxError(err, "connection");
      }
      const c = client;
      try {
        lock = await c.getMailboxLock(config.folder);
      } catch (err) {
        const mapped = toMailboxError(err, "folder_missing");
        throw mapped.kind === "unexpected" ? new InvoiceMailboxError("folder_missing", mapped.detail) : mapped;
      }
      try {
        const found = await findFolder(c, config.processedFolder);
        processedPath = found.path ?? (await c.mailboxCreate(found.segments)).path;
      } catch (err) {
        throw toMailboxError(err, "processed_folder");
      }
    },

    async listUnprocessed(limit) {
      const c = open();
      try {
        const found = await c.search({ all: true }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b).slice(0, limit);
        if (uids.length === 0) return [];
        const sizes = new Map<number, number | null>();
        for (const message of await c.fetchAll(uids.join(","), { uid: true, size: true }, { uid: true })) {
          sizes.set(message.uid, typeof message.size === "number" ? message.size : null);
        }
        return uids.map((uid) => ({ uid, size: sizes.get(uid) ?? null }));
      } catch (err) {
        throw toMailboxError(err);
      }
    },

    async fetch(uid) {
      const c = open();
      try {
        const message = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!message || !message.source) throw new InvoiceMailboxError("unexpected", "message gone");
        return message.source;
      } catch (err) {
        throw toMailboxError(err);
      }
    },

    async moveToProcessed(uid) {
      const c = open();
      if (!processedPath) throw new InvoiceMailboxError("processed_folder", "no processed folder");
      let moved: unknown;
      try {
        moved = await c.messageMove(String(uid), processedPath, { uid: true });
      } catch (err) {
        throw toMailboxError(err, "move_failed");
      }
      if (!moved) throw new InvoiceMailboxError("move_failed", "move answered false");
    },

    async close() {
      try {
        lock?.release();
      } catch {
        // the connection is gone
      }
      lock = null;
      if (client) await safeLogout(client);
      client = null;
    },

    async inspect() {
      let c: ImapFlow;
      try {
        c = await createClient(config);
        await c.connect();
      } catch (err) {
        throw toMailboxError(err, "connection");
      }
      try {
        let status: Awaited<ReturnType<ImapFlow["status"]>>;
        try {
          status = await c.status(config.folder, { unseen: true });
        } catch (err) {
          const mapped = toMailboxError(err, "folder_missing");
          throw mapped.kind === "unexpected" ? new InvoiceMailboxError("folder_missing", mapped.detail) : mapped;
        }
        if (!status) throw new InvoiceMailboxError("folder_missing", "status answered false");
        const found = await findFolder(c, config.processedFolder).catch((err) => {
          throw toMailboxError(err);
        });
        return { unseen: status.unseen ?? 0, processedFolderExists: found.path !== null };
      } finally {
        await safeLogout(c);
      }
    },
  };
};
