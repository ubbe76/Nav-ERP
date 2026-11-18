import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Search engines stay out of every installation (the demo's login page ended
// up in Google Search Console as a duplicate): robots.txt disallows all,
// proxy.ts lets a crawler read it instead of redirecting to /login, and the
// root layout sets noindex.
import robots from "../../web/app/robots.js";

const web = (path: string) => readFileSync(new URL(`../../web/${path}`, import.meta.url), "utf8");

describe("Sökmotorer hålls borta från Nav", () => {
  it("robots.txt disallows everything for every crawler", () => {
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("the login redirect leaves /robots.txt alone but still covers the pages", () => {
    const pattern = /matcher:\s*\[\s*"([^"]+)"/.exec(web("proxy.ts"))![1]!;
    const matcher = new RegExp(`^${pattern}$`);
    expect(matcher.test("/robots.txt")).toBe(false);
    for (const path of ["/", "/login", "/forsaljning/ordrar", "/robots"]) expect(matcher.test(path), path).toBe(true);
  });

  it("every page says noindex", () => {
    expect(web("app/layout.tsx")).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  });
});
