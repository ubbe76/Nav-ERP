import { describe, expect, it } from "vitest";
// moduleNav.ts imports only ./pageAccess and ./permissions (both pure), so
// vitest can load it directly — same as page-access.test.ts.
import {
  LAGER_SECTIONS,
  RAPPORTER_SECTIONS,
  TILLVERKNING_SECTIONS,
  sectionsForUser,
  type ModuleNavSection,
} from "../../web/lib/moduleNav.js";
import type { Permission } from "../../web/lib/permissions.js";

const hrefs = (sections: ModuleNavSection[]) => sections.flatMap((s) => s.items.map((i) => i.href));

const SAMPLE: ModuleNavSection[] = [
  {
    title: "Blandat",
    items: [
      { href: "/inkop/ordrar", title: "IO", description: "" },
      { href: "/forsaljning/ordrar", title: "KO", description: "" },
      { href: "/inkop/rollstyrd", title: "Rollstyrd", description: "", roles: ["admin", "supervisor"] },
    ],
  },
  {
    title: "Bara ekonomi",
    items: [{ href: "/ekonomi/verifikat", title: "Verifikat", description: "" }],
  },
];

describe("sectionsForUser", () => {
  it("keeps only the items the page-access table lets the user open, and drops emptied sections", () => {
    const result = sectionsForUser(SAMPLE, { role: "user", permissions: ["inkop"] });
    expect(result.map((s) => s.title)).toEqual(["Blandat"]);
    // The item's own role guard holds even with the Inköp permission.
    expect(hrefs(result)).toEqual(["/inkop/ordrar"]);
  });

  it("applies an item's roles on top of the page rule", () => {
    expect(hrefs(sectionsForUser(SAMPLE, { role: "supervisor", permissions: ["inkop"] }))).toEqual([
      "/inkop/ordrar",
      "/inkop/rollstyrd",
    ]);
  });

  it("gives admin everything, whatever its group", () => {
    expect(hrefs(sectionsForUser(SAMPLE, { role: "admin", permissions: [] }))).toEqual(hrefs(SAMPLE));
  });

  it("gives a user without permissions nothing", () => {
    expect(sectionsForUser(SAMPLE, { role: "user", permissions: [] })).toEqual([]);
  });

  it("keeps the admin-only Lagervärdering off both hubs for everyone else", () => {
    const all = ["artiklar", "inkop", "forsaljning", "tillverkning", "lager", "ekonomi", "rapporter"] as Permission[];
    const user = { role: "user", permissions: all };
    expect(hrefs(sectionsForUser(LAGER_SECTIONS, user))).not.toContain("/lager/vardering");
    expect(hrefs(sectionsForUser(RAPPORTER_SECTIONS, user))).not.toContain("/lager/vardering");
    expect(hrefs(sectionsForUser(RAPPORTER_SECTIONS, { role: "admin", permissions: [] }))).toContain("/lager/vardering");
  });

  it("shows the workshop profile only its own Tillverkning entries", () => {
    const workshop = { role: "user", permissions: ["terminal", "tillverkningsorder_las"] as Permission[] };
    const visible = hrefs(sectionsForUser(TILLVERKNING_SECTIONS, workshop));
    expect(visible.length).toBeGreaterThan(0);
    for (const href of visible) {
      expect(href.startsWith("/tillverkning/terminal") || href.startsWith("/tillverkning/ordrar")).toBe(true);
    }
  });
});
