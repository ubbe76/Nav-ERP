// A new TO is released at creation, and the create response carries the
// shortage warnings Släpp used to show. The forms navigate to the TO card
// right after, so the warnings are handed over through sessionStorage and
// read once by the card. Storage can be missing or blocked — then the
// warnings are simply not shown (they never stop anything).
const key = (orderId: string) => `nav-release-warnings:${orderId}`;

export function stashReleaseWarnings(orderId: string, warnings: string[] | undefined) {
  if (!warnings || warnings.length === 0) return;
  try {
    sessionStorage.setItem(key(orderId), JSON.stringify(warnings));
  } catch {
    // ignore — see above
  }
}

export function takeReleaseWarnings(orderId: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(key(orderId));
    if (raw === null) return null;
    sessionStorage.removeItem(key(orderId));
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : null;
  } catch {
    return null;
  }
}
