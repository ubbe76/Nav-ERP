import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { favoritesSchema } from "@navet/shared";
// Förvalda favoriter och genvägar (2026-11-14): the web's catalog of "+ Ny …"
// shortcuts and the choices offered for a behörighetsgrupp — loaded directly,
// like the other web mirrors.
import { FAVORITE_ACTIONS, favoriteActionsFor, groupFavoriteChoices } from "../../web/lib/favoriteActions.js";
import { pageAccessFor } from "../../web/lib/pageAccess.js";

const WEB = new URL("../../web/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

// The list page each ?ny=1 shortcut lands on, and the component that opens
// its dialog from the parameter.
const OPENS_FROM_QUERY: Record<string, string> = {
  "/forsaljning/offerter": "components/sales/SalesOrdersPageClient.tsx",
  "/forsaljning/ordrar": "components/sales/SalesOrdersPageClient.tsx",
  "/forsaljning/fakturor": "components/sales/InvoicesPageClient.tsx",
  "/kunder": "components/sales/CustomersPageClient.tsx",
  "/inkop/forfragningar": "components/purchase/InquiriesPageClient.tsx",
  "/inkop/ordrar": "components/purchase/PurchaseOrdersPageClient.tsx",
  "/inkop/leverantorsfakturor": "components/purchase/SupplierInvoicesPageClient.tsx",
  "/leverantorer": "components/purchase/SuppliersPageClient.tsx",
  "/artiklar/register": "components/articles/ArticlesPageClient.tsx",
  "/tillverkning/ordrar": "components/manufacturing/ManufacturingOrdersPageClient.tsx",
  "/tillverkning/tidrapporter": "components/timereport/TimeReportsPageClient.tsx",
};

describe("favoriternas genvägar", () => {
  it("are valid favourites, each on a page with an access rule", () => {
    expect(favoritesSchema.safeParse(FAVORITE_ACTIONS).success).toBe(true);
    for (const action of FAVORITE_ACTIONS) expect([action.href, pageAccessFor(action.href.split("?")[0]!)]).not.toEqual([action.href, null]);
  });

  it("every ?ny=1 shortcut lands on a page whose component opens its dialog from the parameter", () => {
    for (const action of FAVORITE_ACTIONS.filter((a) => a.href.endsWith("?ny=1"))) {
      const path = action.href.split("?")[0]!;
      const component = OPENS_FROM_QUERY[path];
      expect([path, component !== undefined]).toEqual([path, true]);
      const source = read(component!);
      expect([path, /useNewFromQuery\(|get\("ny"\) [!=]== "1"/.test(source)]).toEqual([path, true]);
      // …and the page renders that component.
      const page = read(`app${path}/page.tsx`);
      const name = component!.split("/").pop()!.replace(".tsx", "");
      expect([path, page.includes(name)]).toEqual([path, true]);
    }
  });

  it("are offered only where the user may open the page", () => {
    const sales = favoriteActionsFor({ role: "user", permissions: ["forsaljning"] }).map((a) => a.title);
    expect(sales).toContain("+ Ny kundorder");
    expect(sales).not.toContain("+ Ny inköpsorder");
    expect(favoriteActionsFor({ role: "user", permissions: ["terminal"] })).toEqual([]);
    expect(favoriteActionsFor({ role: "admin", permissions: [] }).length).toBe(FAVORITE_ACTIONS.length);
  });

  it("a group's choices follow its permissions, with what they imply", () => {
    const workshop = groupFavoriteChoices(["tillverkning"]);
    expect(workshop.actions.map((a) => a.title)).toContain("+ Ny tillverkningsorder");
    expect(workshop.actions.map((a) => a.title)).not.toContain("+ Ny kundorder");
    expect(workshop.pages.some((p) => p.href === "/tillverkning")).toBe(true);
    expect(workshop.pages.some((p) => p.href === "/forsaljning")).toBe(false);
    expect(groupFavoriteChoices([]).actions).toEqual([]);
  });
});
