// What a configured row's price evaluation (POST /configurator/:id/evaluate)
// depends on — the choices, the customer, the quantity in the base unit and
// the order's currency and rate. The row forms compare it with the one the
// ConfigureModal evaluated on Lägg in, so they don't ask again for the same.
export function configuredEvaluationKey(
  selection: unknown,
  customerId: string | null | undefined,
  quantity: number,
  currency: string | undefined,
  exchangeRate: number | null | undefined
): string {
  return JSON.stringify([selection, customerId ?? null, quantity, currency ?? null, currency && currency !== "SEK" ? (exchangeRate ?? null) : null]);
}
