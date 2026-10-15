import { describe, expect, it } from "vitest";
import { applyPaymentTolerance } from "@navet/shared";
// The web mirror has no imports, so vitest can load it directly — this is
// what keeps the two copies from drifting (the web can't import @navet/shared).
import * as web from "../../web/lib/paymentTolerance.js";

// [open, applied, tolerance, expected]
const CASES: [number, number, number, ReturnType<typeof applyPaymentTolerance>][] = [
  [1000, 1000, 1, { ok: true, writeOffAmount: 0, settles: true, rest: 0, kind: "closes" }],
  [1000, 999.4, 1, { ok: true, writeOffAmount: 0.6, settles: true, rest: 0, kind: "closes_with_writeoff" }],
  [1000, 1000.8, 1, { ok: true, writeOffAmount: -0.8, settles: true, rest: 0, kind: "closes_with_writeoff" }],
  [1000, 1001, 1, { ok: true, writeOffAmount: -1, settles: true, rest: 0, kind: "closes_with_writeoff" }],
  [1000, 1001.01, 1, { ok: false, reason: "exceeds_open" }],
  [1000, 600, 1, { ok: true, writeOffAmount: 0, settles: false, rest: 400, kind: "partial" }],
  [10000, 9930, 1, { ok: true, writeOffAmount: 0, settles: false, rest: 70, kind: "partial" }],
  [-250, -250, 1, { ok: true, writeOffAmount: 0, settles: true, rest: 0, kind: "closes" }],
  [-250, -249.5, 1, { ok: true, writeOffAmount: -0.5, settles: true, rest: 0, kind: "closes_with_writeoff" }],
  [-250, 250, 1, { ok: false, reason: "sign_mismatch" }],
  [1000, -10, 1, { ok: false, reason: "sign_mismatch" }],
  [1000, 0, 1, { ok: false, reason: "zero" }],
  [0, 100, 1, { ok: false, reason: "not_open" }],
  [1000, 999.995, 0, { ok: true, writeOffAmount: 0, settles: true, rest: 0, kind: "closes" }],
  [100, 99, 0, { ok: true, writeOffAmount: 0, settles: false, rest: 1, kind: "partial" }],
];

describe("applyPaymentTolerance", () => {
  it.each(CASES)("open %s, applied %s, tolerance %s", (open, applied, tolerance, expected) => {
    expect(applyPaymentTolerance(open, applied, tolerance)).toEqual(expected);
  });

  it("web mirror is identical", () => {
    for (const [open, applied, tolerance] of CASES) {
      expect(web.applyPaymentTolerance(open, applied, tolerance)).toEqual(applyPaymentTolerance(open, applied, tolerance));
    }
  });
});

describe("paymentPreview (web)", () => {
  it("keeps the registration forms' texts", () => {
    expect(web.paymentPreview(1000, "", 1)).toEqual({ text: "Ange ett belopp", tone: "neutral" });
    expect(web.paymentPreview(1000, "0", 1)).toEqual({ text: "Ange ett belopp skilt från 0", tone: "neutral" });
    expect(web.paymentPreview(1000, "abc", 1)).toEqual({ text: "Ange ett belopp skilt från 0", tone: "neutral" });
    expect(web.paymentPreview(1000, "1000", 1)).toEqual({ text: "Stänger posten", tone: "success" });
    expect(web.paymentPreview(1000, "999.4", 1)).toEqual({
      text: "Stänger posten · avskrivning 0,60 kr",
      tone: "success",
    });
    expect(web.paymentPreview(10000, "9930", 1)).toEqual({ text: "Delbetalning · rest 70,00 kr", tone: "neutral" });
    expect(web.paymentPreview(1000, "1500", 1)).toEqual({ text: "Beloppet överstiger öppet belopp", tone: "error" });
    expect(web.paymentPreview(-250, "250", 1)).toEqual({ text: "Beloppet måste ha samma tecken som öppet belopp", tone: "error" });
  });
});
