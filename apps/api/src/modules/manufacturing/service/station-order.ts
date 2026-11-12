// Stations in natural number order: purely numeric codes numerically ("90"
// before "100"), other codes after them alphabetically. Pure — the ONE order
// for the terminal's station picker and the körplan's resource picker.
const isNumeric = (code: string) => /^\d+$/.test(code);

export function compareStationCodes(a: { code: string }, b: { code: string }): number {
  if (isNumeric(a.code) && isNumeric(b.code)) return Number(a.code) - Number(b.code);
  if (isNumeric(a.code) !== isNumeric(b.code)) return isNumeric(a.code) ? -1 : 1;
  return a.code.localeCompare(b.code, "sv");
}
