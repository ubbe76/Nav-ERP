import { afterEach, describe, expect, it } from "vitest";
import {
  appHref,
  closeTab,
  documentHref,
  embeddedBootScript,
  isEmbedded,
  MAX_TABS,
  moveTab,
  openTab,
  provisionalTitle,
  reassertEmbedded,
  restoreTabs,
  sameDocument,
  tabForDigit,
  tabMoved,
  type AppTab,
  type OpenOptions,
} from "../../web/lib/documentTabs";
import { functionOf, functionTitle } from "../../web/lib/navFunctions";

// Flikar per funktion (Programramen, 2026-11-20): which pages go in a tab,
// which function a page belongs to, opening, closing, the cap and what a
// reload gives back.
const ORIGIN = "https://nav.example";
const ID = "3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
const ID2 = "9a8b7c6d-1d2e-4f5a-8b9c-0d1e2f3a4b5c";

describe("appHref / documentHref", () => {
  it("is any page inside Nav, path and query", () => {
    expect(appHref("/forsaljning/ordrar?status=open#x", ORIGIN)).toBe("/forsaljning/ordrar?status=open");
    expect(appHref("/", ORIGIN)).toBe("/");
    expect(appHref(`${ORIGIN}/artiklar/${ID}`, ORIGIN)).toBe(`/artiklar/${ID}`);
  });

  it("leaves the API, the login, the full-screen pages and other sites alone", () => {
    expect(appHref(`/api/v1/invoices/${ID}/pdf`, ORIGIN)).toBeNull();
    expect(appHref("/login", ORIGIN)).toBeNull();
    expect(appHref("/register", ORIGIN)).toBeNull();
    expect(appHref("/tillverkning/terminal", ORIGIN)).toBeNull();
    expect(appHref(`/tillverkning/terminal/${ID}`, ORIGIN)).toBeNull();
    expect(appHref("/lager/inventera", ORIGIN)).toBeNull();
    expect(appHref(`https://annan.example/artiklar/${ID}`, ORIGIN)).toBeNull();
    // A page that only begins like one of them is an ordinary page.
    expect(appHref("/loginhjalp", ORIGIN)).toBe("/loginhjalp");
  });

  it("a document is a page with an id", () => {
    expect(documentHref(`/forsaljning/ordrar/${ID}`, ORIGIN)).toBe(`/forsaljning/ordrar/${ID}`);
    expect(documentHref(`${ORIGIN}/artiklar/${ID}?flik=lager#x`, ORIGIN)).toBe(`/artiklar/${ID}?flik=lager`);
    expect(documentHref(`/ekonomi/budget/${ID}/rader`, ORIGIN)).toBe(`/ekonomi/budget/${ID}/rader`);
    expect(documentHref("/forsaljning/ordrar", ORIGIN)).toBeNull();
    expect(documentHref(`/tillverkning/terminal/${ID}`, ORIGIN)).toBeNull();
    expect(documentHref(`/artiklar/${ID}x`, ORIGIN)).toBeNull();
  });
});

describe("functionOf", () => {
  it("a list page and its documents are one function", () => {
    expect(functionOf("/forsaljning/ordrar")).toBe("/forsaljning/ordrar");
    expect(functionOf(`/forsaljning/ordrar/${ID}?flik=rader`)).toBe("/forsaljning/ordrar");
    expect(functionOf(`/inkop/ordrar/${ID}`)).toBe("/inkop/ordrar");
    expect(functionOf(`/kunder/${ID}`)).toBe("/kunder");
    expect(functionOf(`/tillverkning/ordrar/${ID}`)).toBe("/tillverkning/ordrar");
  });

  it("an article card belongs to Artikelregister, not to the Artiklar module page", () => {
    expect(functionOf(`/artiklar/${ID}`)).toBe("/artiklar/register");
    expect(functionOf("/artiklar")).toBe("/artiklar");
    expect(functionOf("/artiklar/oversikt")).toBe("/artiklar/oversikt");
  });

  it("module pages, the top pages, plugin pages and the rest", () => {
    expect(functionOf("/")).toBe("/");
    expect(functionOf("/inkop")).toBe("/inkop");
    expect(functionOf("/hjalp/forsaljning")).toBe("/hjalp");
    expect(functionOf(`/meddelanden/${ID}`)).toBe("/meddelanden");
    expect(functionOf("/grunddata?flik=enheter")).toBe("/grunddata");
    expect(functionOf("/tillagg/lagerkoll/oversikt")).toBe("/tillagg/lagerkoll/oversikt");
    expect(functionOf("/okand/sida")).toBe("/okand");
  });

  it("names a function as the menu does", () => {
    expect(functionTitle("/forsaljning/ordrar")).toBe("Kundorder");
    expect(functionTitle("/")).toBe("Översikt");
    expect(functionTitle("/inkop")).toBe("Inköp");
    expect(functionTitle("/okand")).toBeNull();
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

// One tab per function: t1 Kundorder, t2 Artikelregister … — numbered paths
// of their own beyond the first few.
const PAGES = ["/forsaljning/ordrar", "/artiklar/register", "/inkop/ordrar", "/kunder", "/leverantorer", "/lager/saldon", "/tillverkning/ordrar", "/ekonomi/verifikat", "/rapporter/marginal"];
function tab(n: number, lastUsed = n, over: Partial<AppTab> = {}): AppTab {
  const href = PAGES[n - 1]!;
  return { id: `t${n}`, href, title: `T${n}`, fn: functionOf(href), own: false, lastUsed, ...over };
}

function options(over: Partial<OpenOptions> = {}): OpenOptions {
  let n = 100;
  return { title: "x", mode: "link", activeId: null, now: 50, newId: () => `t${++n}`, hasDrafts: () => false, ...over };
}

describe("openTab", () => {
  it("shows the function's tab and sends it to a document of that function", () => {
    const result = openTab([tab(1), tab(2)], `/forsaljning/ordrar/${ID}`, options());
    expect(result).toMatchObject({ kind: "opened", activeId: "t1", closed: [], navigate: `/forsaljning/ordrar/${ID}` });
    if (result.kind === "opened") expect(result.tabs.find((t) => t.id === "t1")).toMatchObject({ href: `/forsaljning/ordrar/${ID}`, lastUsed: 50 });
  });

  it("a link to the address the tab already shows only shows it", () => {
    expect(openTab([tab(1), tab(2)], "/forsaljning/ordrar", options())).toMatchObject({ activeId: "t1", navigate: null });
  });

  it("a menu choice shows a hidden tab as it is, and takes the shown one back to the function's page", () => {
    const onCard = tab(1, 1, { href: `/forsaljning/ordrar/${ID}` });
    expect(openTab([onCard, tab(2)], "/forsaljning/ordrar", options({ mode: "menu", activeId: "t2" }))).toMatchObject({
      activeId: "t1",
      navigate: null,
    });
    expect(openTab([onCard, tab(2)], "/forsaljning/ordrar", options({ mode: "menu", activeId: "t1" }))).toMatchObject({
      activeId: "t1",
      navigate: "/forsaljning/ordrar",
    });
  });

  it("adds a tab last for a function that has none", () => {
    const result = openTab([tab(1)], `/kunder/${ID2}`, options({ title: "Kund" }));
    expect(result).toMatchObject({ kind: "opened", activeId: "t101", closed: [], navigate: null });
    if (result.kind === "opened") {
      expect(result.tabs.map((t) => t.id)).toEqual(["t1", "t101"]);
      expect(result.tabs[1]).toMatchObject({ href: `/kunder/${ID2}`, fn: "/kunder", own: false, title: "Kund" });
    }
  });

  it("a document of its own (Ctrl-click) gets its own tab, and is never taken as the function's", () => {
    const own = openTab([tab(1)], `/forsaljning/ordrar/${ID}`, options({ own: true }));
    expect(own).toMatchObject({ activeId: "t101", navigate: null });
    if (own.kind !== "opened") return;
    expect(own.tabs[1]).toMatchObject({ own: true, fn: "/forsaljning/ordrar" });
    // The same document again: its own tab; the list still goes to t1.
    expect(openTab(own.tabs, `/forsaljning/ordrar/${ID}?flik=rader`, options({ own: true }))).toMatchObject({ activeId: "t101" });
    expect(openTab(own.tabs, `/forsaljning/ordrar/${ID2}`, options())).toMatchObject({ activeId: "t1", navigate: `/forsaljning/ordrar/${ID2}` });
  });

  it("of two tabs with one function, the one used last", () => {
    const twin = tab(1, 9, { id: "t9", href: `/forsaljning/ordrar/${ID2}` });
    expect(openTab([tab(1, 3), twin], "/forsaljning/ordrar", options({ mode: "menu" }))).toMatchObject({ activeId: "t9" });
  });

  it("past the cap closes the tab used longest ago, never one with unsaved changes", () => {
    const full = Array.from({ length: MAX_TABS }, (_, i) => tab(i + 1, [5, 1, 3, 4, 6, 7, 8, 9][i]!));
    // t2 is the oldest but has drafts: t3 goes.
    const result = openTab(full, "/rapporter/marginal", options({ hasDrafts: (id) => id === "t2" }));
    expect(result).toMatchObject({ kind: "opened", closed: ["t3"], activeId: "t101" });
    if (result.kind === "opened") expect(result.tabs).toHaveLength(MAX_TABS);
  });

  it("refuses when every tab has unsaved changes", () => {
    const full = Array.from({ length: MAX_TABS }, (_, i) => tab(i + 1));
    expect(openTab(full, "/rapporter/marginal", options({ hasDrafts: () => true }))).toEqual({ kind: "refused" });
  });
});

describe("tabMoved", () => {
  it("follows the tab's own navigation: address, name and function", () => {
    const moved = tabMoved([tab(1), tab(2)], "t1", `/forsaljning/ordrar/${ID}`, "Kundorder KO-5001");
    expect(moved[0]).toMatchObject({ href: `/forsaljning/ordrar/${ID}`, title: "Kundorder KO-5001", fn: "/forsaljning/ordrar" });
    expect(tabMoved([tab(1)], "t1", "/kunder", "")[0]).toMatchObject({ title: "T1", fn: "/kunder" });
  });
});

describe("closeTab", () => {
  it("shows the right-hand neighbour, else the left one, else nothing", () => {
    const three = [tab(1), tab(2), tab(3)];
    expect(closeTab(three, "t2", "t2")).toMatchObject({ activeId: "t3" });
    expect(closeTab(three, "t3", "t3")).toMatchObject({ activeId: "t2" });
    expect(closeTab([tab(1)], "t1", "t1")).toEqual({ tabs: [], activeId: null });
    expect(closeTab(three, "t1", "t3")).toMatchObject({ activeId: "t3" });
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

  it("maps 1–9 to the tabs in the strip's order", () => {
    const two = [tab(1), tab(2)];
    expect(tabForDigit(two, 1)).toBe("t1");
    expect(tabForDigit(two, 2)).toBe("t2");
    expect(tabForDigit(two, 3)).toBeUndefined();
    expect(tabForDigit(two, 0)).toBeUndefined();
  });
});

describe("restoreTabs", () => {
  it("gives back the valid tabs, with their function, and drops the rest", () => {
    const raw = JSON.stringify({
      tabs: [
        tab(1),
        { id: "x", href: "/api/v1/sales-orders", title: "API" },
        tab(1),
        { id: "y" },
        { id: "own", href: `/forsaljning/ordrar/${ID}`, title: "KO", own: true, lastUsed: 3 },
        tab(2),
      ],
      activeId: "t2",
    });
    const restored = restoreTabs(raw, ORIGIN);
    expect(restored.tabs.map((t) => t.id)).toEqual(["t1", "own", "t2"]);
    expect(restored.tabs[1]).toMatchObject({ own: true, fn: "/forsaljning/ordrar" });
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
