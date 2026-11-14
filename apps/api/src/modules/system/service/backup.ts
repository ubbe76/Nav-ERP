import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createGzip } from "node:zlib";
import { pipeline, Transform, type Readable } from "node:stream";

// Timestamped, sortable name, e.g. erp-2026-07-24_0905.sql.gz. UTC-based so it
// is deterministic (and matches the nightly cron script's naming style).
export function backupFilename(now: Date): string {
  const iso = now.toISOString(); // 2026-07-24T09:05:12.345Z
  const date = iso.slice(0, 10); // 2026-07-24
  const time = iso.slice(11, 16).replace(":", ""); // 0905
  return `erp-${date}_${time}.sql.gz`;
}

export interface DatabaseBackup {
  filename: string;
  stream: Readable;
}

// pg_dump as a child process with stdout and stderr piped. Injectable so the
// teardown below can be tested without pg_dump in the test environment.
export type DumpProcess = ChildProcessByStdio<null, Readable, Readable>;
export type SpawnDump = (databaseUrl: string) => DumpProcess;

const spawnPgDump: SpawnDump = (databaseUrl) => spawn("pg_dump", [databaseUrl], { stdio: ["ignore", "pipe", "pipe"] });

// A complete logical backup of the whole database (schema + rows, including the
// bytea drawings and company logo) as a gzipped plain-SQL dump — the same
// format as scripts/backup-db.sh, restorable with psql. Requires pg_dump in the
// image (see apps/api/Dockerfile) and connects via the DATABASE_URL connection
// string.
export function createDatabaseBackup(databaseUrl: string, now: Date, spawnDump: SpawnDump = spawnPgDump): DatabaseBackup {
  const dump = spawnDump(databaseUrl);
  const gzip = createGzip();

  let stderr = "";
  dump.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  // If pg_dump can't start or exits non-zero, the HTTP response errors out
  // instead of shipping a truncated dump silently. pg_dump can close its
  // stdout before it exits with an error, so the end of stdout alone is not
  // a finished dump: the gate below holds gzip's end until the process has
  // exited 0 — otherwise the download completed (gzip ended) and the later
  // exit code arrived too late to fail it.
  const exited = new Promise<Error | null>((resolve) => {
    dump.on("error", (err) => resolve(err));
    dump.on("close", (code, signal) =>
      resolve(code === 0 ? null : new Error(`pg_dump exited with ${signal ?? `code ${code}`}: ${stderr.trim()}`))
    );
  });
  dump.on("error", (err) => gzip.destroy(err));
  const gate = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      void exited.then((err) => callback(err ?? undefined));
    },
  });

  // An aborted download: Fastify destroys gzip when the client goes away.
  // pipe() only unpiped pg_dump's stdout then, and pg_dump stayed blocked on
  // write() — with its transaction, its locks and a connection — until the
  // api restarted. pipeline destroys stdout (the pipe's read end) with gzip,
  // and a pg_dump still running when the stream closed before the whole dump
  // was read is ended explicitly (SIGPIPE would need one more write).
  pipeline(dump.stdout, gate, gzip, () => {
    // The error (an abort, pg_dump's exit) reaches the response through gzip.
  });
  gzip.on("close", () => {
    if (!gzip.readableEnded && dump.exitCode === null && dump.signalCode === null) dump.kill("SIGTERM");
  });

  return { filename: backupFilename(now), stream: gzip };
}
