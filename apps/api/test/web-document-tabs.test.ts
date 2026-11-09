import { afterEach, describe, expect, it } from "vitest";
import {
  closeTab,
  documentHref,
  embeddedBootScript,
  isEmbedded,
  MAX_DOCUMENT_TABS,
  moveTab,
  openTab,
  provisionalTitle,
  reassertEmbedded,
  restoreTabs,
  sameDocument,
  tabForDigit,
  type DocumentTab,
} from "../../web/lib/documentTabs";

// Flikar och delad vy (Nav som program, punkt 5): which links open as a tab,
// opening, closing, the cap and what a reload gives back.
const ORIGIN = "https://nav.example";
const ID = "3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
const ID2 = "9a8b7c6d-1d2e-4f5a-8b9c-0d1e2f3a4b5c";

describe("documentHref", () => {
  it("is a page with an id inside Nav, path and query", () => {
    expect(documentHref(`/forsaljning/ordrar/${ID}`, ORIGIN)).toBe(`/forsaljning/ordrar/${ID}`);
    expect(documentHref(`${ORIGIN}/artiklar/${ID}?flik=lager#x`, ORIGIN)).toBe(`/artiklar/${ID}?flik=lager`);
    expect(documentHref(`/ekonomi/budget/${ID}/rader`, ORIGIN)).toBe(`/ekonomi/budget/${ID}/rader`);
  });

  it("leaves lists, the API, the terminal and other sites to ordinary navigation", () => {
    expect(documentHref("/forsaljning/ordrar", ORIGIN)).toBeNull();
    expect(documentHref(`/api/v1/invoices/${ID}/pdf`, ORIGIN)).toBeNull();
    expect(documentHref(`/tillverkning/terminal/${ID}`, ORIGIN)).toBeNull();
    expect(documentHref(`https://annan.example/artiklar/${ID}`, ORIGIN)).toBeNull();
    expect(documentHref(`/artiklar/${ID}x`, ORIGIN)).toBeNull();
  });
});

describe("sameDocument / provisionalTitle", () => {
  it("compares the path, not the query", () => {
    expect(sameDocument(`/artiklar/${ID}?flik=lager`, `/artiklar/${ID}`)).toBe(true);
    expect(sameDocument(`/artiklar/${ID}`, `/artiklar/${ID2}`)).toBe(false);
  });
  it("names a tab after a short link text until the page says its own", () => {
    expect(provisionalTitle("  KO-5003 ")).toBe("KO-5003");
    expect(provisionalTitle("")).toBe("Dokument");
    expect(provisionalTitle("x".repeat(41))).toBe("Dokument");
  });
});

function tab(n: number, lastUsed = n): DocumentTab {
  return { id: `t${n}`, href: `/artiklar/${ID.slice(0, -2)}${String(n).padStart(2, "0")}`, title: `T${n}`, lastUsed };
}

describe("openTab", () => {
  const ids = () => {
    let n = 100;
    return () => `t${++n}`;
  };

  it("re-activates a document that is already open", () => {
    const result = openTab([tab(1), tab(2)], `${tab(1).href}?flik=x`, "x", 50, ids(), () => false);
    expect(result).toMatchObject({ kind: "opened", activeId: "t1", closed: [] });
    if (result.kind === "opened") expect(result.tabs.find((t) => t.id === "t1")!.lastUsed).toBe(50);
  });

  it("adds a tab last and shows it", () => {
    const result = openTab([tab(1)], `/kunder/${ID2}`, "Kund", 50, ids(), () => false);
    expect(result).toMatchObject({ kind: "opened", activeId: "t101", closed: [] });
    if (result.kind === "opened") expect(result.tabs.map((t) => t.id)).toEqual(["t1", "t101"]);
  });

  it("past the cap closes the tab used longest ago, never one with unsaved changes", () => {
    const full = Array.from({ length: MAX_DOCUMENT_TABS }, (_, i) => tab(i + 1, [5, 1, 3, 4, 6, 7, 8, 9][i]!));
    // t2 is the oldest but has drafts: t3 goes.
    const result = openTab(full, `/kunder/${ID2}`, "Kund", 50, ids(), (id) => id === "t2");
    expect(result).toMatchObject({ kind: "opened", closed: ["t3"], activeId: "t101" });
    if (result.kind === "opened") expect(result.tabs).toHaveLength(MAX_DOCUMENT_TABS);
  });

  it("refuses when every tab has unsaved changes", () => {
    const full = Array.from({ length: MAX_DOCUMENT_TABS }, (_, i) => tab(i + 1));
    expect(openTab(full, `/kunder/${ID2}`, "Kund", 50, ids(), () => true)).toEqual({ kind: "refused" });
  });
});

describe("closeTab", () => {
  it("shows the right-hand neighbour, else the left one, else the page", () => {
    const three = [tab(1), tab(2), tab(3)];
    expect(closeTab(three, "t2", "t2")).toMatchObject({ activeId: "t3" });
    expect(closeTab(three, "t3", "t3")).toMatchObject({ activeId: "t2" });
    expect(closeTab([tab(1)], "t1", "t1")).toEqual({ tabs: [], activeId: null });
    expect(closeTab(three, "t1", "t3")).toMatchObject({ activeId: "t3" });
    expect(closeTab(three, "t1", null).tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
  });
});

describe("moveTab / tabForDigit", () => {
  it("moves a dragged tab to its new place, the others keep their order", () => {
    const four = [tab(1), tab(2), tab(3), tab(4)];
    expect(moveTab(four, "t1", 2).map((t) => t.id)).toEqual(["t2", "t3", "t1", "t4"]);
    expect(moveTab(four, "t4", 0).map((t) => t.id)).toEqual(["t4", "t1", "t2", "t3"]);
    expect(moveTab(four, "t2", 99).map((t) => t.id)).toEqual(["t1", "t3", "t4", "t2"]);
    expect(moveTab(four, "nope", 0)).toEqual(four);
  });

  it("maps 1 to the page and 2–9 to the documents in order", () => {
    const two = [tab(1), tab(2)];
    expect(tabForDigit(two, 1)).toBeNull();
    expect(tabForDigit(two, 2)).toBe("t1");
    expect(tabForDigit(two, 3)).toBe("t2");
    expect(tabForDigit(two, 4)).toBeUndefined();
    expect(tabForDigit(two, 0)).toBeUndefined();
  });
});

describe("restoreTabs", () => {
  it("gives back the valid tabs and drops the rest", () => {
    const raw = JSON.stringify({
      tabs: [tab(1), { id: "x", href: "/forsaljning/ordrar", title: "Lista" }, tab(1), { id: "y" }, tab(2)],
      activeId: "t2",
    });
    const restored = restoreTabs(raw, ORIGIN);
    expect(restored.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(restored.activeId).toBe("t2");
    expect(restoreTabs(JSON.stringify({ tabs: [tab(1)], activeId: "gone" }), ORIGIN).activeId).toBeNull();
    expect(restoreTabs("{inte json", ORIGIN)).toEqual({ tabs: [], activeId: null });
    expect(restoreTabs(null, ORIGIN)).toEqual({ tabs: [], activeId: null });
  });
});

describe("embeddedBootScript", () => {
  function run(win: unknown, attrs: string[]) {
    const documentElement = { setAttribute: (name: string) => attrs.push(name) };
    new Function("window", "document", embeddedBootScript)(win, { documentElement });
  }

  it("marks a page inside a frame of Nav's own origin", () => {
    const attrs: string[] = [];
    const parent = { location: { origin: ORIGIN } };
    const win = { top: parent, parent, location: { origin: ORIGIN } };
    (win as { self?: unknown }).self = win;
    run(win, attrs);
    expect(attrs).toEqual(["data-embedded"]);
  });

  it("leaves a top-level page and a page framed by another site alone", () => {
    const top: { self?: unknown; top?: unknown } = {};
    top.self = top;
    top.top = top;
    const attrs: string[] = [];
    run(top, attrs);
    const foreign = {
      get location(): never {
        throw new Error("cross-origin");
      },
    };
    const framed = { top: foreign, parent: foreign, location: { origin: ORIGIN } };
    (framed as { self?: unknown }).self = framed;
    run(framed, attrs);
    expect(attrs).toEqual([]);
  });
});

// The live check behind every embedded decision (no tabs restored, no
// polling, the bridge): the frame itself, because React strips <html>'s
// attributes when it client-renders the root after a hydration error — the
// page then nested Nav inside the tab.
describe("isEmbedded and reassertEmbedded", () => {
  const g = globalThis as { window?: unknown; document?: unknown };
  afterEach(() => {
    delete g.window;
    delete g.document;
  });

  function framedWindow() {
    const parent = { location: { origin: ORIGIN } };
    const win = { top: parent, parent, location: { origin: ORIGIN } };
    (win as { self?: unknown }).self = win;
    return win;
  }

  function fakeDocument(initial: string[]) {
    const attrs = new Set(initial);
    return {
      attrs,
      documentElement: {
        hasAttribute: (name: string) => attrs.has(name),
        setAttribute: (name: string) => void attrs.add(name),
      },
    };
  }

  it("asks the frame, not the attribute", () => {
    g.window = framedWindow();
    g.document = fakeDocument([]);
    expect(isEmbedded()).toBe(true);
  });

  it("is false on the top page, in a frame of another site and on the server", () => {
    expect(isEmbedded()).toBe(false);
    const top: { self?: unknown; top?: unknown; location?: unknown } = { location: { origin: ORIGIN } };
    top.self = top;
    top.top = top;
    g.window = top;
    expect(isEmbedded()).toBe(false);
    const foreign = {
      get location(): never {
        throw new Error("cross-origin");
      },
    };
    const framed = { top: foreign, parent: foreign, location: { origin: ORIGIN } };
    (framed as { self?: unknown }).self = framed;
    g.window = framed;
    expect(isEmbedded()).toBe(false);
  });

  it("puts data-embedded back after React stripped it, and only inside a frame", () => {
    g.window = framedWindow();
    const doc = fakeDocument(["data-theme"]);
    g.document = doc;
    reassertEmbedded();
    expect([...doc.attrs]).toEqual(["data-theme", "data-embedded"]);

    const top: { self?: unknown; top?: unknown; location?: unknown } = { location: { origin: ORIGIN } };
    top.self = top;
    top.top = top;
    g.window = top;
    const topDoc = fakeDocument([]);
    g.document = topDoc;
    reassertEmbedded();
    expect([...topDoc.attrs]).toEqual([]);
  });
});
