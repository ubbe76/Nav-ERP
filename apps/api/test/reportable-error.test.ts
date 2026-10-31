import { describe, expect, it, vi } from "vitest";
import { MissingPostingAccountError } from "../src/modules/economy/service/verification-poster.js";
import { reportableError, UNEXPECTED_ERROR_TEXT } from "../src/modules/banking/service/reportable-error.js";

// A failure reported inside a 2xx answer (bank files, Bekräfta utförd):
// known refusals keep their code so the web can explain them; anything else
// is logged and replaced by the generic text.
describe("reportableError", () => {
  it("passes a missing posting account through with its code", () => {
    const log = vi.fn();
    const body = reportableError(new MissingPostingAccountError("6570", "bank fee"), log, "Bokför bankfilspost x");
    expect(body.code).toBe("missing-posting-account");
    expect(log).not.toHaveBeenCalled();
  });

  it("logs an unexpected error and answers the generic text without a code", () => {
    const log = vi.fn();
    const body = reportableError(new Error("connection reset"), log, "Bokför bankfilspost x");
    expect(body).toEqual({ error: UNEXPECTED_ERROR_TEXT });
    expect(log).toHaveBeenCalledWith("Bokför bankfilspost x failed unexpectedly", { err: expect.any(Error) });
  });
});
