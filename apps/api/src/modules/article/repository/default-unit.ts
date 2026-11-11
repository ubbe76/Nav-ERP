import { eq, like, or } from "drizzle-orm";
import { units, type Db, type Tx } from "@navet/db";

// The register's "st" unit — the base unit an article gets when none is
// chosen (createArticle, the article and structure imports). Created on first
// use, like the "***" location. A leaf (Db | Tx) so the import module resolves
// it the same way: the ONE implementation.
//
// units.name is unique too. When the code is missing but "Styck" is already
// another code's name (a register entry renamed or imported), the insert's
// conflict guard swallowed the row and the lookup by code found nothing — a
// TypeError, 500. The new "st" then takes the first free name: "Styck",
// "Styck (2)", "Styck (3)" … (the imports' freeName rule).
export const DEFAULT_UNIT_CODE = "st";
const DEFAULT_UNIT_NAME = "Styck";
// A name another transaction took between the read and the insert is tried
// again with the next free one; a few rounds are plenty.
const ATTEMPTS = 5;

async function findByCode(db: Db | Tx): Promise<string | null> {
  const [row] = await db.select({ id: units.id }).from(units).where(eq(units.code, DEFAULT_UNIT_CODE));
  return row?.id ?? null;
}

async function freeName(db: Db | Tx): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ name: units.name })
        .from(units)
        .where(or(eq(units.name, DEFAULT_UNIT_NAME), like(units.name, `${DEFAULT_UNIT_NAME} (%)`)))
    ).map((row) => row.name)
  );
  let name = DEFAULT_UNIT_NAME;
  for (let n = 2; taken.has(name); n++) name = `${DEFAULT_UNIT_NAME} (${n})`;
  return name;
}

export async function getOrCreateDefaultUnitId(db: Db | Tx): Promise<string> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const existing = await findByCode(db);
    if (existing) return existing;
    // ON CONFLICT DO NOTHING without a target covers both unique columns: a
    // concurrent creator of "st" (found on the next round), or a name taken
    // meanwhile (a new free name is chosen on the next round). Never aborts
    // the caller's transaction.
    const [inserted] = await db
      .insert(units)
      .values({ code: DEFAULT_UNIT_CODE, name: await freeName(db) })
      .onConflictDoNothing()
      .returning({ id: units.id });
    if (inserted) return inserted.id;
  }
  throw new Error(`The default unit "${DEFAULT_UNIT_CODE}" could not be created`);
}
