// Fakturaskanning — avsändarregeln for automatic AI on e-mail (spec §3.4):
// a scan that came by e-mail is sent to the AI service on its own only when
// the sender is known AND the From domain is authenticated by the receiving
// mail server — so advertising, spam and a forged From to the mailbox never
// cost money. Everything else waits for Tolka med AI. Pure; the e-mail job
// hands the letter's authenticated domains to the inbox service's
// automaticAi().
//
// - A supplier's (or its contacts') domain counts only when the topmost
//   Authentication-Results header — the one the receiving server added —
//   shows dmarc=pass (header.from) or dkim=pass (header.d / header.i) for
//   exactly the From domain.
// - The company's own users count only on their exact address, with the
//   same authentication.
// - No Authentication-Results header ⇒ no automatic AI (the button stays).

// Shared mail providers: a domain match there says nothing about who sent
// the mail, so only the exact address counts.
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.se",
  "outlook.com",
  "outlook.se",
  "live.com",
  "live.se",
  "msn.com",
  "yahoo.com",
  "yahoo.se",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "telia.com",
  "spray.se",
  "bredband.net",
  "bahnhof.se",
  "comhem.se",
]);

// The address in "Name <a@b.se>" or a bare "a@b.se", lower case; null when
// there is none.
export function emailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  const candidate = angled ? angled[1]! : raw.trim();
  const m = /^[^\s@<>"]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(candidate);
  return m ? candidate.toLowerCase() : null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

// The topmost Authentication-Results header (RFC 8601), unfolded, without
// the "Authentication-Results:" name. Comments in parentheses are dropped
// before it is read. Returns the domains that passed DMARC (header.from) or
// DKIM (header.d, or the domain of header.i), lower case. Any other result
// (fail, none, neutral, temperror …) gives nothing.
export function authenticatedDomains(header: string | null | undefined): string[] {
  if (!header) return [];
  let text = header.replace(/\r?\n[ \t]+/g, " ").replace(/^\s*authentication-results\s*:/i, "");
  // Comments, innermost first (they may nest once or twice in practice).
  for (let i = 0; i < 5 && /\([^()]*\)/.test(text); i++) text = text.replace(/\([^()]*\)/g, " ");
  const domains = new Set<string>();
  for (const part of text.split(";")) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*([a-z]+)\b(.*)$/is.exec(part);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    if (m[2]!.toLowerCase() !== "pass") continue;
    const props = new Map<string, string>();
    for (const p of m[3]!.matchAll(/([a-z]+\.[a-z-]+)\s*=\s*"?([^\s";]+)"?/gi)) props.set(p[1]!.toLowerCase(), p[2]!.toLowerCase());
    const domain = (value: string | undefined) => {
      if (!value) return null;
      const d = value.slice(value.lastIndexOf("@") + 1).replace(/\.$/, "");
      return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d) ? d : null;
    };
    const found =
      method === "dmarc" ? [domain(props.get("header.from"))] : method === "dkim" ? [domain(props.get("header.d")), domain(props.get("header.i"))] : [];
    for (const d of found) if (d) domains.add(d);
  }
  return [...domains];
}

export interface KnownSenders {
  // Active suppliers' and their contacts' addresses: the domain counts.
  suppliers: (string | null | undefined)[];
  // The company's active users: only the exact address counts.
  users: (string | null | undefined)[];
}

// True when the sender may trigger automatic AI: the From domain is
// authenticated (authenticatedDomains of the letter) and the sender is
// known — a supplier's domain (exact address on a public mail provider) or
// a user's exact address.
export function senderAllowsAutomaticAi(sender: string | null | undefined, known: KnownSenders, authenticated: string[]): boolean {
  const from = emailAddress(sender);
  if (from === null) return false;
  const fromDomain = domainOf(from);
  if (!authenticated.map((d) => d.toLowerCase()).includes(fromDomain)) return false;
  for (const raw of known.users) {
    if (emailAddress(raw) === from) return true;
  }
  for (const raw of known.suppliers) {
    const address = emailAddress(raw);
    if (address === null) continue;
    if (PUBLIC_MAIL_DOMAINS.has(domainOf(address)) || PUBLIC_MAIL_DOMAINS.has(fromDomain)) {
      if (address === from) return true;
    } else if (domainOf(address) === fromDomain) {
      return true;
    }
  }
  return false;
}
