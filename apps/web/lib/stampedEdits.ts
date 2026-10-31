// What the user changed on one entry of a list the server re-reads after
// every action (router.refresh), stamped with the entry's state at the time.
// Once the entry's state changes (booked, ignored, matched anew) the edit no
// longer applies and the entry starts over from the server's view; every
// other entry keeps what the user did. Used by the bank file cards, where a
// state-keyed remount used to reset every entry after one was booked.
export type StampedEdits<T> = Record<string, { state: string; value: T }>;

export function editOf<T>(edits: StampedEdits<T>, entry: { id: string; state: string }): T | undefined {
  const edit = edits[entry.id];
  return edit && edit.state === entry.state ? edit.value : undefined;
}

export function withEdit<T>(edits: StampedEdits<T>, entry: { id: string; state: string }, value: T): StampedEdits<T> {
  return { ...edits, [entry.id]: { state: entry.state, value } };
}
