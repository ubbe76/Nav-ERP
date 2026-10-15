import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import type { Readable } from "node:stream";

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

// A complete logical backup of the whole database (schema + rows, including the
// bytea drawings and company logo) as a gzipped plain-SQL dump — the same
// format as scripts/backup-db.sh, restorable with psql. Requires pg_dump in the
// image (see apps/api/Dockerfile) and connects via the DATABASE_URL connection
// string.
export function createDatabaseBackup(databaseUrl: string, now: Date): DatabaseBackup {
  const dump = spawn("pg_dump", [databaseUrl], { stdio: ["ignore", "pipe", "pipe"] });
  const gzip = createGzip();

  let stderr = "";
  dump.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  // If pg_dump can't start or exits non-zero, tear down the gzip stream so the
  // HTTP response errors out instead of shipping a truncated dump silently.
  dump.on("error", (err) => gzip.destroy(err));
  dump.on("close", (code) => {
    if (code !== 0) gzip.destroy(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`));
  });

  dump.stdout.pipe(gzip);
  return { filename: backupFilename(now), stream: gzip };
}
