import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Egna teman: the web can't import @navet/shared (Turbopack and the
// .js-suffixed imports), so theme-core.ts — deliberately import-free — is
// copied to the web as lib/themeCore.ts. Byte for byte, so the editor's live
// checks can never disagree with the server's.
const SHARED = fileURLToPath(new URL("../../../packages/shared/src/theme-core.ts", import.meta.url));
const WEB = fileURLToPath(new URL("../../web/lib/themeCore.ts", import.meta.url));

describe("theme-core's web copy", () => {
  it("is identical to packages/shared/src/theme-core.ts (cp it after every change)", () => {
    expect(readFileSync(WEB, "utf8")).toBe(readFileSync(SHARED, "utf8"));
  });

  it("has no imports at all, so the copy stays self-contained", () => {
    expect(readFileSync(SHARED, "utf8")).not.toMatch(/^\s*(import|export\s+[^;]*\sfrom)\s/m);
  });
});
