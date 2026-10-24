import { describe, expect, it } from "vitest";
import { VAT_BOXES, type VatDeclarationBoxes } from "@navet/shared";
import {
  VAT_FILE_ELEMENTS,
  buildVatDeclarationFile,
  formatVatFileOrgNumber,
  vatFilePeriod,
} from "../src/modules/economy/service/vat-file.js";

// Skatteverket, "Lämna momsdeklaration via fil i e-tjänsten", exempel 6 —
// without its TextUpplysningMoms row (Nav does not send a free-text note).
const EXAMPLE_6 = `<?xml version="1.0" encoding="ISO-8859-1"?>
<eSKDUpload Version="6.0">
<OrgNr>556000-0175</OrgNr>
<Moms>
<Period>202401</Period>
<ForsMomsEjAnnan>100000</ForsMomsEjAnnan>
<UttagMoms>200000</UttagMoms>
<UlagMargbesk>300000</UlagMargbesk>
<HyrinkomstFriv>400000</HyrinkomstFriv>
<InkopVaruAnnatEg>5000</InkopVaruAnnatEg>
<InkopTjanstAnnatEg>6000</InkopTjanstAnnatEg>
<InkopTjanstUtomEg>7000</InkopTjanstUtomEg>
<InkopVaruSverige>8000</InkopVaruSverige>
<InkopTjanstSverige>9000</InkopTjanstSverige>
<MomsUlagImport>10000</MomsUlagImport>
<ForsVaruAnnatEg>11000</ForsVaruAnnatEg>
<ForsVaruUtomEg>12000</ForsVaruUtomEg>
<InkopVaruMellan3p>13000</InkopVaruMellan3p>
<ForsVaruMellan3p>14000</ForsVaruMellan3p>
<ForsTjSkskAnnatEg>15000</ForsTjSkskAnnatEg>
<ForsTjOvrUtomEg>16000</ForsTjOvrUtomEg>
<ForsKopareSkskSverige>17000</ForsKopareSkskSverige>
<ForsOvrigt>18000</ForsOvrigt>
<MomsUtgHog>200000</MomsUtgHog>
<MomsUtgMedel>15000</MomsUtgMedel>
<MomsUtgLag>5000</MomsUtgLag>
<MomsInkopUtgHog>2500</MomsInkopUtgHog>
<MomsInkopUtgMedel>1000</MomsInkopUtgMedel>
<MomsInkopUtgLag>500</MomsInkopUtgLag>
<MomsImportUtgHog>2000</MomsImportUtgHog>
<MomsImportUtgMedel>350</MomsImportUtgMedel>
<MomsImportUtgLag>150</MomsImportUtgLag>
<MomsIngAvdr>1000</MomsIngAvdr>
<MomsBetala>225500</MomsBetala>
</Moms>
</eSKDUpload>`;

const EXAMPLE_BOXES: VatDeclarationBoxes = {
  "05": 100000,
  "06": 200000,
  "07": 300000,
  "08": 400000,
  "10": 200000,
  "11": 15000,
  "12": 5000,
  "20": 5000,
  "21": 6000,
  "22": 7000,
  "23": 8000,
  "24": 9000,
  "30": 2500,
  "31": 1000,
  "32": 500,
  "35": 11000,
  "36": 12000,
  "37": 13000,
  "38": 14000,
  "39": 15000,
  "40": 16000,
  "41": 17000,
  "42": 18000,
  "48": 1000,
  "50": 10000,
  "60": 2000,
  "61": 350,
  "62": 150,
  "49": 225500,
};

const zeroBoxes = (): VatDeclarationBoxes =>
  Object.fromEntries([...VAT_BOXES, "49"].map((box) => [box, 0])) as VatDeclarationBoxes;

describe("momsdeklaration som fil (eSKDUpload 6.0)", () => {
  it("reproduces Skatteverket's example 6 byte for byte", () => {
    const file = buildVatDeclarationFile({ orgNumber: "556000-0175", period: "202401", boxes: EXAMPLE_BOXES });
    expect(file.equals(Buffer.from(EXAMPLE_6, "latin1"))).toBe(true);
  });

  it("names every box of the declaration exactly once", () => {
    expect(VAT_FILE_ELEMENTS.map(([box]) => box).sort()).toEqual([...VAT_BOXES, "49"].sort());
    expect(new Set(VAT_FILE_ELEMENTS.map(([, element]) => element)).size).toBe(VAT_FILE_ELEMENTS.length);
  });

  it("leaves out empty boxes but always writes MomsBetala, with a leading minus when negative", () => {
    const boxes = { ...zeroBoxes(), "10": 100, "48": 400, "49": -300 };
    const text = buildVatDeclarationFile({ orgNumber: "556000-0175", period: "202403", boxes }).toString("latin1");
    expect(text).toContain("<MomsUtgHog>100</MomsUtgHog>\n<MomsIngAvdr>400</MomsIngAvdr>\n<MomsBetala>-300</MomsBetala>");
    expect(text).not.toContain("ForsMomsEjAnnan");
    expect(text).not.toMatch(/[ \t]</);

    const empty = buildVatDeclarationFile({ orgNumber: "556000-0175", period: "202403", boxes: zeroBoxes() }).toString("latin1");
    expect(empty).toContain("<Period>202403</Period>\n<MomsBetala>0</MomsBetala>\n</Moms>");
  });

  it("writes a negative ruta 07 as 0 (and so leaves it out)", () => {
    const boxes = { ...zeroBoxes(), "07": -500, "05": 100 };
    const text = buildVatDeclarationFile({ orgNumber: "556000-0175", period: "202403", boxes }).toString("latin1");
    expect(text).not.toContain("UlagMargbesk");
    expect(text).toContain("<ForsMomsEjAnnan>100</ForsMomsEjAnnan>");
  });

  it("refuses öre amounts — the caller must round first", () => {
    expect(() =>
      buildVatDeclarationFile({ orgNumber: "556000-0175", period: "202403", boxes: { ...zeroBoxes(), "10": 1.5 } })
    ).toThrow();
  });

  it("formats the period as the last month and the organisationsnummer with its hyphen", () => {
    expect(vatFilePeriod("2024-01-31")).toBe("202401");
    expect(vatFilePeriod("2024-03-31")).toBe("202403");
    expect(vatFilePeriod("2024-12-31")).toBe("202412");
    expect(formatVatFileOrgNumber("5560000175")).toBe("556000-0175");
    expect(formatVatFileOrgNumber("556000-0175")).toBe("556000-0175");
    expect(formatVatFileOrgNumber("16556000-0175")).toBe("556000-0175");
    expect(formatVatFileOrgNumber("195001011234")).toBe("500101-1234");
    expect(formatVatFileOrgNumber("55600")).toBeNull();
    expect(formatVatFileOrgNumber(null)).toBeNull();
  });
});
