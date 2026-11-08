import { canOpen } from "./pageAccess";
import type { Permission } from "./permissions";

// Mirror of OVERVIEW_CARDS/DEFAULT_OVERVIEW_CARDS in
// packages/shared/src/user-settings.ts (the web cannot import @navet/shared;
// overview-cards-mirror.test.ts keeps them equal). The setting
// `overviewCards` (GET/PATCH /me/settings): the cards Översikten shows, in
// order; null = the standard.
export const OVERVIEW_CARDS = [
  "flow",
  "attention",
  "orders",
  "stock",
  "favorites",
  "deliveries",
  "arrivals",
  "capacity",
  "receivables",
  "payables",
  "quotes",
  "deviations",
] as const;
export type OverviewCard = (typeof OVERVIEW_CARDS)[number];
// The standard (overviewCards null): the four cards Översikten has always
// had — a card added later never appears for someone who did not pick it.
export const DEFAULT_OVERVIEW_CARDS: readonly OverviewCard[] = ["flow", "attention", "orders", "stock"];

export const OVERVIEW_CARD_LABELS: Record<OverviewCard, string> = {
  flow: "Materialflöde",
  attention: "Att bevaka",
  orders: "Pågående tillverkning",
  stock: "Senaste lagerhändelser",
  favorites: "Favoriter",
  deliveries: "Leveranser denna vecka",
  arrivals: "Inleveranser denna vecka",
  capacity: "Beläggning denna vecka",
  receivables: "Förfallna kundfakturor",
  payables: "Leverantörsfakturor att betala",
  quotes: "Offerter att följa upp",
  deviations: "Öppna avvikelser",
};

// Flow and stock run the full width; the rest are half cards that pair up
// two and two.
export const OVERVIEW_CARD_HALF: Record<OverviewCard, boolean> = {
  flow: false,
  attention: true,
  orders: true,
  stock: false,
  favorites: false,
  deliveries: true,
  arrivals: true,
  capacity: true,
  receivables: true,
  payables: true,
  quotes: true,
  deviations: true,
};

// The page a newer card's Se alla opens — and its gate: the card is offered
// (and shown) only to a user who may open that page, the same rule as the
// GatedLink, so a card never shows data its list would refuse. The four
// original cards are not gated (they read office data and link with
// GatedLink row by row, as before).
export const OVERVIEW_CARD_HREF: Partial<Record<OverviewCard, string>> = {
  deliveries: "/forsaljning/ordrar",
  arrivals: "/inkop/ordrar",
  capacity: "/tillverkning/belaggning",
  receivables: "/forsaljning/reskontra",
  payables: "/inkop/reskontra",
  quotes: "/forsaljning/offerter",
  deviations: "/kvalitet/avvikelser",
};

type CardUser = { role: "admin" | "supervisor" | "user"; permissions?: readonly Permission[] };

export function overviewCardAvailable(user: CardUser, card: OverviewCard): boolean {
  const href = OVERVIEW_CARD_HREF[card];
  return href === undefined || canOpen(user, href);
}

// The alert kind a single-kind card shows (GET /alerts?kinds=).
export const OVERVIEW_CARD_ALERT_KIND = {
  receivables: "customer_invoice_overdue",
  payables: "supplier_invoice_due",
  quotes: "quote_followup",
} as const satisfies Partial<Record<OverviewCard, string>>;

// Unknown keys are dropped and repeats kept once, like the API's read does;
// anything else than a list (null) is the standard.
export function resolveOverviewCards(stored: unknown): OverviewCard[] {
  if (!Array.isArray(stored)) return [...DEFAULT_OVERVIEW_CARDS];
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
