import { describe, expect, it } from "vitest";
import { createInquiryRowSchema, updateInquiryRowSchema } from "@navet/shared";

// Pure zod tests — no database needed. Covers the lego link's mutual-
// exclusion and setupPrice-requires-a-link refinements on the inquiry row
// schemas (see purchase.ts's inquiryRowSchema).

describe("createInquiryRowSchema", () => {
  const base = { articleId: "11111111-1111-1111-1111-111111111111", quantity: 1 };

  it("rejects both moOperationId and routingOperationId at once", () => {
    const result = createInquiryRowSchema.safeParse({
      ...base,
      moOperationId: "22222222-2222-2222-2222-222222222222",
      routingOperationId: "33333333-3333-3333-3333-333333333333",
    });
    expect(result.success).toBe(false);
  });

  it("rejects setupPrice without either lego link", () => {
    const result = createInquiryRowSchema.safeParse({ ...base, setupPrice: 100 });
    expect(result.success).toBe(false);
  });

  it("accepts setupPrice together with routingOperationId", () => {
    const result = createInquiryRowSchema.safeParse({
      ...base,
      routingOperationId: "33333333-3333-3333-3333-333333333333",
      setupPrice: 100,
    });
    expect(result.success).toBe(true);
  });
});

describe("updateInquiryRowSchema", () => {
  it("accepts { setupPrice: null } to clear the ställpris", () => {
    const result = updateInquiryRowSchema.safeParse({ setupPrice: null });
    expect(result.success).toBe(true);
    expect(result.success && result.data.setupPrice).toBeNull();
  });
});
