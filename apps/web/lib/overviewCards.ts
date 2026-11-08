// Mirror of OVERVIEW_CARDS in packages/shared/src/user-settings.ts (the web
// cannot import @navet/shared). The setting `overviewCards` (GET/PATCH
// /me/settings): the cards Översikten shows, in order; null = the standard.
export const OVERVIEW_CARDS = ["flow", "attention", "orders", "stock"] as const;
export type OverviewCard = (typeof OVERVIEW_CARDS)[number];

export const OVERVIEW_CARD_LABELS: Record<OverviewCard, string> = {
  flow: "Materialflöde",
  attention: "Att bevaka",
  orders: "Pågående tillverkning",
  stock: "Senaste lagerhändelser",
};

// Flow and stock run the full width; attention and orders are half cards that
// pair up two and two.
export const OVERVIEW_CARD_HALF: Record<OverviewCard, boolean> = {
  flow: false,
  attention: true,
  orders: true,
  stock: false,
};

// Unknown keys are dropped and repeats kept once, like the API's read does.
export function resolveOverviewCards(stored: unknown): OverviewCard[] {
  if (!Array.isArray(stored)) return [...OVERVIEW_CARDS];
  const known: readonly string[] = OVERVIEW_CARDS;
  const out: OverviewCard[] = [];
  for (const key of stored) {
    if (typeof key === "string" && known.includes(key) && !out.includes(key as OverviewCard)) out.push(key as OverviewCard);
  }
  return out;
}

export type OverviewRow = OverviewCard[];

// Two consecutive half cards share a row; a lone half card (a full card on
// either side, or the end) takes the whole row.
export function overviewRows(cards: readonly OverviewCard[]): OverviewRow[] {
  const rows: OverviewRow[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const next = cards[i + 1];
    if (OVERVIEW_CARD_HALF[card] && next !== undefined && OVERVIEW_CARD_HALF[next]) {
      rows.push([card, next]);
      i++;
    } else {
      rows.push([card]);
    }
  }
  return rows;
}
