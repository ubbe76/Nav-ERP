// The lego operation's one-off charge per order: Ställpris + Transportkostnad.
// ONE expression for every reader that prices a lego order — the
// behovsberäkning's lego proposals, the IO row raised for an operation, and
// the pre-/post-calculation — so they can never disagree. Null when neither
// is set ("unpriced"), never 0, like the two columns themselves.
import { sql, type SQL } from "drizzle-orm";
import { moOperations, routingOperations } from "@navet/db";

type LegoPriced = typeof routingOperations | typeof moOperations;

export function legoOneOffSql(table: LegoPriced): SQL<string | null> {
  return sql<string | null>`case when ${table.setupPrice} is null and ${table.transportPrice} is null then null else coalesce(${table.setupPrice}, 0) + coalesce(${table.transportPrice}, 0) end`;
}
