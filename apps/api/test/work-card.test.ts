import { describe, expect, it } from "vitest";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { pdfPageCount, pdfText } from "./helpers/pdf.js";

// Arbetskortet = the "Skriv ut TO (PDF)" printout. Company info is stubbed
// the same way document-footer.test.ts does it — the footer is not what these
// tests are about.
const fakeSystem = {
  getCompanyInfo: async () =>
    ({
      name: "Navet Verkstad AB",
      orgNumber: "556677-8899",
      address: "Verkstadsgatan 1",
      postalCode: "981 32",
      city: "Kiruna",
      phone: null,
      email: null,
      website: null,
      bankgiro: null,
      plusgiro: null,
      bankName: null,
      iban: null,
      bic: null,
      vatNumber: null,
      companySeat: "Kiruna",
      fSkatt: true,
    }) as never,
  getLogo: async () => null,
};

const pdf = createDocumentPdfService(fakeSystem);

function order(operations: {
  sequenceNo: number;
  comment?: string | null;
  printOnWorkCard?: boolean;
  description?: string | null;
  packingInstructions?: string | null;
  runTimePerUnit?: string;
  timeUnit?: "minutes_per_unit" | "units_per_hour" | "seconds_per_unit";
}[]) {
  return {
    orderNumber: "PO-2044",
    printedAt: new Date("2026-08-26T08:00:00Z"),
    articleNumber: "A-1",
    articleName: "Diskbänk 1200",
    quantity: "5",
    statusLabel: "Frisläppt",
    note: null,
    operations: operations.map((op) => ({
      sequenceNo: op.sequenceNo,
      workCenterName: "Svets",
      workCenterCode: "100",
      description: op.description ?? null,
      setupTime: "10",
      runTimePerUnit: op.runTimePerUnit ?? "2",
      timeUnit: op.timeUnit ?? "minutes_per_unit",
      estimatedTime: 20,
      comment: op.comment ?? null,
      printOnWorkCard: op.printOnWorkCard ?? false,
      packingInstructions: op.packingInstructions ?? null,
    })),
    materials: [],
  };
}

describe("arbetskortet — operationens Beskrivning", () => {
  it("prints the description in place of the resource name, keeping the code", async () => {
    const text = pdfText(await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, description: "Kapning" }])));
    expect(text).toContain("100 · Kapning");
    // The column header changed with it — the cell no longer names a resource.
    expect(text).toContain("Operation");
  });

  it("falls back to the resource name when the operation has no description", async () => {
    // A routing imported before the field existed must read exactly as before.
    const text = pdfText(await pdf.renderManufacturingOrder(order([{ sequenceNo: 10 }])));
    expect(text).toContain("100 · Svets");
  });
});

describe("arbetskortet — operationens Kommentar", () => {
  it("prints the comment under its operation row when the flag is set", async () => {
    const text = pdfText(
      await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, comment: "Kör med skyddsglasögon", printOnWorkCard: true }]))
    );
    expect(text).toContain("Kör med skyddsglasögon");
  });

  it("leaves the comment off the printout when the flag is not set", async () => {
    const text = pdfText(
      await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, comment: "Intern notering till beredaren" }]))
    );
    expect(text).toContain("Svets");
    expect(text).not.toContain("Intern notering till beredaren");
  });

  it("gives a long comment real vertical space instead of overprinting the next row", async () => {
    // A collision bug keeps everything on one page — the page count is the
    // cheapest proof that the wrapped text actually advanced y.
    const long = "Instruktion: ".concat("kontrollera måtten mot ritningen. ".repeat(40));
    const many = Array.from({ length: 12 }, (_, i) => ({
      sequenceNo: (i + 1) * 10,
      comment: long,
      printOnWorkCard: true,
    }));
    const buffer = await pdf.renderManufacturingOrder(order(many));
    expect(pdfPageCount(buffer)).toBeGreaterThan(1);
    expect(pdfText(buffer)).toContain("kontrollera måtten mot ritningen");
  });
});

describe("arbetskortet — operationens tidsenhet (min/st vs st/h)", () => {
  it("prints Stycktid as st/h when the operation's timeUnit is units_per_hour", async () => {
    // 8.5714 min/st = 7 st/h (the stored value is always minutes — see
    // packages/shared/src/units.ts's minutesPerUnitToUnitsPerHour).
    const text = pdfText(
      await pdf.renderManufacturingOrder(
        order([{ sequenceNo: 10, runTimePerUnit: "8.5714", timeUnit: "units_per_hour" }])
      )
    );
    expect(text).toContain("7 st/h");
    expect(text).not.toContain("7,00 st/h");
    expect(text).not.toContain("8,5714 min");
  });

  it("prints Stycktid in minutes for a default (minutes_per_unit) operation", async () => {
    const text = pdfText(await pdf.renderManufacturingOrder(order([{ sequenceNo: 10 }])));
    expect(text).toContain("2 min");
  });

  it("prints the times with at most two decimals and no trailing zeros", async () => {
    // Ställtid 10, Beräknat 20 (the fixture) and Stycktid 8,5714 — a real
    // card showed "6,0000 min", and four decimals were too many to read.
    const text = pdfText(await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, runTimePerUnit: "8.5714" }])));
    expect(text).toContain("10 min");
    expect(text).toContain("20 min");
    expect(text).toContain("8,57 min");
    expect(text).not.toContain("8,5714");
    expect(text).not.toMatch(/\d,0+ min/);
  });

  it("prints Stycktid in seconds for a sek/st operation", async () => {
    // 0.1167 min/st = 7 s (stored minutes, 4 decimals).
    const text = pdfText(
      await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, runTimePerUnit: "0.1167", timeUnit: "seconds_per_unit" }]))
    );
    expect(text).toContain("7 sek");
    expect(text).not.toContain("0,12 min");
  });

  it("keeps a very short Stycktid visible instead of rounding it to 0 min", async () => {
    const text = pdfText(await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, runTimePerUnit: "0.0042" }])));
    expect(text).toContain("0,0042 min");
  });
});

describe("arbetskortet — materialets Op-kolumn", () => {
  it("prints the header and the linked operation's sequence number, and a dash when unlinked", async () => {
    const base = order([{ sequenceNo: 10 }]);
    const text = pdfText(
      await pdf.renderManufacturingOrder({
        ...base,
        materials: [
          {
            articleNumber: "M-1",
            articleName: "Plåt 2mm",
            quantityPlanned: "10.0000",
            quantityConsumed: "0.0000",
            unit: "st",
            // Deliberately distinct from the operation's own sequenceNo (10)
            // so the assertion below can't accidentally match that instead.
            operationSequenceNo: 99,
          },
          {
            articleNumber: "M-2",
            articleName: "Skruv",
            quantityPlanned: "4.0000",
            quantityConsumed: "0.0000",
            unit: "st",
            operationSequenceNo: null,
          },
        ],
      })
    );
    expect(text).toContain("Op");
    // Adjacent cells in the same row concatenate with no separator, so the
    // op-column value butts right up against the next column's value.
    expect(text).toContain("99M-1");
    expect(text).toContain("—M-2");
  });
});

describe("arbetskortet — operationens Packinstruktion", () => {
  it("prints the packing instructions under its operation row, prefixed, when set", async () => {
    const text = pdfText(
      await pdf.renderManufacturingOrder(order([{ sequenceNo: 10, packingInstructions: "Packa i EU-pall" }]))
    );
    expect(text).toContain("Packning: Packa i EU-pall");
  });

  // Shop-floor information — unlike the comment, always prints when set,
  // independent of printOnWorkCard (which governs the comment only).
  it("prints the packing instructions even when printOnWorkCard is not set", async () => {
    const text = pdfText(
      await pdf.renderManufacturingOrder(
        order([{ sequenceNo: 10, packingInstructions: "Packa i EU-pall", printOnWorkCard: false }])
      )
    );
    expect(text).toContain("Packning: Packa i EU-pall");
  });

  it("leaves the packing instructions off the printout when not set", async () => {
    const text = pdfText(await pdf.renderManufacturingOrder(order([{ sequenceNo: 10 }])));
    expect(text).not.toContain("Packning:");
  });
});
