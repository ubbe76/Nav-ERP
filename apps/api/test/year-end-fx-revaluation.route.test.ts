import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { YEAR, buildYearEndApp, buildYearEndService, countVerifications, resetYearEnd } from "./helpers/year-end.js";
import { openEurItems, stubExchangeRates } from "./helpers/year-end-fx.js";

// Valuta steg 4: the valutaomvärdering's HTTP contract — the step in the
// closing's GET, the preview, the booking and its errors.

const { rates, reader } = stubExchangeRates();
const service = buildYearEndService({ exchangeRates: reader });
const CLOSING = `${YEAR}-12-31`;

beforeEach(async () => {
  await resetYearEnd();
  rates.clear();
});
afterAll(resetYearEnd);

describe("valutaomvärdering routes", () => {
  it("serves the step in the closing's GET and the preview with typed rates", async () => {
    const { user, closing } = await openEurItems(service);
    rates.set("EUR", 11.5);
    const app = buildYearEndApp(user.id, { service });

    const detail = await app.inject({ url: `/year-end-closings/${closing.id}` });
    expect(detail.statusCode).toBe(200);
    const step = detail.json().steps.fxRevaluation;
    expect(step).toMatchObject({ status: "not_done", required: true, verification: null, reversalVerification: null, bookedAt: null, bookedRates: null });
    expect(step.preview).toMatchObject({
      asOf: CLOSING,
      rates: [{ currency: "EUR", rate: 11.5, date: CLOSING, source: "riksbank", fromBooking: false }],
      missingCurrencies: [],
      receivable: { accountNumber: "1510", difference: 500 },
      payable: { accountNumber: "2440", difference: 250 },
      resultEffect: 250,
      unchanged: false,
    });
    expect(step.preview.invoices).toBeUndefined();
    expect(detail.json().checks.closeBlockers.map((c: { code: string }) => c.code)).toContain("fx-revaluation-not-done");

    const preview = await app.inject({ url: `/year-end-closings/${closing.id}/fx-revaluation-preview?rates=eur:10.5` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      rates: [{ currency: "EUR", rate: 10.5, date: null, source: "step", fromBooking: false }],
      receivable: { difference: -500 },
      payable: { difference: -250 },
      rows: [
        { accountNumber: "1510", debit: 0, credit: 500 },
        { accountNumber: "2440", debit: 250, credit: 0 },
        { accountNumber: "3960", debit: 0, credit: 250 },
        { accountNumber: "7960", debit: 500, credit: 0 },
      ],
    });
    expect(preview.json().invoices).toHaveLength(2);

    for (const query of ["rates=SEK:1", "rates=EUR", "rates=EUR:-1", "rates=EURO:11", "rates=EUR:11:2"]) {
      const bad = await app.inject({ url: `/year-end-closings/${closing.id}/fx-revaluation-preview?${query}` });
      expect(bad.statusCode, query).toBe(400);
      expect(bad.json().code).toBe("validation-failed");
    }
    await app.close();
  });

  it("409s fx-revaluation-rate-missing with the currencies, books with a typed rate and is unchanged on a re-run", async () => {
    const { user, closing } = await openEurItems(service);
    const app = buildYearEndApp(user.id, { service });

    const missing = await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/fx-revaluation`, payload: {} });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "fx-revaluation-rate-missing", currencies: ["EUR"], date: CLOSING });
    expect(await countVerifications("BS")).toBe(0);

    const booked = await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/fx-revaluation`, payload: { rates: { EUR: 11.5 } } });
    expect(booked.statusCode).toBe(200);
    expect(booked.json()).toMatchObject({
      unchanged: false,
      verification: { displayNumber: `BS-${YEAR}-1`, date: CLOSING },
      reversalVerification: { displayNumber: `BS-${YEAR + 1}-1`, date: `${YEAR + 1}-01-01` },
      cancelled: [],
      nextFiscalYearCreated: true,
      rates: [{ currency: "EUR", rate: 11.5, date: null, source: "step" }],
      revaluation: { receivable: { difference: 500 }, payable: { difference: 250 }, resultEffect: 250 },
    });

    // No body at all: the booked rate is the default.
    const again = await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/fx-revaluation` });
    expect(again.statusCode).toBe(200);
    expect(again.json().unchanged).toBe(true);

    const detail = (await app.inject({ url: `/year-end-closings/${closing.id}` })).json();
    expect(detail.steps.fxRevaluation).toMatchObject({ status: "done", bookedRates: [{ currency: "EUR", rate: 11.5, source: "step" }] });
    expect(detail.history.map((row: { step: string; role: string }) => [row.step, row.role])).toEqual([
      ["fx_revaluation", "booking"],
      ["fx_revaluation", "fx_reversal"],
    ]);
    await app.close();
  });

  it("400s bad rates and malformed ids, 404s an unknown closing", async () => {
    const { user, closing } = await openEurItems(service);
    const app = buildYearEndApp(user.id, { service });
    for (const payload of [{ rates: { SEK: 1 } }, { rates: { EUR: 0 } }, { rates: { EUR: "abc" } }, { rates: { E1: 11 } }]) {
      const res = await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/fx-revaluation`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
    for (const res of [
      await app.inject({ url: "/year-end-closings/not-a-uuid/fx-revaluation-preview" }),
      await app.inject({ method: "POST", url: "/year-end-closings/not-a-uuid/fx-revaluation", payload: {} }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
    for (const res of [
      await app.inject({ url: `/year-end-closings/${crypto.randomUUID()}/fx-revaluation-preview` }),
      await app.inject({ method: "POST", url: `/year-end-closings/${crypto.randomUUID()}/fx-revaluation`, payload: {} }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("year-end-closing-not-found");
    }
    await app.close();
  });

  it("409s year-end-step-order on the result transfer until the revaluation is done", async () => {
    const { user, closing } = await openEurItems(service);
    rates.set("EUR", 11.5);
    const app = buildYearEndApp(user.id, { service });
    await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/inventory`, payload: { method: "standard" } });
    await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/depreciation` });
    await app.inject({ method: "PUT", url: `/year-end-closings/${closing.id}/accruals`, payload: { rows: [] } });
    const refused = await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/result-transfer` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("year-end-step-order");

    expect((await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/fx-revaluation`, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/result-transfer` })).statusCode).toBe(200);
    await app.close();
  });

  it("403s both routes for a profile without Ekonomi and writes nothing", async () => {
    const { user, closing } = await openEurItems(service);
    rates.set("EUR", 11.5);
    const app = buildYearEndApp(user.id, { service, profile: { role: "user", permissions: ["inkop"] } });
    expect((await app.inject({ url: `/year-end-closings/${closing.id}/fx-revaluation-preview` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/year-end-closings/${closing.id}/fx-revaluation`, payload: {} })).statusCode).toBe(403);
    expect(await countVerifications("BS")).toBe(0);
    await app.close();
  });
});
