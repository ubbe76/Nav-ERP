import { eq } from "drizzle-orm";
import { articleGroups, db } from "@navet/db";

// Varugrupp styr momsen (0155): an article's VAT rate is its group's, so a
// test that needs a 12 % article puts it in a group with that rate. One
// group per rate, code 9 + the rate in three digits ("9012"), created on
// first use and reused after (a suite that truncates article_groups just
// gets it created again).
export async function vatRateGroupId(rate: number): Promise<string> {
  const code = `9${String(rate).padStart(3, "0")}`;
  await db
    .insert(articleGroups)
    .values({ code, name: `Moms ${rate} %`, vatRate: String(rate) })
    .onConflictDoNothing();
  const [row] = await db.select({ id: articleGroups.id }).from(articleGroups).where(eq(articleGroups.code, code));
  return row!.id;
}
