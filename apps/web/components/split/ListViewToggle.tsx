"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { List, Table2 } from "lucide-react";
import { LIST_VIEW_COOKIE, withListView, type ListView } from "../../lib/listView";
import styles from "./SplitView.module.css";

// Lista och kort: which list page the table belongs to, so its toolbar can
// offer Visa som lista (ListToolbar reads it). Given by the list pages that
// have a narrow list (TableView).
const ListViewContext = createContext<string | null>(null);

export function TableView({ list, children }: { list: string; children: ReactNode }) {
  return <ListViewContext.Provider value={list}>{children}</ListViewContext.Provider>;
}

function readCookie(): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${LIST_VIEW_COOKIE}=`))
    ?.slice(LIST_VIEW_COOKIE.length + 1);
}

// Sets the view for the list and shows its page in it (the page reads the
// cookie on the server).
export function useSetListView(): (list: string, view: ListView) => void {
  const router = useRouter();
  return (list, view) => {
    const value = withListView(readCookie(), list, view);
    document.cookie = `${LIST_VIEW_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    router.push(list);
    router.refresh();
  };
}

// "Visa som lista" at the end of a table page's toolbar; nothing on a list
// without a narrow list.
export function ListViewToggle() {
  const list = useContext(ListViewContext);
  const setView = useSetListView();
  if (!list) return null;
  return (
    <button type="button" className={styles.viewButton} onClick={() => setView(list, "list")} title="Visa som lista bredvid kortet">
      <List size={15} strokeWidth={1.8} aria-hidden="true" />
      Visa som lista
    </button>
  );
}

export function TableIcon() {
  return <Table2 size={15} strokeWidth={1.8} aria-hidden="true" />;
}
