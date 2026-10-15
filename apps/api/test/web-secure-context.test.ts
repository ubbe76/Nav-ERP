import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The web is also reached over plain http on the LAN (http://192.168.1.215:3000),
// which is NOT a secure context: browser APIs marked [SecureContext] are simply
// undefined there, so calling one throws and the click silently does nothing
// (the + Kolli button on the shipment card did exactly that on mobile).
// crypto.randomUUID is the one we have tripped over — keep it out of the web.
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("web code runs outside a secure context", () => {
  it("never calls crypto.randomUUID (undefined over plain http on the LAN)", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((dir) => walk(join(WEB, dir)))
      .filter((file) => /randomUUID\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(WEB.length));
    expect(offenders).toEqual([]);
  });
});
