import { describe, expect, it } from "vitest";
import { searchSections, splitIntoSections } from "../../web/lib/manualSearch.js";

const md = [
  "Intro om lager.",
  "",
  "## Lagervärdering",
  "",
  "Värdet räknas på **glidande** medelpris.",
  "",
  "```",
  "# inte en rubrik",
  "```",
  "",
  "## Inventering",
  "",
  "Räkna lagervärdering och öka saldot. Åäö.",
].join("\n");
const sections = splitIntoSections("lager", "Lager", md);

describe("manual search", () => {
  it("splits per heading with slug ids and ignores fenced code", () => {
    expect(sections.map((s) => s.id)).toEqual(["", "lagervardering", "inventering"]);
    expect(sections[1].text).toContain("glidande medelpris");
    expect(sections[1].text).toContain("inte en rubrik");
  });
  it("ignores case and å/ä/ö, requires all words, ranks headings first", () => {
    const hits = searchSections(sections, "LAGERVARDERING");
    expect(hits.map((h) => h.id)).toEqual(["lagervardering", "inventering"]);
    expect(searchSections(sections, "glidande saldot")).toEqual([]);
    expect(searchSections(sections, "aao")[0].id).toBe("inventering");
  });
  it("marks hits in the snippet", () => {
    const hit = searchSections(sections, "medelpris")[0];
    expect(hit.snippet.filter((p) => p.hit).map((p) => p.text)).toEqual(["medelpris"]);
  });
  it("centres the snippet where most of the query sits together", () => {
    const long = splitIntoSections(
      "t",
      "T",
      "## Rubrik\n\nOperationstid räknas här. " + "Fyllnadstext utan träff. ".repeat(20) + "En operation med orimligt mycket tid varnas.",
    );
    const hit = searchSections(long, "orimligt mycket tid")[0];
    expect(hit.snippet.filter((p) => p.hit).map((p) => p.text)).toEqual(["orimligt", "mycket", "tid"]);
  });
});
