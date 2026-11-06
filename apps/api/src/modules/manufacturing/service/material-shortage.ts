import { inArray } from "drizzle-orm";
import { articles, units, type Db, type Tx } from "@navet/db";
import { onHandByArticle } from "../../stock/repository/on-hand.js";
import type { ManufacturingMaterialShortage } from "@navet/shared";
import { errorBody } from "../../system/service/error-body.js";

// Materialbrist vid rapportering: the system setting
// manufacturing_material_shortage decides what a report that draws more
// component material than is in stock runs into — nothing ("none"), a
// question the client answers by resubmitting with allowMaterialShortage
// ("warn") or a refusal ("block"). "Available" is the component's USABLE
// stock — every location except a Spärrad lagerplats (onHandByArticle) —
// the same basis as the release-time shortage warning (shortage-warnings.ts).
// Same Db | Tx leaf shape as the stock module's
// count-guard: the repository calls it inside the report's own transaction,
// after the draws are booked, and the throw rolls the whole report back.

export interface MaterialShortage {
  articleId: string;
  articleNumber: string;
  articleName: string;
  // The component's base unit — the quantities are always in it.
  unitCode: string;
  // What THIS report draws of the article (all its material rows together).
  required: number;
  // Usable balance before this report's draws, never below 0 for display.
  available: number;
}

export class MaterialShortageError extends Error {
  constructor(
    readonly shortages: MaterialShortage[],
    // true in mode "warn": resubmitting with allowMaterialShortage: true
    // reports anyway. false in mode "block".
    readonly overridable: boolean
  ) {
    super(materialShortageMessage(shortages));
    this.name = "MaterialShortageError";
  }
}

// The 409 body every drawing route answers with (the TO card's three
// routes, the terminal's stamp-out and the lego receipt): the envelope plus
// the shortages and whether "Rapportera ändå" (allowMaterialShortage: true)
// is accepted.
export function materialShortageBody(err: MaterialShortageError) {
  return { ...errorBody(err), overridable: err.overridable, shortages: err.shortages };
}

// "Det finns inte tillräckligt med ingående delar: Plåt 2 mm (behöver 8 st,
// tillgängligt 3 st)" — the web shows the message as is, so it is Swedish.
export function materialShortageMessage(shortages: MaterialShortage[]): string {
  const parts = shortages.map(
    (s) =>
      `${s.articleName} (behöver ${s.required.toLocaleString("sv-SE")} ${s.unitCode}, tillgängligt ${s.available.toLocaleString("sv-SE")} ${s.unitCode})`
  );
  return `Det finns inte tillräckligt med ingående delar: ${parts.join(", ")}`;
}

// How a report is to be checked: the mode read from the settings outside
// the transaction (like purchaseOverReceiptPercent) and the caller's
// override flag. Decided once, here, so every path answers alike.
export interface MaterialShortageCheck {
  mode: ManufacturingMaterialShortage;
  allow: boolean;
}

// What every repository call runs with when nobody asked for a check — the
// pre-setting behaviour, no extra locks or queries.
export const NO_MATERIAL_SHORTAGE_CHECK: MaterialShortageCheck = { mode: "none", allow: false };

export function materialShortageCheckApplies(check: MaterialShortageCheck): boolean {
  return check.mode === "block" || (check.mode === "warn" && !check.allow);
}

// Throws MaterialShortageError when any drawn component's usable balance is
// below zero now that `lines` are booked in this transaction. Lines of the
// same article are added up; components of type service are never checked
// (services are not stocked). Runs only when the check applies — the
// caller must have booked the draws already.
export async function assertMaterialAvailable(
  tx: Db | Tx,
  lines: { componentArticleId: string; quantity: number }[],
  check: MaterialShortageCheck
): Promise<void> {
  if (!materialShortageCheckApplies(check)) return;

  const required = new Map<string, number>();
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    required.set(line.componentArticleId, (required.get(line.componentArticleId) ?? 0) + line.quantity);
  }
  if (required.size === 0) return;
  const articleIds = [...required.keys()].sort();

  // Two reports drawing the same component from different operations/TOs
  // are not otherwise serialized, so each would read a balance that misses
  // the other's draw and both could pass. Locking the drawn articles first
  // (sorted, so two reports never wait on each other crosswise) makes the
  // second one wait, and its balance read then sees the first one's
  // committed rows. FOR NO KEY UPDATE, not FOR UPDATE: the
  // stock_transactions FK inserts already made above took FOR KEY SHARE on
  // these article rows, which FOR UPDATE conflicts with — two reports that
  // had both inserted would deadlock — while FOR NO KEY UPDATE does not.
  // Known, accepted gap: a draw that EMPTIES a temporary location has
  // already locked every article whose default location it was
  // (deactivateEmptyLocation, a second sorted batch after the draw's own
  // articles) before this point. Two simultaneous reports that each empty a
  // location the OTHER one's component defaults to can then deadlock
  // (Postgres aborts one, 40P01). It needs crosswise default locations and
  // two emptying draws at once; a draw that leaves stock behind takes no
  // such lock.
  const components = await tx
    .select({ id: articles.id, articleNumber: articles.articleNumber, name: articles.name, type: articles.type, unitId: articles.unitId })
    .from(articles)
    .where(inArray(articles.id, articleIds))
    .orderBy(articles.id)
    .for("no key update");

  const stocked = components.filter((c) => c.type !== "service");
  if (stocked.length === 0) return;

  // Read under the article locks, after this report's own draws. A spärr of
  // another place committing meanwhile does not change what the report took
  // (an automatic draw never takes from a blocked place — outflow-locations.ts).
  const onHand = await onHandByArticle(
    tx,
    stocked.map((c) => c.id)
  );
  const balanceAfter = new Map([...onHand].map(([articleId, b]) => [articleId, b.usable]));

  const short = stocked.filter((c) => (balanceAfter.get(c.id) ?? 0) < 0);
  if (short.length === 0) return;

  const unitCodes = new Map(
    (
      await tx
        .select({ id: units.id, code: units.code })
        .from(units)
        .where(
          inArray(
            units.id,
            short.map((c) => c.unitId)
          )
        )
    ).map((u) => [u.id, u.code])
  );

  // Stable order for the message and the body: by article number.
  short.sort((a, b) => a.articleNumber.localeCompare(b.articleNumber, "sv", { numeric: true }));
  throw new MaterialShortageError(
    short.map((c) => {
      const need = required.get(c.id)!;
      const after = balanceAfter.get(c.id) ?? 0;
      return {
        articleId: c.id,
        articleNumber: c.articleNumber,
        articleName: c.name,
        unitCode: unitCodes.get(c.unitId) ?? "",
        required: round4(need),
        available: round4(Math.max(after + need, 0)),
      };
    }),
    check.mode === "warn"
  );
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
