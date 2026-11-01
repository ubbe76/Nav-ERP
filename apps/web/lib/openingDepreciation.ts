// Ingående avskrivning and Avskriven t.o.m. månad go together. The server
// pairs "amount > 0" with "month set" (assertOpeningDepreciation in
// fixed-asset.service.ts), so a typed 0 beside a month satisfies the amount
// field's `required` and is then refused with the generic
// invalid-opening-depreciation text. The opposite case — an amount without a
// month — is already stopped by `required` on the month field.
export function openingDepreciationPairError(amount: string, throughMonth: string): string | null {
  if (throughMonth === "") return null;
  if (Number(amount) > 0) return null;
  return "Ingående avskrivning måste vara större än 0 när Avskriven t.o.m. månad är ifylld — töm månaden om tillgången inte har någon ingående avskrivning.";
}
