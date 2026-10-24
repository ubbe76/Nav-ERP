import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BankFileParseError, BankStatementFormatError } from "../src/modules/banking/service/banking.errors.js";
import { parseCamt053 } from "../src/modules/banking/service/iso20022/camt053-parser.js";
import { camt053File } from "./helpers/camt053.js";
import { validateAgainstXsd } from "./helpers/xsd.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/iso20022/${name}`, import.meta.url), "utf8");
const FIXTURES = ["camt053-swedbank.xml", "camt053-seb.xml", "camt053-handelsbanken.xml", "camt053-nordea.xml"];

describe("fixturerna", () => {
  it.each(FIXTURES)("%s is valid against the official camt.053.001.02 XSD", async (name) => {
    expect(await validateAgainstXsd(fixture(name), "camt.053.001.02")).toEqual([]);
  });

  it("the test builder's output is valid too", async () => {
    const xml = camt053File({
      messageId: "T-053-1",
      statements: [
        {
          from: "2024-10-09",
          to: "2024-10-09",
          opening: { amount: 1000, date: "2024-10-08" },
          closing: { amount: -250, date: "2024-10-09" },
          entries: [
            { direction: "credit", amount: 100, bookingDate: "2024-10-09", acctSvcrRef: "A1", txs: [{ acctSvcrRef: "T1", endToEndId: "E1", amount: 100, counterparty: "Kund", scor: "123", ustrd: "Hej" }] },
            { direction: "debit", amount: 1350, bookingDate: "2024-10-09", valueDate: "2024-10-09", ntryRef: "N2", reversal: true, addtlNtryInf: "Avgift" },
          ],
        },
        { iban: "SE4550000000058398257466", closing: { amount: 0, date: "2024-10-09" }, entries: [] },
      ],
    });
    expect(await validateAgainstXsd(xml, "camt.053.001.02")).toEqual([]);
  });
});

describe("Swedbank", () => {
  const parsed = parseCamt053(fixture("camt053-swedbank.xml"));

  it("reads the statement header, the account and the booked balances", () => {
    expect(parsed.messageId).toBe("SWEDSESSSTMT20241010000001");
    expect(parsed.statements).toHaveLength(1);
    const stmt = parsed.statements[0]!;
    expect(stmt).toMatchObject({
      statementId: "SWEDSESSSTMT2024101000000100001",
      accountRaw: "821491234567890",
      accountIdentifier: "821491234567890",
      currency: "SEK",
      fromDate: "2024-10-09",
      toDate: "2024-10-09",
      openingBalance: 100000,
      closingBalance: 107580,
      closingBalanceDate: "2024-10-09",
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps a collective entry as ONE entry with its transactions listed, signed amounts", () => {
    const [collective, payment, fee] = parsed.statements[0]!.entries;
    expect(collective).toMatchObject({
      bookingDate: "2024-10-09",
      valueDate: "2024-10-09",
      amount: 26180,
      currency: "SEK",
      text: "BG INBETALNINGAR 551-2348",
      reference: null,
      counterparty: null,
      reversal: false,
      dedupeKey: "821491234567890|ntry:2024100984020001",
      position: 0,
    });
    expect(collective!.details.transactions).toHaveLength(3);
    expect(collective!.details.transactions[0]).toMatchObject({ acctSvcrRef: "202410098402000100000001", amount: 10000, counterparty: "AB FONSTERBOLAGET", references: [{ type: "CINV", value: "501262" }] });
    expect(collective!.references).toEqual(["2024100984020001", "202410098402000100000001", "202410098402000100000002", "202410098402000100000003"]);
    expect(payment).toMatchObject({
      amount: -18450,
      text: "LEVERANTORSBETALNING",
      reference: "4455667788",
      counterparty: "PLATLAGRET AB",
      dedupeKey: "821491234567890|ntry:2024100984030001",
    });
    expect(payment!.references).toEqual(["2024100984030001", "202410098403000100000001", "BO-7-1"]);
    // No bank reference at all: a content hash with a per-file counter.
    expect(fee).toMatchObject({ amount: -150, text: "AVGIFT KONTOUTDRAG", reference: null, position: 2 });
    expect(fee!.dedupeKey).toMatch(/^821491234567890\|hash:[0-9a-f]{64}#1$/);
    expect(fee!.references).toEqual([]);
  });
});

describe("SEB", () => {
  const parsed = parseCamt053(fixture("camt053-seb.xml"));

  it("skips pending entries with a warning and reads CLBD over CLAV/FWAV", () => {
    const stmt = parsed.statements[0]!;
    expect(stmt).toMatchObject({ accountIdentifier: "54401234567", openingBalance: 365371.31, closingBalance: 135830.31, closingBalanceDate: "2024-10-09" });
    expect(stmt.entries).toHaveLength(2);
    expect(parsed.warnings).toEqual(["Post 3 med status PDNG hoppades över (bara bokförda poster läses)"]);
  });

  it("a collective LB entry without AddtlNtryInf gets a summary text; interest keeps the bank's text", () => {
    const [lb, interest] = parsed.statements[0]!.entries;
    expect(lb).toMatchObject({ amount: -242041, text: "Samlingspost (2 transaktioner)", reference: null, dedupeKey: "54401234567|ntry:STOI520111188400029234" });
    expect(lb!.references).toEqual(["STOI520111188400029234", "STOESI05241009113433580558000001", "BO-12-1", "STOESI05241009113433580559000001", "BO-12-2"]);
    expect(lb!.details.ntryRef).toBe("LBE5419-0186-0029234");
    expect(interest).toMatchObject({ amount: 12500, text: "Ränta", dedupeKey: "54401234567|ntry:STOI520111188400029235" });
  });
});

describe("Handelsbanken", () => {
  const parsed = parseCamt053(fixture("camt053-handelsbanken.xml"));

  it("normalises the IBAN, takes the latest CLBD of a two-day statement and signs negative balances", () => {
    const stmt = parsed.statements[0]!;
    expect(stmt).toMatchObject({ accountIdentifier: "SE4550000000058398257466", fromDate: "2024-10-08", toDate: "2024-10-09", openingBalance: -2500, closingBalance: -1199, closingBalanceDate: "2024-10-09" });
  });

  it("reads Swish text from Ustrd, a card purchase from AddtlNtryInf and a return with RvslInd", () => {
    const [swish, card, returned] = parsed.statements[0]!.entries;
    expect(swish).toMatchObject({ amount: 1700, text: "Swish reservdel", counterparty: "ANNA EXEMPEL", reference: null });
    // NOTPROVIDED is no reference.
    expect(swish!.references).toEqual(["HB20241008-000401", "HB20241008-000401-1"]);
    expect(card).toMatchObject({ amount: -899, text: "KORTKOP BYGGVARUHUSET EXEMPELBY", reference: null, counterparty: null });
    expect(returned).toMatchObject({ amount: 500, reversal: true, counterparty: "SMAFIRMAN HB", reference: "BO-9-2", text: "ATERBETALNING FELAKTIGT KONTO" });
  });
});

describe("Nordea", () => {
  const parsed = parseCamt053(fixture("camt053-nordea.xml"));

  it("reads the SCOR reference and the Skatteverket counterparty; NtryRef is never the dedupe key", () => {
    const [inbound, tax] = parsed.statements[0]!.entries;
    expect(inbound).toMatchObject({ amount: 5000, reference: "501300", counterparty: "KUNDEN I NORR AB", dedupeKey: "SE2130000000012345678901|ntry:2024100912345678" });
    expect(tax).toMatchObject({ amount: -30000, text: "BETALNING SKATTEKONTO", counterparty: "SKATTEVERKET", reference: "16556677889900" });
    expect(tax!.references).toEqual(["2024100912345679", "SKATT-2024-10"]);
    expect(parsed.statements[0]!.closingBalance).toBe(25000);
  });
});

describe("the builder and edge cases", () => {
  it("falls back to the one transaction's AcctSvcrRef for the key, and to a hash with #n for repeats", () => {
    const xml = camt053File({
      messageId: "T-2",
      statements: [
        {
          entries: [
            { direction: "debit", amount: 10, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "TX-1", amount: 10 }] },
            { direction: "debit", amount: 10, bookingDate: "2024-10-09", addtlNtryInf: "Avgift" },
            { direction: "debit", amount: 10, bookingDate: "2024-10-09", addtlNtryInf: "Avgift" },
            { direction: "debit", amount: 10, bookingDate: "2024-10-09", acctSvcrRef: "TX-1" },
          ],
        },
      ],
    });
    const parsed = parseCamt053(xml);
    const keys = parsed.statements[0]!.entries.map((e) => e.dedupeKey);
    expect(keys[0]).toBe("821491234567890|ntry:TX-1");
    expect(keys[1]).toMatch(/\|hash:[0-9a-f]{64}#1$/);
    expect(keys[2]).toBe(`${keys[1]!.slice(0, -2)}#2`);
    expect(keys[3]).toBe("821491234567890|ntry:TX-1#2");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("samma bankreferens");
    // The same file read twice gives the same keys — the dedupe is deterministic.
    expect(parseCamt053(xml).statements[0]!.entries.map((e) => e.dedupeKey)).toEqual(keys);
  });

  it("a statement without balances or period gives nulls and the entries' date range", () => {
    const parsed = parseCamt053(camt053File({ messageId: "T-3", statements: [{ entries: [{ direction: "credit", amount: 1, bookingDate: "2024-10-02", acctSvcrRef: "A" }, { direction: "credit", amount: 1, bookingDate: "2024-10-01", acctSvcrRef: "B" }] }] }));
    expect(parsed.statements[0]).toMatchObject({ fromDate: "2024-10-01", toDate: "2024-10-02", openingBalance: null, closingBalance: null, closingBalanceDate: null });
  });

  it("skips a zero entry with a warning", () => {
    const parsed = parseCamt053(camt053File({ messageId: "T-4", statements: [{ entries: [{ direction: "credit", amount: 0, bookingDate: "2024-10-02", acctSvcrRef: "A" }] }] }));
    expect(parsed.statements[0]!.entries).toEqual([]);
    expect(parsed.warnings).toEqual(["Post 1 har belopp 0 och hoppades över"]);
  });

  it("refuses a camt.054, a file without statements and an unreal date", () => {
    const camt054 = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"><BkToCstmrDbtCdtNtfctn/></Document>';
    expect(() => parseCamt053(camt054)).toThrow(BankStatementFormatError);
    const empty = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>X</MsgId><CreDtTm>2024-10-10T00:00:00</CreDtTm></GrpHdr></BkToCstmrStmt></Document>';
    expect(() => parseCamt053(empty)).toThrow(BankFileParseError);
    const badDate = camt053File({ messageId: "T-5", statements: [{ entries: [{ direction: "credit", amount: 1, bookingDate: "2024-02-30", acctSvcrRef: "A" }] }] });
    expect(() => parseCamt053(badDate)).toThrow(BankFileParseError);
  });
});
