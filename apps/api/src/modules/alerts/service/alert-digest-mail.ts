import type { AlertGroup } from "@navet/shared";

// Den dagliga sammanställningen — the mail itself. Pure: takes the groups
// the digest job already filtered for the recipient and gives subject,
// plain-text and HTML parts. Links are absolute (publicBaseUrl + href) and
// left out altogether when Navs adress is not configured; everything that
// comes from the data is HTML-escaped.

// At most this many rows per kind in the mail, then "… och N till" to the
// kind's list page.
export const DIGEST_ROWS_PER_KIND = 20;

// Where the recipient changes what the digest contains.
export const DIGEST_SETTINGS_HREF = "/aviseringar";
export const DIGEST_SETTINGS_TEXT = "Ändra vad du får";
export const DIGEST_NO_LINKS_TEXT = "Öppna Nav för att se detaljerna";

export interface DigestMailInput {
  // The Stockholm day (YYYY-MM-DD) the digest is for.
  date: string;
  // The recipient's groups, in catalog order; error groups included.
  groups: AlertGroup[];
  // "" = no links.
  baseUrl: string;
}

export interface DigestMail {
  subject: string;
  text: string;
  html: string;
}

// "tisdag 21 oktober" — the day in Swedish; the date is a calendar day, so
// it is formatted in UTC to keep the string free of any server time zone.
const DAY_FORMAT = new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export function formatDigestDay(date: string): string {
  return DAY_FORMAT.format(new Date(`${date}T00:00:00Z`));
}

// What counts as "saker": the rows of the groups that could be computed.
// An error group is a line in the mail, not a thing to attend to.
export function digestItemCount(groups: readonly AlertGroup[]): number {
  return groups.reduce((sum, g) => sum + (g.error ? 0 : g.count), 0);
}

export function digestSubject(count: number, date: string): string {
  return `Nav: ${count === 1 ? "1 sak" : `${count} saker`} att bevaka — ${formatDigestDay(date)}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function absolute(baseUrl: string, href: string | null): string | null {
  if (!baseUrl || !href) return null;
  return `${baseUrl}${href}`;
}

function moreText(group: AlertGroup): string | null {
  const more = group.count - Math.min(group.items.length, DIGEST_ROWS_PER_KIND);
  return more > 0 ? `… och ${more} till` : null;
}

export function renderAlertDigestMail(input: DigestMailInput): DigestMail {
  const { date, groups, baseUrl } = input;
  const count = digestItemCount(groups);
  const subject = digestSubject(count, date);
  const settingsUrl = absolute(baseUrl, DIGEST_SETTINGS_HREF);

  // ---- text part ----
  const text: string[] = [subject, ""];
  if (!baseUrl) text.push(DIGEST_NO_LINKS_TEXT, "");
  for (const group of groups) {
    if (group.error) {
      text.push(`${group.label}: ${group.message ?? "kunde inte räknas fram"}`, "");
      continue;
    }
    text.push(`${group.label} (${group.count})`);
    for (const item of group.items.slice(0, DIGEST_ROWS_PER_KIND)) {
      text.push(`- ${item.primary}${item.secondary ? ` — ${item.secondary}` : ""}`);
      const url = absolute(baseUrl, item.href);
      if (url) text.push(`  ${url}`);
    }
    const more = moreText(group);
    if (more) {
      const url = absolute(baseUrl, group.listHref);
      text.push(url ? `${more}: ${url}` : more);
    }
    text.push("");
  }
  text.push(settingsUrl ? `${DIGEST_SETTINGS_TEXT}: ${settingsUrl}` : DIGEST_SETTINGS_TEXT);

  // ---- HTML part ----
  const h: string[] = [];
  h.push(`<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h1>`);
  if (!baseUrl) h.push(`<p style="margin:0 0 16px">${escapeHtml(DIGEST_NO_LINKS_TEXT)}</p>`);
  for (const group of groups) {
    if (group.error) {
      h.push(
        `<p style="margin:0 0 16px"><strong>${escapeHtml(group.label)}:</strong> ${escapeHtml(group.message ?? "kunde inte räknas fram")}</p>`
      );
      continue;
    }
    h.push(`<h2 style="font-size:15px;margin:16px 0 6px">${escapeHtml(group.label)} (${group.count})</h2>`);
    h.push(`<ul style="margin:0;padding-left:20px">`);
    for (const item of group.items.slice(0, DIGEST_ROWS_PER_KIND)) {
      const url = absolute(baseUrl, item.href);
      const primary = url ? `<a href="${escapeHtml(url)}">${escapeHtml(item.primary)}</a>` : escapeHtml(item.primary);
      h.push(`<li>${primary}${item.secondary ? ` — ${escapeHtml(item.secondary)}` : ""}</li>`);
    }
    h.push(`</ul>`);
    const more = moreText(group);
    if (more) {
      const url = absolute(baseUrl, group.listHref);
      h.push(`<p style="margin:6px 0 0">${url ? `<a href="${escapeHtml(url)}">${escapeHtml(more)}</a>` : escapeHtml(more)}</p>`);
    }
  }
  h.push(
    `<p style="margin:24px 0 0;font-size:13px">${settingsUrl ? `<a href="${escapeHtml(settingsUrl)}">${escapeHtml(DIGEST_SETTINGS_TEXT)}</a>` : escapeHtml(DIGEST_SETTINGS_TEXT)}</p>`
  );
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#111">${h.join("")}</body></html>`;

  return { subject, text: text.join("\n"), html };
}
