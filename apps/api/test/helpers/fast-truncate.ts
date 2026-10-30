import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Snabbare städning mellan testerna. Thousands of tests reset their tables
// with `TRUNCATE a, b CASCADE` before every case, and a TRUNCATE costs
// 0.1–0.4 s here: each table it reaches (CASCADE pulls in every table with a
// foreign key to a listed one, most of the 170) gets new files and catalog
// rows, however few rows it held. Deleting the rows of the very same tables
// costs a few milliseconds.
//
// installFastTruncate (test/setup.ts) routes db.execute of such a statement
// through resetTables, which keeps TRUNCATE's semantics:
// - the same tables: the listed ones plus, with CASCADE, every table that
//   references one of them, recursively; without CASCADE a listed table that
//   is referenced from outside the list goes to Postgres, which refuses it;
// - no triggers and no FK checks: the DELETEs run under
//   session_replication_role = replica, which skips the bookkeeping and
//   anonymisation guards and the deferred history triggers exactly as
//   TRUNCATE does (every trigger in the schema is ENABLE ORIGIN — none is
//   ALWAYS, none fires on TRUNCATE);
// - sequences untouched, as without RESTART IDENTITY. A statement this does
//   not understand (RESTART IDENTITY, ONLY, quoted or schema-qualified names,
//   an unknown table) runs as the real TRUNCATE.

type Execute = (query: SQLWrapper | string) => Promise<unknown>;

const dialect = new PgDialect();
const TRUNCATE = /^\s*TRUNCATE\s+(?:TABLE\s+)?([\s\S]+?)\s*(?:(RESTART|CONTINUE)\s+IDENTITY\s*)?(CASCADE|RESTRICT)?\s*;?\s*$/i;
const NAME = /^[a-z_][a-z0-9_]*$/;

export function parseTruncate(text: string): { tables: string[]; cascade: boolean } | null {
  const match = TRUNCATE.exec(text);
  if (!match) return null;
  if (match[2]?.toUpperCase() === "RESTART") return null;
  const tables = match[1]!.split(",").map((t) => t.trim().toLowerCase());
  if (tables.some((t) => !NAME.test(t))) return null;
  return { tables, cascade: match[3]?.toUpperCase() === "CASCADE" };
}

// parent → the tables with a foreign key to it.
export type ReferencingTables = Map<string, string[]>;

// The tables a TRUNCATE empties, or null when Postgres has to answer (an
// unknown table, or a referenced table without CASCADE — TRUNCATE refuses).
export function truncatedTables(
  statement: { tables: string[]; cascade: boolean },
  known: Set<string>,
  referencing: ReferencingTables
): string[] | null {
  if (statement.tables.some((t) => !known.has(t))) return null;
  const listed = new Set(statement.tables);
  if (!statement.cascade) {
    const outside = statement.tables.some((t) => (referencing.get(t) ?? []).some((child) => !listed.has(child)));
    return outside ? null : [...listed];
  }
  const all = new Set(listed);
  const queue = [...listed];
  while (queue.length > 0) {
    for (const child of referencing.get(queue.pop()!) ?? []) {
      if (!all.has(child)) {
        all.add(child);
        queue.push(child);
      }
    }
  }
  return [...all];
}

export function installFastTruncate(db: { execute: Execute }): void {
  const execute = db.execute.bind(db) as Execute;
  let schema: Promise<{ known: Set<string>; referencing: ReferencingTables }> | null = null;
  const loadSchema = async () => {
    const tables = (await execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as { tablename: string }[];
    const keys = (await execute(
      sql`select conrelid::regclass::text as child, confrelid::regclass::text as parent from pg_constraint where contype = 'f'`
    )) as { child: string; parent: string }[];
    const referencing: ReferencingTables = new Map();
    for (const { child, parent } of keys) {
      if (child === parent) continue;
      referencing.set(parent, [...(referencing.get(parent) ?? []), child]);
    }
    return { known: new Set(tables.map((t) => t.tablename)), referencing };
  };

  db.execute = async (query: SQLWrapper | string) => {
    const text = typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql;
    const statement = parseTruncate(text);
    if (!statement) return execute(query);
    schema ??= loadSchema();
    const { known, referencing } = await schema;
    const tables = truncatedTables(statement, known, referencing);
    if (!tables) return execute(query);
    const deletes = tables.map((t) => `DELETE FROM "${t}";`).join(" ");
    return execute(sql.raw(`DO $reset$ BEGIN SET LOCAL session_replication_role = replica; ${deletes} END $reset$`));
  };
}
