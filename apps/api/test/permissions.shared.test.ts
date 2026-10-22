import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_IMPLIES,
  PERMISSION_LABELS,
  MENU_PERMISSIONS,
  WORKSHOP_PERMISSIONS,
  createPermissionGroupSchema,
  effectivePermissions,
  satisfiesRule,
} from "@navet/shared";
// The web mirror has no imports, so vitest can load it directly — this is
// what keeps the two copies from drifting (the web can't import @navet/shared).
import * as web from "../../web/lib/permissions.js";

describe("permission catalog", () => {
  it("has exactly the eleven agreed codes", () => {
    expect([...PERMISSIONS]).toEqual([
      "artiklar", "inkop", "forsaljning", "tillverkning", "lager", "personal", "ekonomi", "rapporter",
      "terminal", "artikeloversikt", "tillverkningsorder_las",
    ]);
    expect([...MENU_PERMISSIONS, ...WORKSHOP_PERMISSIONS]).toEqual([...PERMISSIONS]);
  });

  it("web mirror is identical", () => {
    expect([...web.PERMISSIONS]).toEqual([...PERMISSIONS]);
    expect([...web.MENU_PERMISSIONS]).toEqual([...MENU_PERMISSIONS]);
    expect([...web.WORKSHOP_PERMISSIONS]).toEqual([...WORKSHOP_PERMISSIONS]);
    expect(web.PERMISSION_LABELS).toEqual(PERMISSION_LABELS);
    expect(web.PERMISSION_IMPLIES).toEqual(PERMISSION_IMPLIES);
  });
});

describe("effectivePermissions", () => {
  it("gives admin the whole catalog regardless of group", () => {
    expect(effectivePermissions("admin", null)).toEqual([...PERMISSIONS]);
    expect(effectivePermissions("admin", [])).toEqual([...PERMISSIONS]);
  });

  it("gives a user without a group nothing", () => {
    expect(effectivePermissions("user", null)).toEqual([]);
    expect(effectivePermissions("supervisor", null)).toEqual([]);
  });

  it("adds implied permissions, in catalog order, without duplicates", () => {
    expect(effectivePermissions("user", ["tillverkning", "terminal"])).toEqual([
      "tillverkning", "terminal", "tillverkningsorder_las",
    ]);
    expect(effectivePermissions("user", ["artiklar"])).toEqual(["artiklar", "artikeloversikt"]);
    // Personal & lön implies nothing — in particular not Tillverkning's terminal.
    expect(effectivePermissions("supervisor", ["personal"])).toEqual(["personal"]);
  });

  it("drops codes that are not in the catalog (a removed permission left in a group)", () => {
    expect(effectivePermissions("user", ["lager", "obsolete"])).toEqual(["lager"]);
  });
});

describe("satisfiesRule", () => {
  const sales = { role: "user" as const, permissions: effectivePermissions("user", ["forsaljning"]) };
  const workshop = {
    role: "user" as const,
    permissions: effectivePermissions("user", ["terminal", "artikeloversikt", "tillverkningsorder_las"]),
  };
  const nobody = { role: "user" as const, permissions: [] };
  const admin = { role: "admin" as const };

  it("passes admin for every rule, even without a permissions field", () => {
    expect(satisfiesRule(admin, ["admin"])).toBe(true);
    expect(satisfiesRule(admin, ["ekonomi"])).toBe(true);
    expect(satisfiesRule(admin, [])).toBe(true);
  });

  it("treats office as 'has at least one menu permission'", () => {
    expect(satisfiesRule(sales, ["office"])).toBe(true);
    expect(satisfiesRule({ role: "supervisor", permissions: ["personal"] }, ["office"])).toBe(true);
    expect(satisfiesRule(workshop, ["office"])).toBe(false);
    expect(satisfiesRule(nobody, ["office"])).toBe(false);
  });

  it("is any-of", () => {
    expect(satisfiesRule(workshop, ["office", "terminal"])).toBe(true);
    expect(satisfiesRule(sales, ["inkop", "forsaljning"])).toBe(true);
    expect(satisfiesRule(sales, ["inkop"])).toBe(false);
  });

  it("never passes a non-admin on the admin token or an empty rule", () => {
    expect(satisfiesRule(sales, ["admin"])).toBe(false);
    expect(satisfiesRule(sales, [])).toBe(false);
  });

  it("treats a missing permissions field as no permissions (injected test users)", () => {
    expect(satisfiesRule({ role: "user" }, ["office"])).toBe(false);
  });
});

describe("createPermissionGroupSchema", () => {
  it("accepts a valid group and trims", () => {
    expect(createPermissionGroupSchema.parse({ code: " EKO ", name: " Ekonomi ", permissions: ["ekonomi"] })).toEqual({
      code: "EKO",
      name: "Ekonomi",
      permissions: ["ekonomi"],
    });
  });

  it("rejects unknown and duplicate permissions", () => {
    expect(() => createPermissionGroupSchema.parse({ code: "X", name: "X", permissions: ["root"] })).toThrow();
    expect(() => createPermissionGroupSchema.parse({ code: "X", name: "X", permissions: ["lager", "lager"] })).toThrow();
  });
});
