import { describe, expect, it } from "vitest";
import { articleCopyPartAllowed, articleCopyParts, articleTypeSchema } from "@navet/shared";
import {
  ARTICLE_COPY_PART_LABELS,
  ARTICLE_COPY_PARTS,
  articleCopyPartAllowed as webAllowed,
} from "../../web/lib/articleCopy";

describe("web article copy mirror", () => {
  it("lists exactly the shared parts, each with a label", () => {
    expect([...ARTICLE_COPY_PARTS]).toEqual([...articleCopyParts]);
    expect(Object.keys(ARTICLE_COPY_PART_LABELS).sort()).toEqual([...articleCopyParts].sort());
  });

  it("applies the same type rules as the server", () => {
    for (const part of articleCopyParts) {
      for (const type of articleTypeSchema.options) {
        expect(webAllowed(part, type), `${part} → ${type}`).toBe(articleCopyPartAllowed(part, type));
      }
    }
    expect(articleCopyPartAllowed("beredning", "manufactured")).toBe(true);
    expect(articleCopyPartAllowed("beredning", "purchased")).toBe(false);
    expect(articleCopyPartAllowed("inkop", "service")).toBe(true);
    expect(articleCopyPartAllowed("inkop", "manufactured")).toBe(false);
    expect(articleCopyPartAllowed("information", "service")).toBe(true);
  });
});
