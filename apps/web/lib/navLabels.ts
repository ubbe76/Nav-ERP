// Namn under ikonerna (2026-11-25, the user's wish): the main menu's icon
// rail shows each entry's name under its icon, in one of three text sizes.
// Mirror of packages/shared/src/user-settings.ts (NAV_LABEL_SIZES) — the web
// cannot import @navet/shared; web-nav-labels.test.ts keeps them equal. The
// sizes themselves are Nav.module.css's (data-rail-labels on the menu).
export const NAV_LABEL_SIZES = ["off", "small", "normal", "large"] as const;
export type NavLabels = (typeof NAV_LABEL_SIZES)[number];

export const NAV_LABEL_LABELS: Record<NavLabels, string> = {
  off: "Av",
  small: "Liten",
  normal: "Normal",
  large: "Stor",
};

// The stored value, or off for anything else (a failed read, an old value).
export function navLabelsOf(raw: unknown): NavLabels {
  return (NAV_LABEL_SIZES as readonly unknown[]).includes(raw) ? (raw as NavLabels) : "off";
}
