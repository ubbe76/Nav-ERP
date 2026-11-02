// Samma artikel flera gånger i en struktur (migration 0176): allowed, but the
// card warns. Pure, derived from the row list the card already has — nothing
// is stored. Tested from apps/api/test/bom-duplicates-web.test.ts.

type BomRowLike = {
  componentArticleId: string;
  componentArticleNumber: string;
  position: string | null;
};

export type BomDuplicate = {
  componentArticleId: string;
  componentArticleNumber: string;
  count: number;
  // The rows' Pos. in list order; "—" for a row without one.
  positions: string[];
};

// Components on more than one row, in the order they first appear.
export function bomDuplicates(rows: BomRowLike[]): BomDuplicate[] {
  const byComponent = new Map<string, BomDuplicate>();
  for (const row of rows) {
    const entry = byComponent.get(row.componentArticleId);
    const position = row.position ?? "—";
    if (entry) {
      entry.count++;
      entry.positions.push(position);
    } else {
      byComponent.set(row.componentArticleId, {
        componentArticleId: row.componentArticleId,
        componentArticleNumber: row.componentArticleNumber,
        count: 1,
        positions: [position],
      });
    }
  }
  return [...byComponent.values()].filter((entry) => entry.count > 1);
}

// "K-1 ingår 2 gånger (Pos. 3, 7)" — the positions only when some row has one.
export function bomDuplicateText(entry: BomDuplicate): string {
  const withPosition = entry.positions.some((p) => p !== "—");
  return `${entry.componentArticleNumber} ingår ${entry.count} gånger${withPosition ? ` (Pos. ${entry.positions.join(", ")})` : ""}`;
}

// The add dialog's warning for a component that is already in the structure.
export function alreadyInStructureText(rows: BomRowLike[], componentArticleId: string): string | null {
  const existing = rows.filter((row) => row.componentArticleId === componentArticleId);
  if (existing.length === 0) return null;
  const positions = existing.map((row) => row.position).filter((p): p is string => p !== null);
  const where = positions.length > 0 ? ` (Pos. ${positions.join(", ")})` : "";
  const times = existing.length === 1 ? "" : ` ${existing.length} gånger`;
  return `Artikeln finns redan i strukturen${times}${where} — den läggs till som en ny rad.`;
}
