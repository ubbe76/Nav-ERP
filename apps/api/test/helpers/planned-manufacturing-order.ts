import { db, manufacturingOrders } from "@navet/db";

// A TO still in status planned — what every order looked like before release
// at creation, and what older orders in a database still are. createManufacturingOrder
// releases at once, so tests of Släpp (release snapshots, routing edits that
// must or must not reach the order) and of planned-only behaviour insert the
// row directly instead. The order number only needs to be unique.
export async function insertPlannedManufacturingOrder(input: {
  articleId: string;
  quantity: number;
  createdBy?: string | null;
  dueDate?: string | null;
  salesOrderRowId?: string | null;
  note?: string;
}) {
  const [row] = await db
    .insert(manufacturingOrders)
    .values({
      orderNumber: `TO-P${crypto.randomUUID().slice(0, 8)}`,
      articleId: input.articleId,
      quantity: String(input.quantity),
      note: input.note,
      dueDate: input.dueDate ?? null,
      salesOrderRowId: input.salesOrderRowId ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row!;
}
