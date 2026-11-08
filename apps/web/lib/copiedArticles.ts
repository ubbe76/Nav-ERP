import { apiFetch } from "./api";
import { chooseDialog } from "./confirm";
import type { CopiedArticles, CopyArticlesResult, CopyArticlesSource } from "./types";

// "N artiklar i Kopierat." — the notice every copy action shows.
export function copiedNotice(count: number): string {
  return count === 1 ? "1 artikel i Kopierat." : `${count.toLocaleString("sv-SE")} artiklar i Kopierat.`;
}

export async function fetchCopiedCount(): Promise<number> {
  return (await apiFetch<CopiedArticles>("/api/v1/articles/copied")).count;
}

// Copies articles into the user's Kopierat list (#28). A list that already
// has content asks first: Lägg till (append what is new), Ersätt (start
// over) or Avbryt. Resolves { count, added }, or null when cancelled. API
// errors (e.g. copied-articles-too-many) are thrown for the caller to show.
export async function copyArticles(source: CopyArticlesSource): Promise<CopyArticlesResult | null> {
  const existing = await fetchCopiedCount();
  let mode: "add" | "replace" = "add";
  if (existing > 0) {
    const noun = existing === 1 ? "artikel" : "artiklar";
    const chosen = await chooseDialog<"add" | "replace">(`Kopierat innehåller ${existing.toLocaleString("sv-SE")} ${noun}.`, {
      choices: [
        { label: "Lägg till", value: "add", variant: "primary" },
        { label: "Ersätt", value: "replace", variant: "secondary" },
      ],
    });
    if (chosen === null) return null;
    mode = chosen;
  }
  return apiFetch<CopyArticlesResult>("/api/v1/articles/copied", {
    method: "POST",
    body: JSON.stringify({ mode, ...source }),
  });
}
