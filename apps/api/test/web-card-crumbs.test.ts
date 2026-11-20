import { describe, expect, it } from "vitest";
import { crumbsFor } from "../../web/lib/navFunctions";

const ID = "0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";

// Programramen steg 3: the breadcrumb above a card is module › function,
// read from the menu structure — the card adds its own number.
describe("crumbsFor", () => {
  it("gives the module and the function of a document card", () => {
    expect(crumbsFor(`/forsaljning/ordrar/${ID}`)).toEqual([
      { label: "Försäljning", href: "/forsaljning" },
      { label: "Kundorder", href: "/forsaljning/ordrar" },
    ]);
    expect(crumbsFor(`/forsaljning/offerter/${ID}`).map((c) => c.label)).toEqual(["Försäljning", "Offerter"]);
    expect(crumbsFor(`/inkop/ordrar/${ID}`).map((c) => c.href)).toEqual(["/inkop", "/inkop/ordrar"]);
    expect(crumbsFor(`/inkop/forfragningar/${ID}`).map((c) => c.href)).toEqual(["/inkop", "/inkop/forfragningar"]);
  });

  it("follows the article card's alias to Artikelregister", () => {
    expect(crumbsFor(`/artiklar/${ID}`).map((c) => c.href)).toEqual(["/artiklar", "/artiklar/register"]);
  });

  it("gives just the module on a module page", () => {
    expect(crumbsFor("/forsaljning")).toEqual([{ label: "Försäljning", href: "/forsaljning" }]);
  });
});
