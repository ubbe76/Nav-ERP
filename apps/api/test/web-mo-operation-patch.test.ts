import { describe, expect, it } from "vitest";
// Pure web helper, no imports of its own, so vitest loads it directly.
import { moOperationPatch, type MoOperationFields, type MoOperationFormValues } from "../../web/lib/moOperationPatch.js";

// Ändra on the TO card's operation sends only what changed: the server
// compares a sent workCenterId with the operation as it is now, so the whole
// form — built on a card opened before a Byt till in Beläggning — moved the
// operation back (webbgranskningen 2026-11-11).

const row: MoOperationFields = {
  sequenceNo: 10,
  description: null,
  workCenterId: "wc-100",
  setupTime: "15.0000",
  runTimePerUnit: "2.5000",
  timeUnit: "minutes_per_unit",
  comment: null,
  printOnWorkCard: false,
  packingInstructions: null,
  subcontractSupplierId: null,
  setupPrice: null,
  unitPrice: null,
  transportPrice: null,
  showNetWeight: false,
};

// What OperationModal builds from that row when nothing is touched.
const untouched: MoOperationFormValues = {
  sequenceNo: 10,
  description: "",
  workCenterId: "wc-100",
  setupTime: 15,
  runTimePerUnit: 2.5,
  timeUnit: "minutes_per_unit",
  comment: "",
  printOnWorkCard: false,
  packingInstructions: "",
  subcontractSupplierId: null,
  setupPrice: null,
  unitPrice: null,
  transportPrice: null,
  showNetWeight: false,
};

describe("moOperationPatch", () => {
  it("is empty when nothing changed (stored decimals and nulls read as the form shows them)", () => {
    expect(moOperationPatch(row, untouched)).toEqual({});
  });

  it("sends only Kommentar when only Kommentar changed — never the resource", () => {
    expect(moOperationPatch(row, { ...untouched, comment: "Gradas" })).toEqual({ comment: "Gradas" });
  });

  it("sends a resource switch with its times, and Vald för hand as the form decided", () => {
    expect(
      moOperationPatch(row, { ...untouched, workCenterId: "wc-120", setupTime: 20, runTimePerUnit: 3, resourceLocked: true })
    ).toEqual({ workCenterId: "wc-120", setupTime: 20, runTimePerUnit: 3, resourceLocked: true });
  });

  it("sends the lego fields that change and clears them as numbers or null", () => {
    const lego: MoOperationFields = { ...row, subcontractSupplierId: "sup-1", setupPrice: "500.00", unitPrice: "1.2345", transportPrice: "50.00" };
    const form: MoOperationFormValues = { ...untouched, subcontractSupplierId: "sup-1", setupPrice: 500, unitPrice: 1.2345, transportPrice: 75 };
    expect(moOperationPatch(lego, form)).toEqual({ transportPrice: 75 });
    expect(moOperationPatch(lego, { ...form, subcontractSupplierId: null, setupPrice: null, unitPrice: null, transportPrice: null })).toEqual({
      subcontractSupplierId: null,
      setupPrice: null,
      unitPrice: null,
      transportPrice: null,
    });
  });

  it("sends a display-unit change alone (the stored minutes stay)", () => {
    expect(moOperationPatch(row, { ...untouched, timeUnit: "units_per_hour" })).toEqual({ timeUnit: "units_per_hour" });
  });
});
