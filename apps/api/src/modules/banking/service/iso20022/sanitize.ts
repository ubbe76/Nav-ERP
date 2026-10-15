// sanitize.ts — fits free text into the bank's character set (spec §3.2).
import type { BankProfile } from "./bank-profiles.js";

export interface SanitizedText {
  value: string;
  changed: boolean;
  truncated: boolean;
}

const COMBINING_MARKS = /[̀-ͯ]/g;

// Substitutions first (`&` → ` och `), then per character: kept when the
// bank's set allows it (åäö included — NFC up front composes a decomposed
// å), else its base letter without diacritics (é → e), else a space (emoji,
// `<`, line breaks). Spaces collapse, the ends are trimmed, then the text is
// cut to `max`. `changed` compares against the NFC-trimmed input.
export function sanitizeText(value: string, profile: BankProfile, max: number): SanitizedText {
  const original = value.normalize("NFC").trim();
  let text = original;
  for (const [from, to] of Object.entries(profile.charset.substitutions)) text = text.split(from).join(` ${to} `);
  let out = "";
  for (const ch of text) {
    if (profile.charset.allowed.test(ch)) {
      out += ch;
      continue;
    }
    const base = ch.normalize("NFD").replace(COMBINING_MARKS, "");
    out += base !== "" && [...base].every((b) => profile.charset.allowed.test(b)) ? base : " ";
  }
  out = out.replace(/ {2,}/g, " ").trim();
  const truncated = out.length > max;
  if (truncated) out = out.slice(0, max).trimEnd();
  return { value: out, changed: out !== original, truncated };
}
