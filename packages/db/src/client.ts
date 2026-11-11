import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://erp:erp_dev_password@localhost:5432/erp";

// Startup parameters (delatgranskningen 2026-11-11): the date/timestamptz
// parsers assume ISO output, so it is pinned rather than left to the server's
// DateStyle; and a transaction left idle (a bug awaiting something that never
// settles while holding FOR UPDATE or an advisory lock) is ended by the
// server after 10 minutes instead of blocking every writer behind it forever.
// No statement_timeout: reports, imports and the year-end steps run long.
const queryClient = postgres(connectionString, {
  connection: { DateStyle: "ISO, YMD", idle_in_transaction_session_timeout: 600_000 },
});
export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
// A transaction handle (the `tx` param inside `db.transaction(async (tx) => ...)`)
// shares the same query-building surface as Db but isn't structurally
// assignable to it — use this where a function needs to accept either.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
