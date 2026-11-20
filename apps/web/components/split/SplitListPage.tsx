import { AppShell } from "../AppShell";
import { SplitEmpty, SplitView } from "./SplitView";

// A function's list page in its list view (Lista och kort): the narrow list
// and an empty card area — nothing of the wide table is fetched.
export function SplitListPage({ list }: { list: string }) {
  return (
    <AppShell>
      <SplitView list={list}>
        <SplitEmpty list={list} />
      </SplitView>
    </AppShell>
  );
}
