// Fakturaskanning — avsändarregeln for automatic AI on e-mail (spec §3.4):
// a scan that came by e-mail is sent to the AI service on its own only when
// the sender's domain is the domain of an active supplier's e-mail, one of
// its contacts' e-mail or one of the company's own users — so advertising
// and spam to the mailbox never cost money. Everything else waits for Tolka
// med AI. Pure; the e-mail job (step 3) reaches it through the inbox
// service's automaticAi().

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

// True when the sender may trigger automatic AI: its domain is the domain of
// one of the known addresses (exact address for public mail providers).
export function senderAllowsAutomaticAi(sender: string | null | undefined, knownAddresses: (string | null | undefined)[]): boolean {
  const from = emailAddress(sender);
  if (from === null) return false;
  const fromDomain = domainOf(from);
  for (const raw of knownAddresses) {
    const known = emailAddress(raw);
    if (known === null) continue;
    if (PUBLIC_MAIL_DOMAINS.has(domainOf(known)) || PUBLIC_MAIL_DOMAINS.has(fromDomain)) {
      if (known === from) return true;
    } else if (domainOf(known) === fromDomain) {
      return true;
    }
  }
  return false;
}
