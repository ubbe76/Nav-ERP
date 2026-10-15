import { confirmDialog } from "./confirm";

// Asked before every revision-affecting save on purchase/sales orders.
// OK = bump the revision, Avbryt = save without bumping — the save itself
// always happens; the answer is sent to the API as `bumpRevision`.
export function askBumpRevision(current: number): Promise<boolean> {
  return confirmDialog(
    `Ska ordern få en ny revision (${current + 1})?\n\nOK = ny revision\nAvbryt = behåll revision ${current}`
  );
}
