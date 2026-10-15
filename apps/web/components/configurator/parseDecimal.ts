// Accepts comma or dot; half-typed values ("12,", "-", "") yield null. An empty
// field is left out of the selection (the group's default applies); a non-empty
// unparseable one holds the evaluation back until it parses.
export function parseDecimal(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}
