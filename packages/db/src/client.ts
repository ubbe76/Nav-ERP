import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://erp:erp_dev_password@localhost:5432/erp";

const queryClient = postgres(connectionString);
export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
// A transaction handle (the `tx` param inside `db.transaction(async (tx) => ...)`)
// shares the same query-building surface as Db but isn't structurally
// assignable to it — use this where a function needs to accept either.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
