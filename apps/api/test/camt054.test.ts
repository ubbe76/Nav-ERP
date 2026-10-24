import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BankFileParseError, UnsupportedBankMessageError } from "../src/modules/banking/service/banking.errors.js";
import { parseCamt054 } from "../src/modules/banking/service/iso20022/camt054-parser.js";
import { parseXml } from "../src/modules/banking/service/iso20022/xml-reader.js";
import { camtFile } from "./helpers/camt.js";
import { validateAgainstXsd } from "./helpers/xsd.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/iso20022/${name}`, import.meta.url), "utf8");
const FIXTURES = [
  "camt054-swedbank-credit.xml",
  "camt054-swedbank-debit.xml",
  "camt054-swedbank-return.xml",
  "camt054-handelsbanken-credit.xml",
  "camt054-handelsbanken-debit.xml",
  "camt054-nordea-credit.xml",
  "camt054-nordea-debit.xml",
  // Valuta steg 2: payments abroad debited to the SEK account (own, made up).
  "camt054-swedbank-debit-fx.xml",
  "camt054-seb-debit-fx.xml",
  "camt054-handelsbanken-debit-fx.xml",
  "camt054-nordea-debit-fx.xml",
];

describe("fixturerna", () => {
  it.each(FIXTURES)("%s is valid against the official XSD", async (name) => {
    expect(await validateAgainstXsd(fixture(name), "camt.054.001.02")).toEqual([]);
  });

  it("the test builder's entry without TxDtls is valid too", async () => {
    const xml = camtFile({ messageId: "T-3", entries: [{ direction: "credit", amount: 450, bookingDate: "2024-10-09", acctSvcrRef: "E9", txs: [] }] });
    expect(await validateAgainstXsd(xml, "camt.054.001.02")).toEqual([]);
  });

  it("the test builder's output is valid too", async () => {
    const xml = camtFile({
      messageId: "T-1",
      entries: [
        { direction: "credit", amount: 100, bookingDate: "2024-10-09", acctSvcrRef: "E1", txs: [{ acctSvcrRef: "T1", amount: 100, counterparty: "X", refs: [{ type: "SCOR", value: "501262", amount: 100 }] }] },
        { direction: "credit", reversal: true, amount: 50, bookingDate: "2024-10-09", txs: [{ endToEndId: "BO-1-1", msgId: "BO-1", amount: 50, returnReason: "AC01" }] },
      ],
    });
    expect(await validateAgainstXsd(xml, "camt.054.001.02")).toEqual([]);
  });
});

describe("Swedbank (primär profil)", () => {
  it("reads the worked example's credit entries, OCR from CINV/Nb", () => {
    const parsed = parseCamt054(fixture("camt054-swedbank-credit.xml"));
    expect(parsed.messageId).toBe("SWEDSESSCRED20241009000001");
    expect(parsed.entries).toHaveLength(5);
    expect(parsed.warnings).toEqual(["Post med status PDNG hoppades över (bara bokförda poster läses)"]);
    expect(parsed.entries[0]).toEqual({
      account: "821491234567890",
      direction: "credit",
      reversal: false,
      amount: 10000,
      currency: "SEK",
      bookingDate: "2024-10-09",
      valueDate: null,
      endToEndId: null,
      msgId: null,
      pmtInfId: null,
      counterpartyName: "AB FONSTERBOLAGET",
      remittance: [{ type: "CINV", value: "501262", amount: 10000 }],
      returnReason: null,
      dedupeKey: "821491234567890|tx:202410098402000100000001",
      dedupeSource: "tx_acct_svcr_ref",
      position: 0,
      instructedAmount: null,
      instructedCurrency: null,
      currencyExchange: null,
      chargesAmount: null,
    });
    expect(parsed.entries[2]!.remittance).toEqual([{ type: "USTRD", value: "Faktura september", amount: null }]);
    expect(parsed.entries[3]!.remittance).toEqual([
      { type: "CINV", value: "503060", amount: 7000 },
      { type: "CREN", value: "503169", amount: 500 },
    ]);
  });

  it("falls back to a content hash when the bank gives no reference — stable across re-reads", () => {
    const first = parseCamt054(fixture("camt054-swedbank-credit.xml")).entries[4]!;
    const again = parseCamt054(fixture("camt054-swedbank-credit.xml")).entries[4]!;
    expect(first.dedupeSource).toBe("content_hash");
    expect(first.dedupeKey).toMatch(/^821491234567890\|hash:[0-9a-f]{64}#1$/);
    expect(again.dedupeKey).toBe(first.dedupeKey);
  });

  it("numbers identical reference-less payments in one file #1, #2", () => {
    const tx = { amount: 100, counterparty: "Samma AB", ustrd: "Hej" };
    const parsed = parseCamt054(
      camtFile({ messageId: "T-2", entries: [{ direction: "credit", amount: 200, bookingDate: "2024-10-09", txs: [tx, tx] }] })
    );
    expect(parsed.entries.map((e) => e.dedupeKey.slice(-2))).toEqual(["#1", "#2"]);
    expect(new Set(parsed.entries.map((e) => e.dedupeKey)).size).toBe(2);
  });

  it("reads our EndToEndIds from the debit notification", () => {
    const parsed = parseCamt054(fixture("camt054-swedbank-debit.xml"));
    expect(parsed.entries.map((e) => [e.direction, e.endToEndId, e.amount, e.msgId, e.pmtInfId, e.bookingDate])).toEqual([
      ["debit", "BO-7-1", 12500, "BO-7", "BO-7-20241015", "2024-10-15"],
      ["debit", "BO-7-3", 8850, "BO-7", "BO-7-20241015", "2024-10-15"],
    ]);
    expect(parsed.entries[0]!.counterpartyName).toBe("Plåtlagret AB");
    expect(parsed.entries[0]!.remittance).toEqual([{ type: "SCOR", value: "4605127", amount: null }]);
  });

  it("an entry without TxDtls becomes one entry with the Ntry amount, keyed on the Ntry reference", () => {
    const parsed = parseCamt054(
      camtFile({ messageId: "T-3", entries: [{ direction: "credit", amount: 450, bookingDate: "2024-10-09", acctSvcrRef: "E9", txs: [] }] })
    );
    expect(parsed.entries).toEqual([
      expect.objectContaining({ amount: 450, remittance: [], counterpartyName: null, dedupeKey: "5512348|ntry:E9#0", dedupeSource: "entry_ref", position: 0 }),
    ]);
  });

  it("reads a return: credit, reversal, original EndToEndId and reason", () => {
    const [entry] = parseCamt054(fixture("camt054-swedbank-return.xml")).entries;
    expect(entry).toMatchObject({ direction: "credit", reversal: true, endToEndId: "BO-7-3", returnReason: "AC01", amount: 8850, bookingDate: "2024-10-17" });
    // xs:boolean also allows "1".
    const numeric = fixture("camt054-swedbank-return.xml").replace("<RvslInd>true</RvslInd>", "<RvslInd>1</RvslInd>");
    expect(parseCamt054(numeric).entries[0]!.reversal).toBe(true);
  });

  it("reads the return's counterparty from Cdtr — the original was our payment out", () => {
    const [entry] = parseCamt054(fixture("camt054-swedbank-return.xml")).entries;
    expect(entry!.counterpartyName).toBe("Exempelhydraulik AB");
  });

  it("falls back to the other party when the expected one is missing", () => {
    const swapped = fixture("camt054-swedbank-credit.xml").replace("<Dbtr><Nm>AB FONSTERBOLAGET</Nm></Dbtr>", "<Cdtr><Nm>AB FONSTERBOLAGET</Nm></Cdtr>");
    expect(parseCamt054(swapped).entries[0]!.counterpartyName).toBe("AB FONSTERBOLAGET");
  });

  it("skips negative and zero amounts with a warning", () => {
    const parsed = parseCamt054(
      camtFile({
        messageId: "T-4",
        entries: [
          { direction: "credit", amount: 0, bookingDate: "2024-10-09", acctSvcrRef: "E1", txs: [{ amount: 0 }] },
          { direction: "credit", amount: -5, bookingDate: "2024-10-09", acctSvcrRef: "E2", txs: [{ amount: -5 }] },
        ],
      })
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.warnings).toEqual([
      "Transaktion 1 i post 1 har ett belopp som är negativt eller 0 och hoppades över",
      "Transaktion 1 i post 2 har ett belopp som är negativt eller 0 och hoppades över",
    ]);
  });
});

describe("Handelsbanken och Nordea", () => {
  it("Handelsbanken credit: batch entry, ClrSysRef keys, SCOR and an unidentified CINV, no value date", () => {
    const parsed = parseCamt054(fixture("camt054-handelsbanken-credit.xml"));
    expect(parsed.entries.map((e) => [e.dedupeKey, e.dedupeSource, e.valueDate])).toEqual([
      ["SE4550000000058398257466|clr:393380174532", "clr_sys_ref", null],
      ["SE4550000000058398257466|clr:393380174533", "clr_sys_ref", null],
    ]);
    expect(parsed.entries[0]!.remittance).toEqual([{ type: "SCOR", value: "501262", amount: null }]);
    expect(parsed.entries[1]!.remittance).toEqual([{ type: "CINV", value: "1234", amount: null }]);
  });

  it("Handelsbanken debit: InstdAmt when TxAmt is absent, entry reference as fallback key", () => {
    const [entry] = parseCamt054(fixture("camt054-handelsbanken-debit.xml")).entries;
    expect(entry).toMatchObject({ amount: 12500, endToEndId: "BO-7-1", dedupeKey: "SE4550000000058398257466|ntry:HB-2024101500017#0", dedupeSource: "entry_ref" });
  });

  it("Nordea: AcctSvcrRef per transaction, never the per-file NtryRef", () => {
    const credit = parseCamt054(fixture("camt054-nordea-credit.xml")).entries[0]!;
    expect(credit).toMatchObject({ dedupeKey: "SE4550000000058398257466|tx:NDEA-T-77810-1", valueDate: "2024-10-09" });
    const debit = parseCamt054(fixture("camt054-nordea-debit.xml")).entries[0]!;
    expect(debit).toMatchObject({ dedupeKey: "SE4550000000058398257466|tx:NDEA-D-5512", endToEndId: "BO-7-1" });
  });
});

// Valuta steg 2: a payment in another currency from the SEK account. The
// entry's amount stays the SEK that left the account (TxAmt); the instructed
// amount in the invoice's currency, the bank's exchange details and the
// charges included in the entry come along.
describe("utlandsbetalningar (debet med växling)", () => {
  it("Swedbank: InstdAmt EUR, TxAmt SEK with CcyXchg (SrcCcy = the account), charges included", () => {
    const [entry, ...rest] = parseCamt054(fixture("camt054-swedbank-debit-fx.xml")).entries;
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      direction: "debit",
      endToEndId: "BO-9-1",
      amount: 13938.75,
      currency: "SEK",
      instructedAmount: 1250,
      instructedCurrency: "EUR",
      currencyExchange: { sourceCurrency: "SEK", targetCurrency: "EUR", unitCurrency: "EUR", rate: "11.131" },
      chargesAmount: 25,
      valueDate: "2026-10-15",
    });
  });

  it("SEB: the rate the other way round (SrcCcy EUR), and the separately debited fee is an entry of its own without EndToEndId", () => {
    const parsed = parseCamt054(fixture("camt054-seb-debit-fx.xml"));
    expect(parsed.entries.map((e) => [e.endToEndId, e.amount, e.instructedAmount, e.instructedCurrency, e.chargesAmount])).toEqual([
      ["BO-12-1", 27385.4, 2480, "EUR", null],
      [null, 50, null, null, null],
    ]);
    expect(parsed.entries[0]!.currencyExchange).toEqual({ sourceCurrency: "EUR", targetCurrency: "SEK", unitCurrency: "EUR", rate: "11.0425" });
  });

  it("Handelsbanken: COMM is included in the entry, a proprietary SCOM charge is debited separately and is not", () => {
    const [entry] = parseCamt054(fixture("camt054-handelsbanken-debit-fx.xml")).entries;
    expect(entry).toMatchObject({ endToEndId: "BO-9-3", amount: 10163.89, instructedAmount: 980, instructedCurrency: "USD", chargesAmount: 40 });
  });

  it("Nordea: no charges reported; a zero entry is noted and skipped", () => {
    const parsed = parseCamt054(fixture("camt054-nordea-debit-fx.xml"));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ endToEndId: "BO-9-2", amount: 44438, instructedAmount: 3400, instructedCurrency: "GBP", chargesAmount: null });
    expect(parsed.entries[0]!.currencyExchange).toEqual({ sourceCurrency: "GBP", targetCurrency: "SEK", unitCurrency: null, rate: "13.07" });
    expect(parsed.warnings).toEqual([
      "Transaktion 1 i post 2 har belopp 0 i kontots valuta (instruerat 500.00 EUR) och hoppades över — kontrollera betalningen i internetbanken",
    ]);
  });

  it("a SEK InstdAmt is no instructed amount of its own; without TxAmt a one-transaction entry takes the entry amount, never a foreign InstdAmt", () => {
    // Domestic files are read exactly as before: no new fields.
    const [domestic] = parseCamt054(fixture("camt054-nordea-debit.xml")).entries;
    expect(domestic).toMatchObject({ amount: 12500, currency: "SEK", instructedAmount: null, instructedCurrency: null, currencyExchange: null, chargesAmount: null });
    const noTxAmt = fixture("camt054-nordea-debit-fx.xml").replace(/<TxAmt>\s*<Amt Ccy="SEK">44438\.00<\/Amt>[\s\S]*?<\/TxAmt>/, "");
    const [entry] = parseCamt054(noTxAmt).entries;
    expect(entry).toMatchObject({ amount: 44438, currency: "SEK", instructedAmount: 3400, instructedCurrency: "GBP" });
  });

  it("keeps the content hash of a reference-less entry unchanged by the new fields", () => {
    const xml = camtFile({ messageId: "H-1", entries: [{ direction: "debit", amount: 100, bookingDate: "2024-10-09", txs: [{ amount: 100, counterparty: "X" }] }] });
    const withFx = camtFile({
      messageId: "H-1",
      entries: [{ direction: "debit", amount: 100, bookingDate: "2024-10-09", txs: [{ amount: 100, counterparty: "X", instructed: { amount: 9, currency: "EUR" }, charges: [{ amount: 1, code: "COMM" }] }] }],
    });
    expect(parseCamt054(withFx).entries[0]!.dedupeKey).toBe(parseCamt054(xml).entries[0]!.dedupeKey);
  });

  it("the test builder's exchange case is valid against the XSD", async () => {
    const xml = camtFile({
      messageId: "F-1",
      account: "SE4550000000058398257466",
      entries: [
        {
          direction: "debit",
          amount: 13938.75,
          bookingDate: "2024-10-15",
          txs: [
            {
              endToEndId: "BO-1-1",
              acctSvcrRef: "T1",
              amount: 13938.75,
              instructed: { amount: 1250, currency: "EUR" },
              exchange: { source: "EUR", target: "SEK", unit: "EUR", rate: "11.131" },
              charges: [{ amount: 25, code: "COMM" }, { amount: 75, proprietary: "SCOM" }],
            },
          ],
        },
      ],
    });
    expect(await validateAgainstXsd(xml, "camt.054.001.02")).toEqual([]);
    expect(parseCamt054(xml).entries[0]).toMatchObject({ instructedAmount: 1250, chargesAmount: 25 });
  });
});

describe("robusthet", () => {
  // Review Focus 2: prefixes, BOM, CRLF, comments, amounts without decimals.
  it("reads a prefixed, CRLF, BOM'd file with comments and integer amounts exactly like the plain one", () => {
    const plain = fixture("camt054-swedbank-credit.xml");
    const prefixed =
      "\uFEFF" +
      plain
        .replace('xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"', 'xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"')
        .replace(/<(\/?)([A-Za-z])/g, "<$1ns2:$2")
        .replace(/>(\d+)\.00</g, ">$1<")
        .replace(/\n/g, "\r\n")
        .replace("<ns2:GrpHdr>", "<ns2:GrpHdr><!-- comment -->");
    const a = parseCamt054(plain);
    const b = parseCamt054(prefixed);
    // amount.toFixed(2) and numeric remittance amounts make "1200" and
    // "1200.00" hash alike, so even the content-hash key is identical.
    const project = (entries: typeof a.entries) =>
      entries.map(({ dedupeKey, amount, remittance, counterpartyName }) => ({ dedupeKey, amount, remittance, counterpartyName }));
    expect(project(b.entries)).toEqual(project(a.entries));
    expect(b.entries[0]!.amount).toBe(10000);
    expect(b.entries[0]!.counterpartyName).toBe("AB FONSTERBOLAGET");
  });

  it("refuses DTDs and entities (XXE-safe by construction)", () => {
    expect(() => parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(BankFileParseError);
    expect(() => parseXml("<x>&unknown;</x>")).toThrow(BankFileParseError);
    expect(() => parseXml("<a><b></a></b>")).toThrow(BankFileParseError);
    expect(() => parseXml("<a>")).toThrow(BankFileParseError);
    expect(() => parseXml("not xml")).toThrow(BankFileParseError);
    expect(() => parseXml("<a>" + "<b>".repeat(70) + "</b>".repeat(70) + "</a>")).toThrow(BankFileParseError);
  });

  it("refuses inherited names, out-of-range character references and oversized input with a parse error", () => {
    expect(() => parseXml("<x>&constructor;</x>")).toThrow(BankFileParseError);
    expect(() => parseXml("<x>&#x110000;</x>")).toThrow(BankFileParseError);
    expect(() => parseXml("<x>&#0;</x>")).toThrow(BankFileParseError);
    expect(() => parseXml("<x>" + "a".repeat(20 * 1024 * 1024) + "</x>")).toThrow(BankFileParseError);
  });

  // Review fix: the attribute regex backtracked quadratically on a long
  // attribute body without "=" (1 MB tag ≈ minutes on the single API thread).
  it.each([
    ["bare", "<x " + "a".repeat(200_000) + "/>"],
    ["inside a valid root", "<r><x " + "a".repeat(200_000) + "/></r>"],
    ["name, '=' but no quote", "<x " + "a=".repeat(100_000) + "/>"],
  ])("reads a huge malformed attribute body in linear time (%s)", (_label, xml) => {
    const started = performance.now();
    let outcome: unknown;
    try {
      outcome = parseXml(xml).root.attrs;
    } catch (err) {
      outcome = err;
    }
    expect(performance.now() - started).toBeLessThan(1000);
    if (outcome instanceof Error) expect(outcome).toBeInstanceOf(BankFileParseError);
    else expect(outcome).toEqual({});
  });

  it("reads attributes with either quote and whitespace around '=', and refuses malformed ones", () => {
    expect(parseXml(`<x a="1" b = '2'\n c\t=\t"3 &amp; 4"/>`).root.attrs).toEqual({ a: "1", b: "2", c: "3 & 4" });
    expect(() => parseXml("<x a/>")).toThrow(BankFileParseError);
    expect(() => parseXml('<x a="1/>')).toThrow(BankFileParseError);
    expect(() => parseXml("<x a=1/>")).toThrow(BankFileParseError);
    expect(() => parseXml('<x a="1"b="2"/>')).toThrow(BankFileParseError);
  });

  it("caps the number of elements so a 20 MB file cannot balloon the heap", () => {
    expect(() => parseXml("<r>" + "<a/>".repeat(500_001) + "</r>")).toThrow(BankFileParseError);
    expect(parseXml("<r>" + "<a/>".repeat(1000) + "</r>").root.children).toHaveLength(1000);
  });

  // Attributes are nodes too: one element with a huge attribute list must
  // not get past the cap that bounds the tree.
  it("counts attributes toward the node cap", () => {
    expect(() => parseXml("<r>" + '<a b=""/>'.repeat(250_001) + "</r>")).toThrow(/för många element/);
    const many = Array.from({ length: 500_001 }, (_, i) => `a${i}=""`).join(" ");
    expect(() => parseXml(`<r ${many}/>`)).toThrow(/för många element/);
    expect(parseXml("<r>" + '<a b=""/>'.repeat(1000) + "</r>").root.children).toHaveLength(1000);
  });

  // The route answers with the message: echoed input is clipped (~40 chars).
  it.each([
    ["closing-tag mismatch", "<a></" + "x".repeat(10_000) + "></a>"],
    ["unknown entity", "<a>&" + "y".repeat(10_000) + ";</a>"],
    ["character reference", "<a>&#" + "9".repeat(10_000) + ";</a>"],
  ])("clips the input it echoes in a parse error (%s)", (_label, xml) => {
    let error: unknown;
    try {
      parseXml(xml);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BankFileParseError);
    expect((error as Error).message.length).toBeLessThan(80);
    expect((error as Error).message).toContain("…");
  });

  it("decodes the predefined entities, character references and CDATA", () => {
    const { root } = parseXml("<a x='1 &amp; 2'>&lt;&#229;&#xE4;&gt;<![CDATA[<&>]]></a>");
    expect(root.attrs.x).toBe("1 & 2");
    expect(root.text).toBe("<åä><&>");
  });

  it("names another message type instead of guessing", () => {
    const camt053 = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt/></Document>';
    expect(() => parseCamt054(camt053)).toThrow(UnsupportedBankMessageError);
    // The namespace is echoed in the 400 — clipped like the reader's errors.
    expect(() => parseCamt054(`<Document xmlns="${"urn:".repeat(5000)}"/>`)).toThrow(/^.{0,140}$/);
  });
});

// Final review: what the database would refuse (a date that is no date, an
// amount wider than numeric(14,2), a key longer than varchar(120)) is a 400
// parse error up front, never a 500 from the INSERT.
describe("indatakontroll", () => {
  const one = (overrides: { bookingDate?: string; amount?: number; account?: string; acctSvcrRef?: string }) =>
    camtFile({
      messageId: "V-1",
      account: overrides.account,
      entries: [
        {
          direction: "credit",
          amount: overrides.amount ?? 100,
          bookingDate: overrides.bookingDate ?? "2024-10-09",
          txs: [{ acctSvcrRef: overrides.acctSvcrRef ?? "T1", amount: overrides.amount ?? 100 }],
        },
      ],
    });

  it.each(["2024-13-01", "2024-02-30", "2024-1-9", "9oktober"])("refuses the booking date %s", (date) => {
    expect(() => parseCamt054(one({ bookingDate: date }))).toThrow(BankFileParseError);
    expect(() => parseCamt054(one({ bookingDate: date }))).toThrow(/bokföringsdag/);
  });

  it("refuses an unreal value date and clips what it echoes", () => {
    const xml = fixture("camt054-swedbank-credit.xml").replace("<BookgDt>", `<ValDt><Dt>2024-10-${"9".repeat(300)}</Dt></ValDt><BookgDt>`);
    // ValDt comes after BookgDt in the schema; the parser reads it by name.
    expect(() => parseCamt054(xml)).toThrow(BankFileParseError);
    expect(() => parseCamt054(xml)).toThrow(/^.{0,160}$/);
  });

  it("reads a booking date-time as its date", () => {
    const xml = one({}).replace("<BookgDt><Dt>2024-10-09</Dt></BookgDt>", "<BookgDt><DtTm>2024-10-09T23:15:00+02:00</DtTm></BookgDt>");
    expect(parseCamt054(xml).entries[0]!.bookingDate).toBe("2024-10-09");
  });

  it("refuses an amount wider than numeric(14,2), and a non-decimal one", () => {
    expect(parseCamt054(one({ amount: 999_999_999_999.99 })).entries[0]!.amount).toBe(999_999_999_999.99);
    expect(() => parseCamt054(one({ amount: 1_000_000_000_000 }))).toThrow(BankFileParseError);
    expect(() => parseCamt054(one({ amount: 1_000_000_000_000 }))).toThrow(/belopp/i);
    // 999 999 999 999.996 rounds up past the column.
    const rounded = one({}).replace(/>100\.00</g, ">999999999999.996<");
    expect(() => parseCamt054(rounded)).toThrow(BankFileParseError);
    const hex = one({}).replace(/>100\.00</g, ">0x64<");
    expect(() => parseCamt054(hex)).toThrow(BankFileParseError);
    const exponent = one({}).replace(/>100\.00</g, ">1e2<");
    expect(() => parseCamt054(exponent)).toThrow(BankFileParseError);
  });

  it("refuses a reference key longer than the column", () => {
    expect(parseCamt054(one({ account: "SE4550000000058398257466", acctSvcrRef: "R".repeat(35) })).entries[0]!.dedupeKey.length).toBeLessThanOrEqual(120);
    expect(() => parseCamt054(one({ acctSvcrRef: "R".repeat(200) }))).toThrow(BankFileParseError);
    expect(() => parseCamt054(one({ acctSvcrRef: "R".repeat(200) }))).toThrow(/^.{0,160}$/);
  });
});

// Final review: two transactions with the same bank reference in ONE file are
// two transactions — the second must never be dropped by the unique key.
describe("dubblerade referenser i samma fil", () => {
  it("numbers the repeat deterministically and warns", () => {
    const xml = camtFile({
      messageId: "D-1",
      entries: [
        { direction: "credit", amount: 100, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "SAME", amount: 100, counterparty: "A AB" }] },
        { direction: "credit", amount: 250, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "SAME", amount: 250, counterparty: "B AB" }] },
        { direction: "credit", amount: 75, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "SAME#2", amount: 75, counterparty: "C AB" }] },
      ],
    });
    const parsed = parseCamt054(xml);
    expect(parsed.entries.map((e) => [e.dedupeKey, e.amount])).toEqual([
      ["5512348|tx:SAME", 100],
      ["5512348|tx:SAME#2", 250],
      ["5512348|tx:SAME#2#2", 75],
    ]);
    expect(parsed.warnings).toEqual([
      "Transaktion 1 i post 2 har samma bankreferens som en tidigare transaktion i filen — den läses in som en egen post. Kontrollera att den inte är dubblerad.",
      "Transaktion 1 i post 3 har samma bankreferens som en tidigare transaktion i filen — den läses in som en egen post. Kontrollera att den inte är dubblerad.",
    ]);
    // Re-reading gives the same keys, so an overlapping upload still dedupes.
    expect(parseCamt054(xml).entries.map((e) => e.dedupeKey)).toEqual(parsed.entries.map((e) => e.dedupeKey));
  });
});
