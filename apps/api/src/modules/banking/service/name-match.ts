// Name likeness for amount+name suggestions (spec §5.1). Bank files often
// carry the payer's name upper-cased and without åäö ("BYGG O KAKEL ALVBY").
const STOPWORDS = new Set(["ab", "aktiebolag", "hb", "kb", "i", "och", "o", "the", "publ"]);

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token !== "" && !STOPWORDS.has(token));
}

export function namesMatch(a: string, b: string): boolean {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (left.size === 0 || right.size === 0) return false;
  const common = [...left].filter((token) => right.has(token));
  if (!common.some((token) => token.length >= 3)) return false;
  return common.length / Math.min(left.size, right.size) >= 0.6;
}
