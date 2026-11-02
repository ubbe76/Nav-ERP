import { describe, expect, it } from "vitest";
import { alreadyOnDocumentText, articleAlreadyOnDocument } from "../../web/lib/orderRowDuplicates";

// Samma artikel flera rader (0177): the add-row forms' notice, derived from
// the rows the form already has.
const rows = [
  { id: "r1", articleId: "a1" },
  { id: "r2", articleId: "a2" },
  { id: "s1", articleId: "a3", setupForRowId: "r2" },
];

describe("alreadyOnDocumentText", () => {
  it("says so when the picked article is already on a row", () => {
    expect(alreadyOnDocumentText(rows, "a1", "ordern")).toBe("Artikeln finns redan på ordern — den läggs till som en egen rad.");
    expect(alreadyOnDocumentText(rows, "a1", "offerten")).toBe("Artikeln finns redan på offerten — den läggs till som en egen rad.");
    expect(alreadyOnDocumentText(rows, "a1", "förfrågan")).toBe("Artikeln finns redan på förfrågan — den läggs till som en egen rad.");
  });

  it("stays silent for a new article, no pick, or a ställkostnadsrad", () => {
    expect(alreadyOnDocumentText(rows, "a9", "ordern")).toBeNull();
    expect(alreadyOnDocumentText(rows, null, "ordern")).toBeNull();
    expect(alreadyOnDocumentText(rows, undefined, "ordern")).toBeNull();
    expect(articleAlreadyOnDocument(rows, "a3")).toBe(false);
    expect(alreadyOnDocumentText([], "a1", "ordern")).toBeNull();
  });

  it("ignores a configured beställningsvara row (other choices, another product)", () => {
    const configured = [{ id: "c1", articleId: "t1", configuration: { selection: {} } }];
    expect(articleAlreadyOnDocument(configured, "t1")).toBe(false);
    expect(articleAlreadyOnDocument([...configured, { id: "c2", articleId: "t1", configuration: null }], "t1")).toBe(true);
  });

  it("leaves out the row being edited", () => {
    expect(articleAlreadyOnDocument(rows, "a1", "r1")).toBe(false);
    expect(articleAlreadyOnDocument([...rows, { id: "r4", articleId: "a1" }], "a1", "r1")).toBe(true);
    // Rows being composed have no ids: the caller passes the other rows.
    expect(articleAlreadyOnDocument([{ articleId: "a1" }], "a1")).toBe(true);
  });
});
