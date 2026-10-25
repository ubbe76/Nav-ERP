import { sql } from "drizzle-orm";
import { salesOrders } from "@navet/db";
import type { SalesDocumentKind } from "@navet/shared";

// Offerter (0138): the SQL twin of @navet/shared's salesDocumentKind — the
// one place the rule lives on the database side (the sales lists and detail
// read, the projektrapport's order list). Keep the two in step. A leaf so
// other modules can read the kind without the sales repository.
export const documentKindSql = sql<SalesDocumentKind>`(case when ${salesOrders.status} in ('quote', 'lost') or (${salesOrders.status} = 'cancelled' and ${salesOrders.quoteNumber} is not null and ${salesOrders.orderNumber} = ${salesOrders.quoteNumber}) then 'quote' else 'order' end)`;
