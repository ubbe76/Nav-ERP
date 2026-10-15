import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bankFileRoutes } from "../src/modules/banking/routes/bank-file.routes.js";
import { camtFile } from "./helpers/camt.js";
import {
  buildBankFileService,
  buildRouteApp,
  configureSwedbank,
  fixtureXml,
  multipartFile,
  resetBanking,
  resetBankSettings,
  setupBanking,
  snapshotCompany,
} from "./helpers/banking.js";

const service = buildBankFileService();
let restoreCompany: () => Promise<void>;
let userId: string;
beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  userId = (await setupBanking()).user.id;
  await configureSwedbank();
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
});

const asUser = (permissions: string[]) => buildRouteApp(bankFileRoutes, { service }, { id: userId, role: "user", permissions });

describe("/bank-files", () => {
  // Review Focus 5: one file, uploaded from both pages.
  it("one file whether uploaded from Inköp or Försäljning; both views read it", async () => {
    const xml = fixtureXml("camt054-swedbank-credit.xml");
    const first = await asUser(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("debet.xml", xml) });
    expect(first.statusCode).toBe(201);
    const second = await asUser(["forsaljning"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("kredit.xml", xml) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false, file: { id: first.json().file.id } });
    const id = first.json().file.id;
    expect((await asUser(["forsaljning"]).inject({ method: "GET", url: `/bank-files/${id}/incoming` })).json()).toHaveLength(5);
    expect((await asUser(["inkop"]).inject({ method: "GET", url: `/bank-files/${id}/outgoing` })).json()).toEqual([]);
    const listed = await asUser(["ekonomi"]).inject({ method: "GET", url: "/bank-files?direction=credit" });
    expect(listed.json()).toMatchObject({ total: 1, rows: [{ entries: 5, booked: 0, ignored: 0, unhandled: 5 }] });
    expect((await asUser(["ekonomi"]).inject({ method: "GET", url: "/bank-files?direction=debit" })).json()).toMatchObject({ total: 0, rows: [] });
    expect((await asUser(["ekonomi"]).inject({ method: "GET", url: `/bank-files/${id}` })).json()).toMatchObject({ id, filename: "debet.xml", entryCount: 5 });
  });

  it("booking follows the direction; uploads need inkop or forsaljning", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const body = { entries: [{ entryId: id, customerId: id, rows: [{ invoiceId: id, appliedAmount: 1 }] }] };
    expect((await asUser(["inkop"]).inject({ method: "POST", url: `/bank-files/${id}/incoming/book`, payload: body })).statusCode).toBe(403);
    expect((await asUser(["forsaljning"]).inject({ method: "POST", url: `/bank-files/${id}/outgoing/book`, payload: { entryIds: [id] } })).statusCode).toBe(403);
    expect((await asUser(["inkop"]).inject({ method: "POST", url: `/bank-files/${id}/incoming/entries/${id}/ignore`, payload: { reason: "x" } })).statusCode).toBe(403);
    expect((await asUser(["forsaljning"]).inject({ method: "DELETE", url: `/bank-files/${id}/outgoing/entries/${id}/ignore` })).statusCode).toBe(403);
    expect((await asUser(["lager"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("x.xml", "<x/>") })).statusCode).toBe(403);
    expect((await asUser(["lager"]).inject({ method: "GET", url: "/bank-files" })).statusCode).toBe(403);
    expect((await asUser(["forsaljning"]).inject({ method: "POST", url: `/bank-files/${id}/incoming/book`, payload: body })).statusCode).toBe(404);
    expect((await asUser(["ekonomi"]).inject({ method: "GET", url: `/bank-files/${id}/download` })).statusCode).toBe(404);
    // Malformed ids and bodies are 400.
    expect((await asUser(["ekonomi"]).inject({ method: "GET", url: "/bank-files/not-a-uuid" })).statusCode).toBe(400);
    expect((await asUser(["inkop"]).inject({ method: "POST", url: `/bank-files/${id}/outgoing/book`, payload: { entryIds: [] } })).statusCode).toBe(400);
  });

  it("ignore/restore answer 204 and refuse the other direction with 409", async () => {
    const up = await asUser(["forsaljning"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("k.xml", fixtureXml("camt054-swedbank-credit.xml")) });
    const id = up.json().file.id;
    const entries = (await asUser(["forsaljning"]).inject({ method: "GET", url: `/bank-files/${id}/incoming` })).json() as { id: string }[];
    const url = `/bank-files/${id}/incoming/entries/${entries[4]!.id}/ignore`;
    expect((await asUser(["forsaljning"]).inject({ method: "POST", url, payload: { reason: "Ränta" } })).statusCode).toBe(204);
    const again = await asUser(["forsaljning"]).inject({ method: "POST", url, payload: { reason: "Ränta" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("bank-entry-already-booked");
    expect((await asUser(["forsaljning"]).inject({ method: "DELETE", url })).statusCode).toBe(204);
    const wrong = await asUser(["inkop"]).inject({ method: "POST", url: `/bank-files/${id}/outgoing/entries/${entries[4]!.id}/ignore`, payload: { reason: "x" } });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe("bank-entry-direction");
  });

  it("answers 400 for unreadable and unsupported files, with the download intact", async () => {
    const bad = await asUser(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("x.xml", "<!DOCTYPE x><x/>") });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("bank-file-parse");
    const camt053 = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt/></Document>';
    const unsupported = await asUser(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("s.xml", camt053) });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().code).toBe("unsupported-bank-message");
    const noFile = await asUser(["inkop"]).inject({
      method: "POST",
      url: "/bank-files",
      payload: Buffer.from("------x--\r\n"),
      headers: { "content-type": "multipart/form-data; boundary=----x" },
    });
    expect(noFile.statusCode).toBe(400);
    const ok = await asUser(["inkop"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("d.xml", fixtureXml("camt054-swedbank-debit.xml")) });
    expect(ok.statusCode).toBe(201);
    const download = await asUser(["ekonomi"]).inject({ method: "GET", url: `/bank-files/${ok.json().file.id}/download` });
    expect(download.body).toBe(fixtureXml("camt054-swedbank-debit.xml"));
    expect(download.headers["content-disposition"]).toContain("d.xml");
  });

  // Final review: what the columns would refuse is a 400 parse error, never a 500.
  it.each([
    ["an unreal booking date", { bookingDate: "2024-02-30", amount: 100, ref: "T1" }],
    ["an amount wider than numeric(14,2)", { bookingDate: "2024-10-09", amount: 1_000_000_000_000, ref: "T1" }],
    ["a reference longer than the key column", { bookingDate: "2024-10-09", amount: 100, ref: "R".repeat(200) }],
  ])("answers 400 for %s and stores nothing", async (_label, c) => {
    const xml = camtFile({ messageId: "V-1", entries: [{ direction: "credit", amount: c.amount, bookingDate: c.bookingDate, txs: [{ acctSvcrRef: c.ref, amount: c.amount }] }] });
    const res = await asUser(["forsaljning"]).inject({ method: "POST", url: "/bank-files", ...multipartFile("v.xml", xml) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("bank-file-parse");
    expect((await asUser(["ekonomi"]).inject({ method: "GET", url: "/bank-files?direction=credit" })).json()).toMatchObject({ total: 0 });
  });
});
