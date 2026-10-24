import { describe, expect, it } from "vitest";
import {
  EEA_COUNTRY_CODES,
  SEPA_COUNTRY_CODES,
  exceedsPaymentReportingThreshold,
  isForeignPayee,
  isSepaCountry,
  normalizeSupplierPaymentDetails,
  paymentKind,
  supplierPaymentDetailsProblems,
  type SupplierPaymentDetails,
} from "@navet/shared";
import { BANK_PROFILES, type BankProfile } from "../src/modules/banking/service/iso20022/bank-profiles.js";
import { buildPain001, defaultPaymentMessage, paymentGroups, type Pain001Input } from "../src/modules/banking/service/iso20022/pain001-builder.js";
import { checkPain001 } from "../src/modules/banking/service/iso20022/pain001-check.js";
import { sanitizeText } from "../src/modules/banking/service/iso20022/sanitize.js";
import { reportingDecision } from "../src/modules/banking/service/payment-batch.service.js";
import { validateAgainstXsd } from "./helpers/xsd.js";

// Valuta steg 2 — utlandsbetalningar i betalfilen (spec §4). Pure: the
// betalningstyp, the supplier's foreign details, the transliteration, the
// KU81 threshold and the builder/check per profile with golden files.

const TODAY = "2026-10-09";

describe("betalningstyp (paymentKind)", () => {
  it("domestic = SEK to a Swedish account, sepa = EUR to an IBAN in the SEPA area, international = everything else", () => {
    expect(paymentKind({ currency: "SEK", method: "bankgiro", iban: null })).toBe("domestic");
    expect(paymentKind({ currency: "SEK", method: "plusgiro", iban: null })).toBe("domestic");
    expect(paymentKind({ currency: "SEK", method: "bank_account", iban: null })).toBe("domestic");
    expect(paymentKind({ currency: "SEK", method: "iban", iban: "SE3550000000054910000003" })).toBe("domestic");
    expect(paymentKind({ currency: "EUR", method: "iban", iban: "DE89370400440532013000" })).toBe("sepa");
    // EUR to a Swedish IBAN is SEPA too (SE is in the area).
    expect(paymentKind({ currency: "EUR", method: "iban", iban: "SE3550000000054910000003" })).toBe("sepa");
    expect(paymentKind({ currency: "EUR", method: "iban", iban: "GB29NWBK60161331926819" })).toBe("sepa");
    expect(paymentKind({ currency: "eur", method: "iban", iban: "CH9300762011623852957" })).toBe("sepa");
    // SEK to a foreign account, another currency than EUR, a foreign account number.
    expect(paymentKind({ currency: "SEK", method: "iban", iban: "DK5000400440116243" })).toBe("international");
    expect(paymentKind({ currency: "GBP", method: "iban", iban: "GB29NWBK60161331926819" })).toBe("international");
    expect(paymentKind({ currency: "DKK", method: "iban", iban: "DK5000400440116243" })).toBe("international");
    expect(paymentKind({ currency: "EUR", method: "foreign_account", iban: null })).toBe("international");
    expect(paymentKind({ currency: "USD", method: "foreign_account", iban: null })).toBe("international");
    // A Swedish giro in another currency: international (the check refuses it).
    expect(paymentKind({ currency: "EUR", method: "bankgiro", iban: null })).toBe("international");
  });

  it("knows the SEPA area (EPC409-09) and the EEA", () => {
    for (const country of ["SE", "DE", "FI", "NO", "IS", "LI", "CH", "GB", "MC", "SM", "VA", "AD", "GI", "AX", "JE", "re"]) expect(isSepaCountry(country)).toBe(true);
    for (const country of ["US", "CA", "AU", "TR", "RS", "AL", "CN"]) expect(isSepaCountry(country)).toBe(false);
    expect(new Set(SEPA_COUNTRY_CODES).size).toBe(SEPA_COUNTRY_CODES.length);
    expect(EEA_COUNTRY_CODES).toHaveLength(30);
    expect(EEA_COUNTRY_CODES).not.toContain("CH");
  });

  it("a foreign payee is an IBAN abroad or a foreign account number", () => {
    expect(isForeignPayee("iban", "DE89370400440532013000")).toBe(true);
    expect(isForeignPayee("foreign_account", null)).toBe(true);
    expect(isForeignPayee("iban", "SE3550000000054910000003")).toBe(false);
    expect(isForeignPayee("bankgiro", null)).toBe(false);
    expect(isForeignPayee(null, null)).toBe(false);
  });
});

const NONE: SupplierPaymentDetails = {
  paymentMethod: null,
  bankgiro: null,
  plusgiro: null,
  bankClearing: null,
  bankAccountNumber: null,
  iban: null,
  bic: null,
  foreignAccountNumber: null,
  clearingSystem: null,
  clearingMemberId: null,
  bankName: null,
  chargeBearer: "SHAR",
  paymentReportingCode: "101",
};
const ABROAD = { country: "US", address: "400 Harbor Drive", city: "Chicago" };

describe("leverantörens uppgifter för utlandsbetalning", () => {
  it("normalizes the foreign account number and the bank id", () => {
    expect(normalizeSupplierPaymentDetails({ foreignAccountNumber: " 1234-5678 90ab ", clearingSystem: "usaba", clearingMemberId: "0210 000 21", bankName: "  " })).toEqual({
      foreignAccountNumber: "1234567890AB",
      clearingSystem: "USABA",
      clearingMemberId: "021000021",
      bankName: null,
    });
  });

  it("takes every country's IBAN — BIC optional inside SEPA, required outside", () => {
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "iban", iban: "DE89370400440532013000" }, { country: "DE", address: "Hauptstr. 5", city: "Berlin" })).toEqual({});
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "iban", iban: "TR330006100519786457841326" }, { country: "TR", address: "Cad. 1", city: "Istanbul" })).toEqual({
      bic: "BIC krävs för IBAN utanför SEPA-området",
    });
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "iban", iban: "TR330006100519786457841326", bic: "TGBATRIS" }, { country: "TR", address: "Cad. 1", city: "Istanbul" })).toEqual({});
  });

  it("a foreign account number needs the account, a BIC or a bank id, a country outside Sweden and SEPA", () => {
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "foreign_account" }, ABROAD)).toEqual({
      foreignAccountNumber: "Kontonummer saknas",
      bic: "Ange BIC eller bank-id (t.ex. ABA routing number)",
    });
    expect(
      supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "foreign_account", foreignAccountNumber: "123456789012", clearingSystem: "USABA", clearingMemberId: "123456780" }, ABROAD)
    ).toEqual({});
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "foreign_account", foreignAccountNumber: "123456789012", bic: "EXBKUS33" }, { ...ABROAD, country: "SE" })).toEqual({
      country: "Ett utländskt kontonummer kräver att leverantörens land inte är Sverige",
    });
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "foreign_account", foreignAccountNumber: "123456789012", bic: "EXBKGB2L" }, { ...ABROAD, country: "GB" })).toEqual({
      paymentMethod: "Mottagare i SEPA-området betalas med IBAN",
    });
  });

  it("checks the bank id against its clearing system and keeps the pair together", () => {
    const base = { ...NONE, paymentMethod: "foreign_account" as const, foreignAccountNumber: "123456789012" };
    expect(supplierPaymentDetailsProblems({ ...base, clearingSystem: "USABA", clearingMemberId: "12345" }, ABROAD)).toEqual({ clearingMemberId: "Bank-id:t har fel format för USABA" });
    expect(supplierPaymentDetailsProblems({ ...base, clearingSystem: "XXABC", clearingMemberId: "1" }, ABROAD)).toEqual({
      clearingSystem: "Bank-id-typen ska vara en av USABA, CACPA, AUBSB, GBDSC, HKNCC, INFSC, NZNCC, ZANCC, CNAPS",
    });
    expect(supplierPaymentDetailsProblems({ ...base, clearingSystem: "CACPA" }, { ...ABROAD, country: "CA" })).toEqual({ clearingMemberId: "Bank-id saknas" });
    expect(supplierPaymentDetailsProblems({ ...base, bic: "EXBKUS33", clearingMemberId: "123456780" }, ABROAD)).toEqual({ clearingSystem: "Ange vilken typ av bank-id det är" });
    expect(supplierPaymentDetailsProblems({ ...base, clearingSystem: "INFSC", clearingMemberId: "HDFC0000123" }, { ...ABROAD, country: "IN" })).toEqual({});
  });

  it("a payee abroad needs street and town; avgiftsfördelning and betalningskod are checked", () => {
    const iban = { ...NONE, paymentMethod: "iban" as const, iban: "DE89370400440532013000" };
    expect(supplierPaymentDetailsProblems(iban, { country: "DE", address: null, city: " " })).toEqual({
      address: "Gatuadress krävs för en utländsk mottagare",
      city: "Ort krävs för en utländsk mottagare",
    });
    // A Swedish payee needs neither (as before).
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "bankgiro", bankgiro: "50501055" }, { country: "SE", address: null, city: null })).toEqual({});
    expect(supplierPaymentDetailsProblems({ ...NONE, chargeBearer: "CRED" as never, paymentReportingCode: "1010" })).toEqual({
      chargeBearer: "Avgiftsfördelningen ska vara SHAR eller DEBT",
      paymentReportingCode: "Betalningskoden ska vara tre siffror (Skatteverkets betalningskod)",
    });
  });
});

describe("teckenmängd för utlandsbetalningar (transliteration)", () => {
  const foreign = (profile: BankProfile) => ({ charset: profile.foreign.charset });

  it("å/ä/æ → a, ö/ø → o, ü → u, ß → ss, & → and — in every profile", () => {
    for (const profile of Object.values(BANK_PROFILES)) {
      expect(sanitizeText("Åsa Bäck & Søren Mølle, Müller Straße", foreign(profile), 140).value).toBe("Asa Back and Soren Molle, Muller Strasse");
      expect(sanitizeText("ÆØÅ ÄÖÜ æøå", foreign(profile), 140).value).toBe("AOA AOU aoa");
      expect(sanitizeText("Café <Société> 😀", foreign(profile), 140)).toEqual({ value: "Cafe Societe", changed: true, truncated: false });
    }
  });

  it("leaves the domestic set alone: åäö kept, & → och", () => {
    expect(sanitizeText("Åsa & Söner", BANK_PROFILES.swedbank, 70).value).toBe("Åsa och Söner");
  });

  it("writes Nav's default message in English abroad", () => {
    expect(defaultPaymentMessage("2026-311", 140, "sepa")).toBe("Invoice 2026-311");
    expect(defaultPaymentMessage("2026-311", 140, "domestic")).toBe("Faktura 2026-311");
    expect(defaultPaymentMessage("2026-311", 140)).toBe("Faktura 2026-311");
  });
});

describe("rapportering till Skatteverket (KU81)", () => {
  const rates = new Map([["EUR", { rate: 11.131, date: "2026-10-09" }]]);

  it("reports a payment abroad above 150 000 kr — not at exactly 150 000", () => {
    expect(exceedsPaymentReportingThreshold(150_000)).toBe(false);
    expect(exceedsPaymentReportingThreshold(150_000.01)).toBe(true);
    expect(reportingDecision({ amount: 150_000, currency: "SEK" }, "international", "101", rates)).toBeNull();
    expect(reportingDecision({ amount: 150_000.01, currency: "SEK" }, "international", "101", rates)).toEqual({ code: "101", amountSek: 150_000.01, rate: 1, rateDate: null });
  });

  it("values another currency at today's rate (toSek)", () => {
    // 13 476 EUR × 11.131 = 150 001.36 kr; 13 475 EUR = 149 990.23 kr.
    expect(reportingDecision({ amount: 13_476, currency: "EUR" }, "sepa", "130", rates)).toEqual({ code: "130", amountSek: 150_001.36, rate: 11.131, rateDate: "2026-10-09" });
    expect(reportingDecision({ amount: 13_475, currency: "EUR" }, "sepa", "101", rates)).toBeNull();
  });

  it("reports when no rate can be found (the safe side), never a domestic payment", () => {
    expect(reportingDecision({ amount: 10, currency: "AED" }, "international", "101", new Map([["AED", null]]))).toEqual({ code: "101", amountSek: null, rate: null, rateDate: null });
    expect(reportingDecision({ amount: 10, currency: "USD" }, "international", "101", rates)).toEqual({ code: "101", amountSek: null, rate: null, rateDate: null });
    expect(reportingDecision({ amount: 1_000_000, currency: "SEK" }, "domestic", "101", rates)).toBeNull();
    expect(reportingDecision({ amount: 1_000_000, currency: "SEK" }, null, "101", rates)).toBeNull();
  });
});

// The worked example abroad: one domestic payment and four abroad — SEPA
// (EUR to Germany), international IBAN + BIC (GBP to the UK), a US account
// with an ABA routing number (USD, DEBT) and SEK to Denmark above the KU81
// threshold. Every profile gets its own golden file.
function foreignInput(overrides: { profile?: BankProfile; usBic?: string | null } = {}): Pain001Input {
  const swedbank = overrides.profile?.id === "swedbank";
  return {
    messageId: "BO-9",
    createdAt: new Date("2026-10-09T12:05:12Z"),
    debtor: {
      name: "Exempel Verkstad AB",
      orgNumber: "556677-8899",
      postalCode: "802 22",
      city: "Gävle",
      account: swedbank ? { kind: "bankgiro", value: "5512348" } : { kind: "iban", value: "SE4550000000058398257466" },
      foreignAccount: { kind: "iban", value: "SE4550000000058398257466" },
      initiatingPartyId: swedbank ? "123456789123B001" : overrides.profile?.id === "nordea" ? "1234567890123" : "1234567890",
      agreementId: null,
    },
    items: [
      {
        endToEndId: "BO-9-1",
        amount: 1250,
        currency: "EUR",
        executionDate: "2026-10-15",
        creditor: {
          name: "Müller & Söhne GmbH",
          street: "Hauptstraße 5",
          postalCode: "10115",
          city: "Berlin",
          country: "DE",
          method: "iban",
          bankgiro: null,
          plusgiro: null,
          clearing: null,
          account: null,
          iban: "DE89370400440532013000",
          bic: "COBADEFF",
        },
        reference: { kind: "message", value: "Rechnung 2026-311" },
        regulatoryReportingCode: null,
      },
      {
        endToEndId: "BO-9-2",
        amount: 3400,
        currency: "GBP",
        executionDate: "2026-10-15",
        creditor: {
          name: "Fenwick & Hale Ltd",
          street: "12 Wharf Road",
          postalCode: "N1 7GU",
          city: "London",
          country: "GB",
          method: "iban",
          bankgiro: null,
          plusgiro: null,
          clearing: null,
          account: null,
          iban: "GB29NWBK60161331926819",
          bic: "NWBKGB2L",
          chargeBearer: "SHAR",
        },
        reference: { kind: "message", value: "Invoice FH-7781", generated: true },
        regulatoryReportingCode: null,
      },
      {
        endToEndId: "BO-9-3",
        amount: 980,
        currency: "USD",
        executionDate: "2026-10-15",
        creditor: {
          name: "Lakeside Tooling Inc.",
          street: "400 Harbor Drive",
          postalCode: "60601",
          city: "Chicago",
          country: "US",
          method: "foreign_account",
          bankgiro: null,
          plusgiro: null,
          clearing: null,
          account: null,
          iban: null,
          bic: overrides.usBic === undefined ? null : overrides.usBic,
          foreignAccount: "123456789012",
          clearingSystem: "USABA",
          clearingMemberId: "123456780",
          bankName: "Example Bank N.A.",
          chargeBearer: "DEBT",
        },
        reference: { kind: "message", value: "Invoice LT-2209" },
        regulatoryReportingCode: null,
      },
      {
        endToEndId: "BO-9-4",
        amount: 175000,
        currency: "SEK",
        executionDate: "2026-10-15",
        creditor: {
          name: "Øresund Stål ApS",
          street: "Søndergade 14",
          postalCode: "8000",
          city: "Aarhus C",
          country: "DK",
          method: "iban",
          bankgiro: null,
          plusgiro: null,
          clearing: null,
          account: null,
          iban: "DK5000400440116243",
          bic: "DABADKKK",
          chargeBearer: "SHAR",
        },
        reference: { kind: "message", value: "Faktura 4471 – stålbalk" },
        regulatoryReportingCode: "101",
      },
      {
        endToEndId: "BO-9-5",
        amount: 12500,
        executionDate: "2026-10-15",
        creditor: { name: "Plåtlagret AB", postalCode: "753 20", city: "Uppsala", method: "bankgiro", bankgiro: "50501055", plusgiro: null, clearing: null, account: null, iban: null, bic: null },
        reference: { kind: "ocr", value: "4605127" },
      },
    ],
  };
}

const GOLDEN: Record<BankProfile["id"], { usBic?: string | null }> = {
  swedbank: {},
  handelsbanken: {},
  nordea: {},
  // SEB: "Creditor Agent BIC is required by SEB" abroad.
  seb: { usBic: "EXBKUS33" },
};

describe("pain.001 — utlandsbetalningar per profil (golden-filer)", () => {
  it("groups PmtInf per date, kind and avgiftsfördelning: domestic, SEPA (SLEV), international SHAR, international DEBT", () => {
    const groups = paymentGroups(foreignInput().items).map((g) => [g.kind, g.chargeBearer, g.items.map((i) => i.endToEndId)]);
    expect(groups).toEqual([
      ["domestic", null, ["BO-9-5"]],
      ["sepa", "SLEV", ["BO-9-1"]],
      ["international", "SHAR", ["BO-9-2", "BO-9-4"]],
      ["international", "DEBT", ["BO-9-3"]],
    ]);
  });

  it.each(Object.keys(GOLDEN) as BankProfile["id"][])("%s: passes the check, is XSD-valid and matches its golden file", async (id) => {
    const profile = BANK_PROFILES[id];
    const input = foreignInput({ profile, ...GOLDEN[id] });
    expect(checkPain001(input, profile, TODAY)).toEqual([]);
    const { xml, items } = buildPain001(input, profile);
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
    await expect(xml).toMatchFileSnapshot(`./fixtures/iso20022/pain001-${id}-foreign.xml`);

    // Common to every bank: the PmtInfIds, InstdAmt in the invoice's
    // currency, SLEV on SEPA, the payee's structured address, IBAN-only in
    // SEPA, BBAN + bank id outside the IBAN world, transliteration.
    expect(xml).toContain("<PmtInfId>BO-9-20261015</PmtInfId>");
    expect(xml).toContain("<PmtInfId>BO-9-20261015S</PmtInfId>");
    expect(xml).toContain("<PmtInfId>BO-9-20261015I</PmtInfId>");
    expect(xml).toContain("<PmtInfId>BO-9-20261015D</PmtInfId>");
    expect(xml).toContain('<InstdAmt Ccy="EUR">1250.00</InstdAmt>');
    expect(xml).toContain('<InstdAmt Ccy="GBP">3400.00</InstdAmt>');
    expect(xml).toContain('<InstdAmt Ccy="USD">980.00</InstdAmt>');
    expect(xml).toContain('<InstdAmt Ccy="SEK">175000.00</InstdAmt>');
    expect(xml).toContain("<ChrgBr>SLEV</ChrgBr>");
    expect(xml).toContain("<ChrgBr>SHAR</ChrgBr>");
    expect(xml).toContain("<ChrgBr>DEBT</ChrgBr>");
    expect(xml).toContain(
      "<Cdtr><Nm>Muller and Sohne GmbH</Nm><PstlAdr><StrtNm>Hauptstrasse 5</StrtNm><PstCd>10115</PstCd><TwnNm>Berlin</TwnNm><Ctry>DE</Ctry></PstlAdr></Cdtr><CdtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></CdtrAcct>"
    );
    // SEPA: no creditor agent even though the supplier has a BIC.
    expect(xml).toMatch(/<InstdAmt Ccy="EUR">1250\.00<\/InstdAmt><\/Amt><Cdtr>/);
    expect(xml).toContain("<CdtrAgt><FinInstnId><BIC>NWBKGB2L</BIC></FinInstnId></CdtrAgt>");
    expect(xml).toContain("<CdtrAcct><Id><Othr><Id>123456789012</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id></CdtrAcct>");
    expect(xml).toContain("<ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>123456780</MmbId></ClrSysMmbId>");
    expect(xml).toContain("<Nm>Oresund Stal ApS</Nm><PstlAdr><StrtNm>Sondergade 14</StrtNm><PstCd>8000</PstCd><TwnNm>Aarhus C</TwnNm><Ctry>DK</Ctry></PstlAdr>");
    expect(xml).toContain("<Ustrd>Faktura 4471 stalbalk</Ustrd>");
    // The domestic payment keeps åäö and its own PmtInf as before.
    expect(xml).toContain("<Cdtr><Nm>Plåtlagret AB</Nm>");
    // KU81 on BO-9-4 only, in RgltryRptg between Cdtr/CdtrAcct and RmtInf.
    expect(xml.match(/<RgltryRptg>/g)).toHaveLength(1);
    expect(xml).toMatch(/<IBAN>DK5000400440116243<\/IBAN><\/Id><\/CdtrAcct><RgltryRptg>.*<\/RgltryRptg><RmtInf>/);

    const snapshot = items.find((i) => i.endToEndId === "BO-9-3")!.snapshot;
    expect(snapshot).toMatchObject({ method: "foreign_account", account: "123456789012", kind: "international", currency: "USD", country: "US", clearingSystem: "USABA", clearing: "123456780", chargeBearer: "DEBT", street: "400 Harbor Drive" });
    expect(items.find((i) => i.endToEndId === "BO-9-1")!.snapshot).toMatchObject({ kind: "sepa", currency: "EUR", bic: null, chargeBearer: "SLEV", name: "Muller and Sohne GmbH" });
    expect(items.find((i) => i.endToEndId === "BO-9-4")!.snapshot.regulatoryReporting).toEqual({ code: "101", amountSek: null, rate: null, rateDate: null });
    expect(items.find((i) => i.endToEndId === "BO-9-1")!.warnings).toEqual([
      'Mottagarens namn skickas som "Muller and Sohne GmbH"',
      'Mottagarens gatuadress skickas som "Hauptstrasse 5"',
    ]);
  });

  it("Swedbank: SEPA as SvcLvl SEPA, international NURG + IN, the bankgiro for domestic and the IBAN abroad, KU81 as Dtls/Cd", () => {
    const { xml } = buildPain001(foreignInput({ profile: BANK_PROFILES.swedbank }), BANK_PROFILES.swedbank);
    expect(xml).toContain("<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>");
    expect(xml).toContain("<PmtTpInf><SvcLvl><Cd>NURG</Cd></SvcLvl><LclInstrm><Cd>IN</Cd></LclInstrm><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>");
    expect(xml).toContain("<DbtrAcct><Id><Othr><Id>5512348</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr></Id><Ccy>SEK</Ccy></DbtrAcct>");
    expect(xml).toContain("<DbtrAcct><Id><IBAN>SE4550000000058398257466</IBAN></Id><Ccy>SEK</Ccy></DbtrAcct>");
    expect(xml).toContain("<RgltryRptg><Dtls><Cd>101</Cd></Dtls></RgltryRptg>");
    // No name with a bare bank id (the profile does not ask for it).
    expect(xml).not.toContain("<Nm>Example Bank N.A.</Nm>");
  });

  it("Handelsbanken: SEPA as NURG (the bank classifies), no IN", () => {
    const { xml } = buildPain001(foreignInput({ profile: BANK_PROFILES.handelsbanken }), BANK_PROFILES.handelsbanken);
    expect(xml).not.toContain("<Cd>SEPA</Cd>");
    expect(xml).not.toContain("<LclInstrm>");
    expect(xml).toContain("<RgltryRptg><Dtls><Cd>101</Cd></Dtls></RgltryRptg>");
  });

  it("Nordea: NURG + IN for SEPA and international, KU81 with Ctry and Inf, the bank's name and country next to a bare ABA number", () => {
    const { xml } = buildPain001(foreignInput({ profile: BANK_PROFILES.nordea }), BANK_PROFILES.nordea);
    expect(xml).not.toContain("<Cd>SEPA</Cd>");
    expect(xml.match(/<LclInstrm><Cd>IN<\/Cd><\/LclInstrm>/g)).toHaveLength(3);
    expect(xml).toContain("<RgltryRptg><Dtls><Ctry>SE</Ctry><Cd>101</Cd><Inf>Faktura 4471 stalbalk</Inf></Dtls></RgltryRptg>");
    expect(xml).toContain(
      "<CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>123456780</MmbId></ClrSysMmbId><Nm>Example Bank N.A.</Nm><PstlAdr><Ctry>US</Ctry></PstlAdr></FinInstnId></CdtrAgt>"
    );
  });

  it("SEB: SEPA without CtgyPurp, no IN, KU81 with DbtCdtRptgInd DEBT, BIC and bank id both sent", () => {
    const { xml } = buildPain001(foreignInput({ profile: BANK_PROFILES.seb, usBic: "EXBKUS33" }), BANK_PROFILES.seb);
    expect(xml).toContain("<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>");
    expect(xml).not.toContain("<LclInstrm>");
    expect(xml).toContain("<PmtTpInf><SvcLvl><Prtry>MPNS</Prtry></SvcLvl><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>");
    expect(xml).toContain("<RgltryRptg><DbtCdtRptgInd>DEBT</DbtCdtRptgInd><Dtls><Cd>101</Cd></Dtls></RgltryRptg>");
    expect(xml).toContain("<CdtrAgt><FinInstnId><BIC>EXBKUS33</BIC><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>123456780</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>");
  });
});

describe("pain.001 — kontrollen för utlandsbetalningar", () => {
  const fields = (input: Pain001Input, profile: BankProfile) => checkPain001(input, profile, TODAY).map((v) => `${v.endToEndId ?? "header"}:${v.field}`);
  const messages = (input: Pain001Input, profile: BankProfile, endToEndId: string) =>
    checkPain001(input, profile, TODAY)
      .filter((v) => v.endToEndId === endToEndId)
      .map((v) => v.message);

  it("needs a foreign debit account the profile takes (Swedbank: IBAN, not the bankgiro)", () => {
    const input = foreignInput({ profile: BANK_PROFILES.swedbank });
    input.debtor.foreignAccount = null;
    expect(checkPain001(input, BANK_PROFILES.swedbank, TODAY)).toEqual([
      { endToEndId: null, field: "debtorForeignAccount", message: "Swedbank kräver IBAN som debiteringskonto för utlandsbetalningar — lägg in det i Företagsinformation" },
    ]);
    input.debtor.foreignAccount = { kind: "bankgiro", value: "5512348" };
    expect(fields(input, BANK_PROFILES.swedbank)).toEqual(["header:debtorForeignAccount"]);
    input.debtor.foreignAccount = { kind: "iban", value: "NO9386011117947" };
    expect(checkPain001(input, BANK_PROFILES.swedbank, TODAY).map((v) => v.message)).toEqual(["Utlandskonto stöds inte som debiteringskonto — bara svenska IBAN (SE…)"]);
    // An all-domestic batch never asks for it.
    const domestic = foreignInput({ profile: BANK_PROFILES.swedbank });
    domestic.items = domestic.items.filter((i) => i.endToEndId === "BO-9-5");
    domestic.debtor.foreignAccount = null;
    expect(checkPain001(domestic, BANK_PROFILES.swedbank, TODAY)).toEqual([]);
  });

  it("gives a payment abroad one letter less for the MsgId (PmtInfId suffix)", () => {
    const input = foreignInput({ profile: BANK_PROFILES.handelsbanken });
    input.messageId = "BO-1234567890123456789012"; // 25
    expect(fields(input, BANK_PROFILES.handelsbanken)).toEqual([]);
    input.messageId = "BO-12345678901234567890123"; // 26
    expect(fields(input, BANK_PROFILES.handelsbanken)).toEqual(["header:messageId"]);
  });

  it("refuses a Swedish giro or account in another currency, a non-SEPA IBAN without BIC and OCR abroad", () => {
    const input = foreignInput({ profile: BANK_PROFILES.handelsbanken });
    input.items[4]!.currency = "EUR";
    input.items[4]!.reference = { kind: "message", value: "Invoice 1" };
    input.items[1]!.creditor = { ...input.items[1]!.creditor, iban: "TR330006100519786457841326", bic: null, country: "TR" };
    input.items[2]!.reference = { kind: "ocr", value: "4605127" };
    // The giro in EUR counts as a payment abroad, so it also lacks a street.
    expect(fields(input, BANK_PROFILES.handelsbanken)).toEqual(["BO-9-2:creditorAgent", "BO-9-3:reference", "BO-9-5:currency", "BO-9-5:creditorStreet"]);
    expect(messages(input, BANK_PROFILES.handelsbanken, "BO-9-5")).toEqual([
      "Bankgiro, plusgiro och svenska bankkonton tar bara emot SEK — leverantören behöver IBAN för en betalning i annan valuta",
      "Mottagarens gatuadress saknas (krävs för utlandsbetalningar)",
    ]);
  });

  it("checks a foreign account: account format, bank id the bank takes, its format, BIC or bank id, never Sweden", () => {
    const hb = BANK_PROFILES.handelsbanken;
    const input = foreignInput({ profile: hb });
    const us = input.items[2]!.creditor;
    us.foreignAccount = "12-34";
    us.clearingSystem = "GBDSC";
    us.clearingMemberId = "123456";
    expect(messages(input, hb, "BO-9-3")).toEqual(["Mottagarens kontonummer är ogiltigt", "Handelsbanken tar inte bank-id av typen GBDSC — ange mottagarbankens BIC"]);
    us.foreignAccount = "123456789012";
    us.clearingSystem = "USABA";
    us.clearingMemberId = "12345";
    expect(messages(input, hb, "BO-9-3")).toEqual(["Mottagarbankens USABA-nummer har fel format"]);
    us.clearingSystem = null;
    us.clearingMemberId = null;
    expect(messages(input, hb, "BO-9-3")).toEqual(["Mottagarbanken saknar BIC och bank-id"]);
    us.bic = "EXBKUS33";
    us.country = "SE";
    expect(messages(input, hb, "BO-9-3")).toEqual(["Ett utländskt kontonummer kräver att mottagarens land inte är Sverige"]);
  });

  it("Nordea: the bank's name with a bare bank id, name + street + town within 105 characters, DEBT only outside the EU/EEA", () => {
    const nordea = BANK_PROFILES.nordea;
    const input = foreignInput({ profile: nordea });
    input.items[2]!.creditor.bankName = null;
    expect(messages(input, nordea, "BO-9-3")).toEqual(["Nordea kräver mottagarbankens namn när banken bara anges med bank-id"]);
    input.items[2]!.creditor.bankName = "Example Bank N.A.";
    input.items[1]!.creditor.name = "A".repeat(70);
    input.items[1]!.creditor.street = "B".repeat(25);
    input.items[1]!.creditor.city = "C".repeat(10); // 70 + 25 + 10 = 105
    expect(messages(input, nordea, "BO-9-2")).toEqual([]);
    input.items[1]!.creditor.city = "C".repeat(11);
    expect(messages(input, nordea, "BO-9-2")).toEqual(["Nordea tar högst 105 tecken för mottagarens namn, gatuadress och ort tillsammans (nu 106)"]);
    // DEBT to a bank inside the EU/EEA (Denmark).
    const debt = foreignInput({ profile: nordea });
    debt.items[3]!.creditor.chargeBearer = "DEBT";
    expect(messages(debt, nordea, "BO-9-4")).toEqual(["Nordea tar inte avgiftsfördelningen DEBT till en bank inom EU/EES — välj delade avgifter (SHAR)"]);
    // The other banks take it.
    expect(messages({ ...debt, debtor: { ...debt.debtor, initiatingPartyId: null } }, BANK_PROFILES.handelsbanken, "BO-9-4")).toEqual([]);
  });

  it("SEB: an international payment needs the receiving bank's BIC", () => {
    const seb = BANK_PROFILES.seb;
    const input = foreignInput({ profile: seb });
    expect(messages(input, seb, "BO-9-3")).toEqual(["SEB kräver mottagarbankens BIC för utlandsbetalningar"]);
    input.items[3]!.creditor.bic = null; // SEK to Denmark is international, not SEPA
    expect(messages(input, seb, "BO-9-4")).toEqual(["SEB kräver mottagarbankens BIC för utlandsbetalningar"]);
    // SEPA stays IBAN-only.
    input.items[0]!.creditor.bic = null;
    expect(messages(input, seb, "BO-9-1")).toEqual([]);
  });

  it("needs the payee's street abroad (and the town where the bank wants it), a two-letter country and a three-digit betalningskod", () => {
    const swedbank = BANK_PROFILES.swedbank;
    const input = foreignInput({ profile: swedbank });
    input.items[0]!.creditor.street = "  ";
    input.items[0]!.creditor.city = null;
    input.items[1]!.creditor.country = "GBR";
    input.items[3]!.regulatoryReportingCode = "10";
    expect(fields(input, swedbank)).toEqual(["BO-9-1:creditorStreet", "BO-9-1:creditorCity", "BO-9-2:creditorCountry", "BO-9-4:regulatoryReporting"]);
    // SEB does not require the town (it fills NOTPROVIDED).
    const seb = foreignInput({ profile: BANK_PROFILES.seb, usBic: "EXBKUS33" });
    seb.items[0]!.creditor.city = null;
    expect(fields(seb, BANK_PROFILES.seb)).toEqual([]);
  });
});
