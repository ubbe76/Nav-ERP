import { BANK_MATCH_DATE_WINDOW_DAYS, round2 } from "@navet/shared";
import { addDays } from "./banking-dates.js";

// Bankavstämning — the automatic matching, pure (no DB imports). Entries
// are the unmatched statement entries, rows the unmatched verification rows
// on the account's ledger account (amount = debit − credit). Two passes, each
// only proposing what is UNAMBIGUOUS:
//   1. Reference: the entry carries a bank reference (AcctSvcrRef /
//      EndToEndId) that the row's payment was booked from (a camt.054
//      entry) — and the amounts agree.
//   2. Amount + date: exactly one row with the same amount within ±3 days of
//      the booking day, and no other entry with that amount could claim it.
// Anything with more than one candidate comes back as an ambiguous proposal
// (the candidates listed) for the user; it is never matched by itself.

export interface ProposalEntry {
  id: string;
  bookingDate: string;
  amount: number;
  references: readonly string[];
}

export interface ProposalRow {
  id: string;
  date: string;
  amount: number;
  references: readonly string[];
}

export interface MatchProposal {
  entryIds: string[];
  rowIds: string[];
  basis: "reference" | "amount_date";
  ambiguous: boolean;
}

const within = (a: string, b: string, days: number) => b >= addDays(a, -days) && b <= addDays(a, days);

export function proposeMatches(
  entries: readonly ProposalEntry[],
  rows: readonly ProposalRow[],
  opts: { windowDays?: number } = {}
): MatchProposal[] {
  const windowDays = opts.windowDays ?? BANK_MATCH_DATE_WINDOW_DAYS;
  const proposals: MatchProposal[] = [];
  const takenRows = new Set<string>();
  const doneEntries = new Set<string>();

  // Pass 1: references. A row's reference set is normally one camt.054
  // entry's; an entry's includes every TxDtls', so a collective entry meets
  // each of its payments — those are only proposed when the sum agrees.
  const rowsByReference = new Map<string, ProposalRow[]>();
  for (const row of rows) {
    for (const ref of row.references) {
      const list = rowsByReference.get(ref) ?? [];
      list.push(row);
      rowsByReference.set(ref, list);
    }
  }
  for (const entry of entries) {
    if (entry.references.length === 0) continue;
    const candidates = new Map<string, ProposalRow>();
    for (const ref of entry.references) for (const row of rowsByReference.get(ref) ?? []) if (!takenRows.has(row.id)) candidates.set(row.id, row);
    if (candidates.size === 0) continue;
    const list = [...candidates.values()];
    const sum = round2(list.reduce((acc, row) => acc + row.amount, 0));
    if (sum === round2(entry.amount)) {
      for (const row of list) takenRows.add(row.id);
      doneEntries.add(entry.id);
      proposals.push({ entryIds: [entry.id], rowIds: list.map((r) => r.id), basis: "reference", ambiguous: false });
    } else {
      const exact = list.filter((row) => round2(row.amount) === round2(entry.amount));
      if (exact.length === 1) {
        takenRows.add(exact[0]!.id);
        doneEntries.add(entry.id);
        proposals.push({ entryIds: [entry.id], rowIds: [exact[0]!.id], basis: "reference", ambiguous: false });
      } else {
        doneEntries.add(entry.id);
        proposals.push({ entryIds: [entry.id], rowIds: list.map((r) => r.id), basis: "reference", ambiguous: true });
      }
    }
  }

  // Pass 2: amount + date among what is left.
  const remainingEntries = entries.filter((e) => !doneEntries.has(e.id));
  const remainingRows = rows.filter((r) => !takenRows.has(r.id));
  const candidatesFor = (entry: ProposalEntry) =>
    remainingRows.filter((row) => !takenRows.has(row.id) && round2(row.amount) === round2(entry.amount) && within(entry.bookingDate, row.date, windowDays));
  const claimants = (row: ProposalRow) =>
    remainingEntries.filter((entry) => !doneEntries.has(entry.id) && round2(entry.amount) === round2(row.amount) && within(entry.bookingDate, row.date, windowDays));

  for (const entry of remainingEntries) {
    const candidates = candidatesFor(entry);
    if (candidates.length === 0) continue;
    if (candidates.length === 1 && claimants(candidates[0]!).length === 1) {
      takenRows.add(candidates[0]!.id);
      doneEntries.add(entry.id);
      proposals.push({ entryIds: [entry.id], rowIds: [candidates[0]!.id], basis: "amount_date", ambiguous: false });
    } else {
      proposals.push({ entryIds: [entry.id], rowIds: candidates.map((r) => r.id), basis: "amount_date", ambiguous: true });
    }
  }
  return proposals;
}
