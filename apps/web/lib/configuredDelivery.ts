// Konfigurator 4c: a configured row delivered beyond what its linked TOs have
// received into stock (Inlevererat — a delinleverans from an open TO counts
// as much as a done TO's) — a warning, never a block (the template's stock is
// shared; a freely built unit may legitimately be delivered). All quantities
// are in the article's base unit (the caller converts the entered quantity).
export function configuredDeliveryWarning(
  row: {
    configuration: unknown | null;
    quantityDelivered: string | number;
    manufacturingOrders: { status: string; quantityReceived: string | number }[];
  },
  deliverNow: number
): string | null {
  if (!row.configuration || !(deliverNow > 0)) return null;
  const finished = row.manufacturingOrders.reduce((t, o) => t + Number(o.quantityReceived), 0);
  const after = Number(row.quantityDelivered) + deliverNow;
  if (after <= finished) return null;
  const fmt = (n: number) => n.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
  return `KO-raden har bara ${fmt(finished)} av ${fmt(after)} färdigrapporterade`;
}
