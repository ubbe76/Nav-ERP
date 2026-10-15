// "Kopiera från befintlig artikel" — the parts the new-article form can copy
// from a source article, with the type rules. Mirror of articleCopyParts /
// articleCopyPartAllowed in packages/shared/src/article.ts (the web can't
// import @navet/shared, see lib/units.ts); apps/api/test/article-copy.shared.test.ts
// keeps the two in sync. The server enforces the same rules (400).
import type { ArticleType } from "./types";

export type ArticleCopyPart = "information" | "beredning" | "inkop" | "filer";

export const ARTICLE_COPY_PARTS: readonly ArticleCopyPart[] = ["information", "beredning", "inkop", "filer"];

export const ARTICLE_COPY_PART_LABELS: Record<ArticleCopyPart, string> = {
  information: "Information",
  beredning: "Beredning",
  inkop: "Inköp",
  filer: "Ritningar och filer",
};

const PART_TYPES: Partial<Record<ArticleCopyPart, readonly ArticleType[]>> = {
  beredning: ["manufactured"],
  inkop: ["purchased", "service"],
};

export function articleCopyPartAllowed(part: ArticleCopyPart, type: ArticleType): boolean {
  const allowed = PART_TYPES[part];
  return allowed === undefined || allowed.includes(type);
}

// Why a part can't be copied to the new article's type — shown beside the
// disabled checkbox and under the field when a type change drops the part.
export const ARTICLE_COPY_PART_REASONS: Partial<Record<ArticleCopyPart, string>> = {
  beredning: "Beredning kopieras bara till tillverkade artiklar",
  inkop: "Inköp kopieras bara till köpta artiklar och tjänster",
};
