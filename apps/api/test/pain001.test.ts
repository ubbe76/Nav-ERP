import { describe, expect, it } from "vitest";
import { addDays, stockholmDate, stockholmDateTime } from "../src/modules/banking/service/banking-dates.js";
import { BANK_PROFILES } from "../src/modules/banking/service/iso20022/bank-profiles.js";
import { buildPain001, defaultPaymentMessage, type Pain001Input } from "../src/modules/banking/service/iso20022/pain001-builder.js";
import { checkPain001 } from "../src/modules/banking/service/iso20022/pain001-check.js";
import { sanitizeText } from "../src/modules/banking/service/iso20022/sanitize.js";
import { validateAgainstXsd } from "./helpers/xsd.js";

const TODAY = "2026-10-09";

// The spec's worked example (§ Genomgående exempel): BO-7 with its three
// items, plus BO-7-4 — a payment to a SWEDISH IBAN (the only IBAN v1 takes),
// so every profile's golden file carries all four creditor methods.
function exampleInput(overrides: Partial<Pain001Input["debtor"]> = {}): Pain001Input {
  return {
    messageId: "BO-7",
    createdAt: new Date("2026-10-09T12:05:12Z"), // 14:05:12 in Stockholm (CEST)
    debtor: {
      name: "Exempel Verkstad AB",
      orgNumber: "556677-8899",
      postalCode: "802 22",
      city: "Gävle",
      account: { kind: "bankgiro", value: "5512348" },
      initiatingPartyId: "123456789123B001",
      agreementId: null,
      ...overrides,
    },
    items: [
      {
        endToEndId: "BO-7-1",
        amount: 12500,
        executionDate: "2026-10-15",
        creditor: { name: "Plåtlagret AB", postalCode: "753 20", city: "Uppsala", method: "bankgiro", bankgiro: "50501055", plusgiro: null, clearing: null, account: null, iban: null, bic: null },
        reference: { kind: "ocr", value: "4605127" },
      },
      {
        endToEndId: "BO-7-2",
        amount: 3480,
        executionDate: "2026-10-12",
        creditor: { name: "Svets & Montage i Exempelby AB", postalCode: "827 30", city: "Ljusdal", method: "plusgiro", bankgiro: null, plusgiro: "4892162", clearing: null, account: null, iban: null, bic: null },
        reference: { kind: "message", value: "Faktura 2026-118" },
      },
      {
        endToEndId: "BO-7-3",
        amount: 8850,
        executionDate: "2026-10-15",
        creditor: { name: "Exempelhydraulik AB", postalCode: "803 09", city: "Gävle", method: "bank_account", bankgiro: null, plusgiro: null, clearing: "83279", account: "9941234123", iban: null, bic: null },
        reference: { kind: "message", value: "88213" },
      },
      {
        endToEndId: "BO-7-4",
        amount: 4100,
        executionDate: "2026-10-20",
        creditor: { name: "Exempelslipen AB", postalCode: "802 67", city: "Gävle", method: "iban", bankgiro: null, plusgiro: null, clearing: null, account: null, iban: "SE3550000000054910000003", bic: "ESSESESS" },
        reference: { kind: "message", value: "F 2026-0457" },
      },
    ],
  };
}

const compact = (xml: string) => xml.replace(/>\s+</g, "><").trim();

const SWEDBANK_EXPECTED = compact(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<CstmrCdtTrfInitn>
  <GrpHdr>
    <MsgId>BO-7</MsgId><CreDtTm>2026-10-09T14:05:12</CreDtTm><NbOfTxs>4</NbOfTxs><CtrlSum>28930.00</CtrlSum>
    <InitgPty><Id><OrgId><Othr><Id>123456789123B001</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr></OrgId></Id></InitgPty>
  </GrpHdr>
  <PmtInf>
    <PmtInfId>BO-7-20261012</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>1</NbOfTxs><CtrlSum>3480.00</CtrlSum>
    <PmtTpInf><SvcLvl><Cd>NURG</Cd></SvcLvl><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>
    <ReqdExctnDt>2026-10-12</ReqdExctnDt>
    <Dbtr><Nm>Exempel Verkstad AB</Nm><PstlAdr><PstCd>80222</PstCd><TwnNm>Gävle</TwnNm><Ctry>SE</Ctry></PstlAdr></Dbtr>
    <DbtrAcct><Id><Othr><Id>5512348</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr></Id><Ccy>SEK</Ccy></DbtrAcct>
    <DbtrAgt><FinInstnId><BIC>SWEDSESS</BIC></FinInstnId></DbtrAgt>
    <CdtTrfTxInf>
      <PmtId><InstrId>BO-7-2</InstrId><EndToEndId>BO-7-2</EndToEndId></PmtId>
      <Amt><InstdAmt Ccy="SEK">3480.00</InstdAmt></Amt>
      <CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>SESBA</Cd></ClrSysId><MmbId>9960</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>
      <Cdtr><Nm>Svets och Montage i Exempelby AB</Nm><PstlAdr><PstCd>82730</PstCd><TwnNm>Ljusdal</TwnNm><Ctry>SE</Ctry></PstlAdr></Cdtr>
      <CdtrAcct><Id><Othr><Id>4892162</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id></CdtrAcct>
      <RmtInf><Ustrd>Faktura 2026-118</Ustrd></RmtInf>
    </CdtTrfTxInf>
  </PmtInf>
  <PmtInf>
    <PmtInfId>BO-7-20261015</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>2</NbOfTxs><CtrlSum>21350.00</CtrlSum>
    <PmtTpInf><SvcLvl><Cd>NURG</Cd></SvcLvl><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>
    <ReqdExctnDt>2026-10-15</ReqdExctnDt>
    <Dbtr><Nm>Exempel Verkstad AB</Nm><PstlAdr><PstCd>80222</PstCd><TwnNm>Gävle</TwnNm><Ctry>SE</Ctry></PstlAdr></Dbtr>
    <DbtrAcct><Id><Othr><Id>5512348</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr></Id><Ccy>SEK</Ccy></DbtrAcct>
    <DbtrAgt><FinInstnId><BIC>SWEDSESS</BIC></FinInstnId></DbtrAgt>
    <CdtTrfTxInf>
      <PmtId><InstrId>BO-7-1</InstrId><EndToEndId>BO-7-1</EndToEndId></PmtId>
      <Amt><InstdAmt Ccy="SEK">12500.00</InstdAmt></Amt>
      <CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>SESBA</Cd></ClrSysId><MmbId>9900</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>
      <Cdtr><Nm>Plåtlagret AB</Nm><PstlAdr><PstCd>75320</PstCd><TwnNm>Uppsala</TwnNm><Ctry>SE</Ctry></PstlAdr></Cdtr>
      <CdtrAcct><Id><Othr><Id>50501055</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr></Id></CdtrAcct>
      <RmtInf><Strd>
        <RfrdDocAmt><RmtdAmt Ccy="SEK">12500.00</RmtdAmt></RfrdDocAmt>
        <CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>4605127</Ref></CdtrRefInf>
      </Strd></RmtInf>
    </CdtTrfTxInf>
    <CdtTrfTxInf>
      <PmtId><InstrId>BO-7-3</InstrId><EndToEndId>BO-7-3</EndToEndId></PmtId>
      <Amt><InstdAmt Ccy="SEK">8850.00</InstdAmt></Amt>
      <CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>SESBA</Cd></ClrSysId><MmbId>83279</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>
      <Cdtr><Nm>Exempelhydraulik AB</Nm><PstlAdr><PstCd>80309</PstCd><TwnNm>Gävle</TwnNm><Ctry>SE</Ctry></PstlAdr></Cdtr>
      <CdtrAcct><Id><Othr><Id>832799941234123</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id></CdtrAcct>
      <RmtInf><Ustrd>88213</Ustrd></RmtInf>
    </CdtTrfTxInf>
  </PmtInf>
  <PmtInf>
    <PmtInfId>BO-7-20261020</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>1</NbOfTxs><CtrlSum>4100.00</CtrlSum>
    <PmtTpInf><SvcLvl><Cd>NURG</Cd></SvcLvl><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>
    <ReqdExctnDt>2026-10-20</ReqdExctnDt>
    <Dbtr><Nm>Exempel Verkstad AB</Nm><PstlAdr><PstCd>80222</PstCd><TwnNm>Gävle</TwnNm><Ctry>SE</Ctry></PstlAdr></Dbtr>
    <DbtrAcct><Id><Othr><Id>5512348</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr></Id><Ccy>SEK</Ccy></DbtrAcct>
    <DbtrAgt><FinInstnId><BIC>SWEDSESS</BIC></FinInstnId></DbtrAgt>
    <CdtTrfTxInf>
      <PmtId><InstrId>BO-7-4</InstrId><EndToEndId>BO-7-4</EndToEndId></PmtId>
      <Amt><InstdAmt Ccy="SEK">4100.00</InstdAmt></Amt>
      <CdtrAgt><FinInstnId><BIC>ESSESESS</BIC></FinInstnId></CdtrAgt>
      <Cdtr><Nm>Exempelslipen AB</Nm><PstlAdr><PstCd>80267</PstCd><TwnNm>Gävle</TwnNm><Ctry>SE</Ctry></PstlAdr></Cdtr>
      <CdtrAcct><Id><IBAN>SE3550000000054910000003</IBAN></Id></CdtrAcct>
      <RmtInf><Ustrd>F 2026-0457</Ustrd></RmtInf>
    </CdtTrfTxInf>
  </PmtInf>
</CstmrCdtTrfInitn>
</Document>`);

const SWEDISH_IBAN_ACCOUNT = "<CdtrAcct><Id><IBAN>SE3550000000054910000003</IBAN></Id></CdtrAcct>";

describe("validateAgainstXsd", () => {
  // Guards the guard: a helper that always answered [] would make every
  // "is XSD-valid" assertion below worthless.
  it("reports errors for a document that breaks the schema", async () => {
    const valid = buildPain001(exampleInput(), BANK_PROFILES.swedbank).xml;
    const outOfOrder = valid.replace("<MsgId>BO-7</MsgId><CreDtTm>2026-10-09T14:05:12</CreDtTm>", "<CreDtTm>2026-10-09T14:05:12</CreDtTm><MsgId>BO-7</MsgId>");
    const badIban = valid.replace("SE3550000000054910000003", "se35 5000");
    expect(await validateAgainstXsd(outOfOrder, "pain.001.001.03")).not.toEqual([]);
    expect(await validateAgainstXsd(badIban, "pain.001.001.03")).not.toEqual([]);
  });
});

describe("pain.001 — Swedbank (primär profil)", () => {
  const profile = BANK_PROFILES.swedbank;

  it("builds the spec's BO-7 exactly", () => {
    expect(checkPain001(exampleInput(), profile, TODAY)).toEqual([]);
    const { xml, items } = buildPain001(exampleInput(), profile);
    expect(xml).toBe(SWEDBANK_EXPECTED);
    expect(items.map((i) => i.endToEndId)).toEqual(["BO-7-1", "BO-7-2", "BO-7-3", "BO-7-4"]);
    expect(items.find((i) => i.endToEndId === "BO-7-2")!.warnings).toEqual([
      'Mottagarens namn skickas som "Svets och Montage i Exempelby AB"',
    ]);
    expect(items.find((i) => i.endToEndId === "BO-7-1")!.snapshot).toEqual({
      method: "bankgiro", account: "50501055", clearing: null, bic: null, name: "Plåtlagret AB",
      postalCode: "75320", city: "Uppsala", referenceKind: "ocr", reference: "4605127",
    });
    expect(items.find((i) => i.endToEndId === "BO-7-4")!.snapshot).toEqual({
      method: "iban", account: "SE3550000000054910000003", clearing: null, bic: "ESSESESS", name: "Exempelslipen AB",
      postalCode: "80267", city: "Gävle", referenceKind: "message", reference: "F 2026-0457",
    });
  });

  it("is valid against the official XSD", async () => {
    expect(await validateAgainstXsd(buildPain001(exampleInput(), profile).xml, "pain.001.001.03")).toEqual([]);
  });

  it("pads a Swedbank 8-series BBAN to 15 digits and leaves other clearings alone", () => {
    const input = exampleInput();
    input.items[2]!.creditor.account = "123456";
    expect(buildPain001(input, profile).xml).toContain("<Id>832790000123456</Id>");
    input.items[2]!.creditor.clearing = "6001";
    expect(buildPain001(input, profile).xml).toContain("<Id>6001123456</Id>");
  });

  // Swedbank's 8-series: clearing "8CCCC" (5 digits incl. check digit) and
  // a BBAN of exactly 15 digits — the bank rejects anything else.
  it("passes a 5-digit 8-series clearing and builds the padded 15-digit BBAN", async () => {
    const input = exampleInput();
    input.items[2]!.creditor.account = "123456";
    expect(checkPain001(input, profile, TODAY)).toEqual([]);
    const { xml } = buildPain001(input, profile);
    expect(xml).toContain("<CdtrAcct><Id><Othr><Id>832790000123456</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id></CdtrAcct>");
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
  });

  it("refuses a 4-digit 8-series clearing in every profile", () => {
    for (const p of Object.values(BANK_PROFILES)) {
      const input = exampleInput();
      input.items[2]!.creditor.clearing = "8327";
      expect(checkPain001(input, p, TODAY).filter((v) => v.endToEndId === "BO-7-3")).toEqual([
        { endToEndId: "BO-7-3", field: "creditorAccount", message: "Mottagarens clearing- eller kontonummer är ogiltigt" },
      ]);
    }
  });

  it("refuses an 8-series account that would not fit Swedbank's 15 digits", () => {
    const input = exampleInput();
    input.items[2]!.creditor.account = "12345678901"; // 83279 + 11 digits = 16
    expect(checkPain001(input, profile, TODAY).map((v) => `${v.endToEndId}:${v.field}`)).toEqual(["BO-7-3:creditorAccount"]);
    // Banks without the 15-digit rule take the same account.
    expect(checkPain001(input, BANK_PROFILES.handelsbanken, TODAY).filter((v) => v.endToEndId === "BO-7-3")).toEqual([]);
  });

  it("limits a bankgiro creditor's name to 35 characters", () => {
    const input = exampleInput();
    input.items[0]!.creditor.name = "Plåtlagret i Mellersta Exempelbygden Aktiebolag";
    const { xml, items } = buildPain001(input, profile);
    expect(xml).toContain("<Nm>Plåtlagret i Mellersta Exempelbygde</Nm>");
    expect(items[0]!.warnings[0]).toMatch(/kortas/);
  });

  // Review Focus 1: text outside the bank's character set.
  it("sanitizes &, accents, angle brackets, emoji and line breaks — and stays XSD-valid", async () => {
    const input = exampleInput();
    input.items[0]!.creditor.name = "Café & Co <AB> \u{1F600}\nGren";
    input.items[0]!.reference = { kind: "message", value: "Avser order 7 & 8\nTack" };
    const { xml, items } = buildPain001(input, profile);
    expect(xml).toContain("<Nm>Cafe och Co AB Gren</Nm>");
    expect(xml).toContain("<Ustrd>Avser order 7 och 8 Tack</Ustrd>");
    expect(items[0]!.warnings).toHaveLength(2);
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
  });

  it("finds every structural violation before anything is built", () => {
    const input = exampleInput({ initiatingPartyId: "12345", city: null });
    input.items[0]!.reference = { kind: "ocr", value: "4605128" };
    input.items[1]!.amount = 10.005;
    input.items[2]!.executionDate = "2026-10-08";
    input.items[2]!.reference = { kind: "message", value: "Faktura 2026-118" };
    input.items.push({ ...input.items[0]!, endToEndId: "BO-7-1", creditor: { ...input.items[0]!.creditor, city: null } });
    const fields = checkPain001(input, profile, TODAY).map((v) => `${v.endToEndId ?? "header"}:${v.field}`);
    expect(fields).toEqual([
      "header:initiatingPartyId",
      "header:debtorCity",
      "BO-7-1:reference",
      "BO-7-2:amount",
      "BO-7-3:executionDate",
      "BO-7-3:reference",
      "BO-7-1:endToEndId",
      "BO-7-1:reference",
      "BO-7-1:creditorCity",
    ]);
  });

  it("refuses a foreign IBAN and a debit account the bank does not take", () => {
    const input = exampleInput({ account: { kind: "iban", value: "SE4550000000058398257466" } });
    input.items[2]!.creditor = { ...input.items[2]!.creditor, method: "iban", iban: "DE89370400440532013000", bic: "COBADEFF", clearing: null, account: null };
    const violations = checkPain001(input, profile, TODAY);
    const messages = violations.map((v) => v.message);
    expect(messages).toContain("Swedbank tar inte IBAN som debiteringskonto");
    expect(messages).toContain("Utlandsbetalningar stöds inte — bara svenska IBAN (SE…)");
    // Only the foreign item is refused — the Swedish IBAN (BO-7-4) passes.
    expect(violations.filter((v) => v.endToEndId !== null).map((v) => `${v.endToEndId}:${v.field}`)).toEqual(["BO-7-3:creditorAccount"]);
  });

  it("calls a foreign company debit IBAN out of scope, a broken one invalid", () => {
    const hb = BANK_PROFILES.handelsbanken;
    const foreign = checkPain001(exampleInput({ initiatingPartyId: null, account: { kind: "iban", value: "NO9386011117947" } }), hb, TODAY);
    expect(foreign).toEqual([
      { endToEndId: null, field: "debtorAccount", message: "Utlandskonto stöds inte som debiteringskonto — bara svenska IBAN (SE…)" },
    ]);
    const broken = checkPain001(exampleInput({ initiatingPartyId: null, account: { kind: "iban", value: "SE4550000000058398257467" } }), hb, TODAY);
    expect(broken).toEqual([{ endToEndId: null, field: "debtorAccount", message: "Företagets debiteringskonto är ogiltigt" }]);
  });

  it("refuses a foreign IBAN in every profile, and an SE IBAN with a broken checksum", () => {
    for (const profile of Object.values(BANK_PROFILES)) {
      const input = exampleInput();
      input.items[3]!.creditor.iban = "NO9386011117947";
      expect(checkPain001(input, profile, TODAY).filter((v) => v.endToEndId === "BO-7-4")).toEqual([
        { endToEndId: "BO-7-4", field: "creditorAccount", message: "Utlandsbetalningar stöds inte — bara svenska IBAN (SE…)" },
      ]);
    }
    const input = exampleInput();
    input.items[3]!.creditor.iban = "SE3550000000054910000004";
    expect(checkPain001(input, profile, TODAY).map((v) => v.message)).toEqual(["Mottagarens IBAN är ogiltigt"]);
  });

  it("omits the creditor agent for a Swedish IBAN without BIC and stays XSD-valid", async () => {
    const input = exampleInput();
    input.items[3]!.creditor.bic = null;
    expect(checkPain001(input, profile, TODAY)).toEqual([]);
    const { xml } = buildPain001(input, profile);
    expect(xml).toMatch(/<Amt><InstdAmt Ccy="SEK">4100\.00<\/InstdAmt><\/Amt><Cdtr>/);
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
  });

  it("checks what the XSD would reject: calendar dates, PmtInfId length, empty town and message", () => {
    const input = exampleInput({ city: "\u{1F600}" });
    input.messageId = "BO-123456789012345678901234"; // 27 characters: PmtInfId would be 36
    input.items[0]!.executionDate = "2026-13-01";
    input.items[1]!.creditor.city = "<>";
    input.items[2]!.reference = { kind: "message", value: "", generated: true };
    expect(checkPain001(input, profile, TODAY).map((v) => `${v.endToEndId ?? "header"}:${v.field}`)).toEqual([
      "header:messageId",
      "header:debtorCity",
      "BO-7-1:executionDate",
      "BO-7-2:creditorCity",
      "BO-7-3:reference",
    ]);
    input.messageId = "BO-12345678901234567890123"; // 26 characters: PmtInfId is exactly 35
    expect(checkPain001(input, profile, TODAY).map((v) => v.field)).not.toContain("messageId");
  });

  it("builds a default message that fits the method", () => {
    expect(defaultPaymentMessage("2026-118", 140)).toBe("Faktura 2026-118");
    expect(defaultPaymentMessage("INV-2026-000118", 12)).toBe("INV-2026-000");
  });
});

describe("pain.001 — övriga profiler (golden-filer)", () => {
  it("Handelsbanken: org.nr as BANK id, IBAN debit, plusgiro 9500, BBAN without clearing", async () => {
    const input = exampleInput({ initiatingPartyId: null, account: { kind: "iban", value: "SE4550000000058398257466" } });
    expect(checkPain001(input, BANK_PROFILES.handelsbanken, TODAY)).toEqual([]);
    const { xml } = buildPain001(input, BANK_PROFILES.handelsbanken);
    expect(xml).toContain("<InitgPty><Id><OrgId><Othr><Id>5566778899</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr></OrgId></Id></InitgPty>");
    expect(xml).toContain("<DbtrAcct><Id><IBAN>SE4550000000058398257466</IBAN></Id><Ccy>SEK</Ccy></DbtrAcct>");
    expect(xml).toContain("<BIC>HANDSESS</BIC>");
    expect(xml).toContain("<MmbId>9500</MmbId>");
    expect(xml).toContain("<MmbId>83279</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>");
    expect(xml).toContain("<Id>9941234123</Id><SchmeNm><Cd>BBAN</Cd>");
    expect(xml).toContain(`<CdtrAgt><FinInstnId><BIC>ESSESESS</BIC></FinInstnId></CdtrAgt><Cdtr><Nm>Exempelslipen AB</Nm>`);
    expect(xml).toContain(SWEDISH_IBAN_ACCOUNT);
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
    await expect(xml).toMatchFileSnapshot("./fixtures/iso20022/pain001-handelsbanken.xml");
  });

  it("SEB (overifierad): BANK id, clearing included in the BBAN", async () => {
    const input = exampleInput({ initiatingPartyId: "1234567890", account: { kind: "iban", value: "SE4550000000058398257466" } });
    expect(checkPain001(input, BANK_PROFILES.seb, TODAY)).toEqual([]);
    const { xml } = buildPain001(input, BANK_PROFILES.seb);
    expect(xml).toContain("<BIC>ESSESESS</BIC>");
    expect(xml).toContain("<MmbId>9960</MmbId>");
    expect(xml).toContain("<Id>832799941234123</Id>");
    expect(xml).toContain(SWEDISH_IBAN_ACCOUNT);
    expect(BANK_PROFILES.seb.verified).toBe(false);
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
    await expect(xml).toMatchFileSnapshot("./fixtures/iso20022/pain001-seb.xml");
  });

  it("Nordea: CUST signer id, CCM agreement as debtor id, BIC agents, country-only addresses", async () => {
    const input = exampleInput({ initiatingPartyId: "1234567890123", agreementId: "CCM12345", account: { kind: "iban", value: "SE4550000000058398257466" } });
    expect(checkPain001(input, BANK_PROFILES.nordea, TODAY)).toEqual([]);
    const { xml } = buildPain001(input, BANK_PROFILES.nordea);
    expect(xml).toContain("<Othr><Id>1234567890123</Id><SchmeNm><Cd>CUST</Cd></SchmeNm></Othr>");
    expect(xml).toContain("<Id><OrgId><Othr><Id>CCM12345</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr></OrgId></Id></Dbtr>");
    expect(xml).toContain("<CdtrAgt><FinInstnId><BIC>BGABSESS</BIC></FinInstnId></CdtrAgt>");
    expect(xml).toContain("<CdtrAgt><FinInstnId><BIC>NDEASESS</BIC></FinInstnId></CdtrAgt>");
    expect(xml).toContain("<CdtrAgt><FinInstnId><BIC>ESSESESS</BIC></FinInstnId></CdtrAgt>");
    expect(xml).toContain(SWEDISH_IBAN_ACCOUNT);
    expect(xml).not.toContain("<TwnNm>");
    expect(xml).toMatch(/<EndToEndId>BO-7-3<\/EndToEndId><\/PmtId><Amt><InstdAmt Ccy="SEK">8850\.00<\/InstdAmt><\/Amt><Cdtr>/);
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
    await expect(xml).toMatchFileSnapshot("./fixtures/iso20022/pain001-nordea.xml");
  });
});

describe("pain.001 — snapshot", () => {
  // The snapshot records what was SENT: the sanitized town, or null when the
  // profile writes no TwnNm (Nordea).
  it("stores the town as written in TwnNm, null when the profile sends none", () => {
    const input = exampleInput({ initiatingPartyId: "1234567890123", account: { kind: "iban", value: "SE4550000000058398257466" } });
    input.items[3]!.creditor.city = "Gävle & Sandviken";
    const sent = (profile: (typeof BANK_PROFILES)[keyof typeof BANK_PROFILES]) =>
      buildPain001(input, profile).items.find((i) => i.endToEndId === "BO-7-4")!.snapshot.city;
    expect(sent(BANK_PROFILES.swedbank)).toBe("Gävle och Sandviken");
    expect(sent(BANK_PROFILES.seb)).toBe("Gävle och Sandviken");
    expect(sent(BANK_PROFILES.nordea)).toBeNull();
  });
});

describe("sanitizeText", () => {
  it("keeps åäö and the bank's Latin set", () => {
    expect(sanitizeText("Åsa Öberg-Ängström (AB) 12/3", BANK_PROFILES.swedbank, 70)).toEqual({
      value: "Åsa Öberg-Ängström (AB) 12/3", changed: false, truncated: false,
    });
  });

  it("composes a decomposed å and drops accents", () => {
    expect(sanitizeText("Ångström Müller", BANK_PROFILES.swedbank, 70)).toEqual({
      value: "Ångström Muller", changed: true, truncated: false,
    });
  });
});

describe("banking dates (Stockholm)", () => {
  it("formats in Stockholm time, midnight as 00", () => {
    expect(stockholmDateTime(new Date("2026-10-09T12:05:12Z"))).toBe("2026-10-09T14:05:12");
    expect(stockholmDateTime(new Date("2026-10-08T22:00:00Z"))).toBe("2026-10-09T00:00:00");
    expect(stockholmDate(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(addDays("2026-10-09", 365)).toBe("2027-10-09");
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
  });
});
