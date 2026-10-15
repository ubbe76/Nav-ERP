import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@navet/db";
import { createFinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import { testEconomyRepository } from "./helpers/services.js";
import { YEAR, bookManual, resetYearEnd, setupYearEnd } from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const reports = createFinancialReportsService({ db, repo: testEconomyRepository });

describe("huvudbok — Endast konton med rörelse eller saldo", () => {
  it("keeps an account with an opening balance but no movement, drops one that nets to zero", async () => {
    const { user } = await setupYearEnd();
    // 1460 gets an opening balance in March; 1510 moves and nets to zero before June.
    await bookManual(`${YEAR}-03-01`, [{ account: "1460", debit: 180000 }, { account: "2091", credit: 180000 }], user.id);
    await bookManual(`${YEAR}-04-01`, [{ account: "1510", debit: 500 }, { account: "3001", credit: 500 }], user.id);
    await bookManual(`${YEAR}-05-01`, [{ account: "1930", debit: 500 }, { account: "1510", credit: 500 }], user.id);
    // Movement inside the interval on 1930 only.
    await bookManual(`${YEAR}-06-10`, [{ account: "1930", debit: 100 }, { account: "3001", credit: 100 }], user.id);

    const ledger = await reports.getGeneralLedger({ from: `${YEAR}-06-01`, to: `${YEAR}-06-30`, onlyWithMovement: true });
    const numbers = ledger.accounts.map((account) => account.accountNumber);
    expect(numbers).toContain("1460");
    expect(numbers).toContain("1930");
    expect(numbers).not.toContain("1510");
    expect(ledger.accounts.find((a) => a.accountNumber === "1460")).toMatchObject({ openingBalance: 180000, closingBalance: 180000, rows: [] });
  });
});
