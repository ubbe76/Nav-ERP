// Error envelope with machine-readable codes (uppföljningssvepet, Package 1).
// The code is DERIVED from the error class name — zero per-class edits across
// the ~230 domain error classes. Additive and backwards compatible: the
// envelope keeps `error` (the English message) and adds `code` only when the
// error is a named domain error; plain Error yields no code and the web falls
// back to the raw message. Stability is guarded by test/error-codes.test.ts,
// which pins the derivation for every code the web dictionary maps — renaming
// a class fails that test instead of silently breaking the Swedish UI text.

// "DuplicateWorkCenterCodeError" -> "duplicate-work-center-code"
export function codeFromName(name: string): string | undefined {
  if (!name || name === "Error") return undefined;
  const stem = name.endsWith("Error") ? name.slice(0, -"Error".length) : name;
  if (!stem) return undefined;
  return stem
    // "MOOperation" -> "MO-Operation" (acronym boundary), "SiePrior" -> "Sie-Prior"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function errorBody(err: Error): { error: string; code?: string } {
  const code = codeFromName(err.name !== "Error" ? err.name : err.constructor.name);
  return code ? { error: err.message, code } : { error: err.message };
}
