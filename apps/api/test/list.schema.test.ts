import { describe, expect, it } from "vitest";
import { listArticlesQuerySchema, listPurchaseOrdersQuerySchema, listQuerySchema } from "@navet/shared";

// Pure zod tests — no database needed.
describe("list query schemas", () => {
  it("applies defaults and coerces limit/offset from query strings", () => {
    expect(listQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(listQuerySchema.parse({ limit: "10", offset: "20", search: " ab " })).toEqual({
      limit: 10,
      offset: 20,
      search: "ab",
    });
  });

  it("rejects out-of-range limits", () => {
    expect(() => listQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => listQuerySchema.parse({ limit: "1001" })).toThrow();
    expect(() => listQuerySchema.parse({ offset: "-1" })).toThrow();
  });

  it("parses a comma-separated status list against the enum", () => {
    const parsed = listPurchaseOrdersQuerySchema.parse({ status: "draft,confirmed" });
    expect(parsed.status).toEqual(["draft", "confirmed"]);
  });

  it("treats an empty status as no filter and rejects unknown values", () => {
    expect(listPurchaseOrdersQuerySchema.parse({ status: "" }).status).toBeUndefined();
    expect(listPurchaseOrdersQuerySchema.parse({}).status).toBeUndefined();
    expect(() => listPurchaseOrdersQuerySchema.parse({ status: "draft,nope" })).toThrow(/Invalid status: nope/);
  });

  it("validates article type and groupId filters", () => {
    expect(listArticlesQuerySchema.parse({ type: "manufactured" }).type).toBe("manufactured");
    expect(() => listArticlesQuerySchema.parse({ type: "bogus" })).toThrow();
    expect(() => listArticlesQuerySchema.parse({ groupId: "not-a-uuid" })).toThrow();
  });
});
