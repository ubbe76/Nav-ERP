// Kopia in the send dialog (förfrågan / inköpsorder) and in the e-mail log.
// The server validates again (emailCcSchema in @navet/shared — the web
// cannot import it): at most MAX_EMAIL_CC valid addresses.

export const MAX_EMAIL_CC = 10;

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export type ParsedCc = { ok: true; addresses: string[] } | { ok: false; message: string };

// The ticked contacts' addresses plus the typed ones (comma, semicolon or
// whitespace between them) — without duplicates and without the recipient.
export function parseCcAddresses(ticked: string[], typed: string, to: string): ParsedCc {
  const typedAddresses = typed
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter((a) => a !== "");
  const invalid = typedAddresses.find((a) => !EMAIL_PATTERN.test(a));
  if (invalid) return { ok: false, message: `Ogiltig e-postadress i Kopia: ${invalid}` };
  const seen = new Set([to.trim().toLowerCase()]);
  const addresses: string[] = [];
  for (const address of [...ticked.map((a) => a.trim()), ...typedAddresses]) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  if (addresses.length > MAX_EMAIL_CC) {
    return { ok: false, message: `Högst ${MAX_EMAIL_CC} adresser i Kopia` };
  }
  return { ok: true, addresses };
}

// "a@x (kopia: b@x, c@x)" — the log's Mottagare cell.
export function formatRecipients(recipient: string, cc: string[] | null | undefined): string {
  return cc && cc.length > 0 ? `${recipient} (kopia: ${cc.join(", ")})` : recipient;
}
