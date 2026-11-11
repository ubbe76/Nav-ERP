// Ändra on the TO card's operation (OperationModal in MO mode): only the
// fields that differ from the row as the card loaded it. The server compares
// a sent workCenterId with the operation as it is NOW, so the whole form —
// built on a card opened before a Byt till 120 in Beläggning — moved the
// operation back to its old resource (and marked it Vald för hand) when only
// Kommentar was edited; the stale times and sequence went with it.

export interface MoOperationFields {
  sequenceNo: number;
  description: string | null;
  workCenterId: string;
  setupTime: string;
  runTimePerUnit: string;
  timeUnit: string;
  comment: string | null;
  printOnWorkCard: boolean;
  packingInstructions: string | null;
  subcontractSupplierId: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
  transportPrice: string | null;
  showNetWeight: boolean;
}

export interface MoOperationFormValues {
  sequenceNo: number;
  description: string;
  workCenterId: string;
  setupTime: number;
  runTimePerUnit: number;
  timeUnit: string;
  comment: string;
  printOnWorkCard: boolean;
  packingInstructions: string;
  subcontractSupplierId: string | null;
  setupPrice: number | null;
  unitPrice: number | null;
  transportPrice: number | null;
  showNetWeight: boolean;
  resourceLocked?: boolean;
}

const numberOrNull = (value: string | null) => (value == null ? null : Number(value));

export function moOperationPatch(original: MoOperationFields, form: MoOperationFormValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const compare = <K extends keyof MoOperationFormValues>(key: K, was: MoOperationFormValues[K]) => {
    if (form[key] !== was) patch[key] = form[key];
  };
  compare("sequenceNo", original.sequenceNo);
  compare("description", original.description ?? "");
  compare("workCenterId", original.workCenterId);
  compare("setupTime", Number(original.setupTime));
  compare("runTimePerUnit", Number(original.runTimePerUnit));
  compare("timeUnit", original.timeUnit);
  compare("comment", original.comment ?? "");
  compare("printOnWorkCard", original.printOnWorkCard);
  compare("packingInstructions", original.packingInstructions ?? "");
  compare("subcontractSupplierId", original.subcontractSupplierId);
  compare("setupPrice", numberOrNull(original.setupPrice));
  compare("unitPrice", numberOrNull(original.unitPrice));
  compare("transportPrice", numberOrNull(original.transportPrice));
  compare("showNetWeight", original.showNetWeight);
  // The form sends Vald för hand only when it means it (a switch, or the box
  // changed) — passed on as it is.
  if (form.resourceLocked !== undefined) patch.resourceLocked = form.resourceLocked;
  return patch;
}
