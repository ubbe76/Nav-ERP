import { describe, expect, it } from "vitest";
import { withFieldErrors } from "../src/modules/einvoice/service/einvoice.service.js";

// The failed row's text must not repeat what the adapter already folded into
// the message (seen live: B2Brouter's import refusal printed twice).
describe("withFieldErrors", () => {
  it("does not repeat a field error the message already contains", () => {
    const text = "Companies X of the invoice do not belong to your companies";
    expect(withFieldErrors(`B2Brouter avvisade dokumentet: ${text}`, [text])).toBe(`B2Brouter avvisade dokumentet: ${text}`);
  });

  it("appends field errors that are new", () => {
    expect(withFieldErrors("B2Brouter avvisade dokumentet", ["IssueDate saknas", "BT-10 saknas"])).toBe("B2Brouter avvisade dokumentet — IssueDate saknas; BT-10 saknas");
  });

  it("keeps the message alone without field errors", () => {
    expect(withFieldErrors("Fel", [])).toBe("Fel");
  });
});
