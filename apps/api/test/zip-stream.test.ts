import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { readStoredZipEntries } from "../src/modules/import/service/xlsx-writer.js";
import { dosDateTime, safeSegment, stockholmDosDateTime, UniquePaths, ZipStreamWriter } from "../src/modules/system/service/zip-stream.js";

// The file export's streaming zip writer: STORED entries, UTF-8 names, and
// ZIP64 end records only when the archive needs them.

function build(writer: ZipStreamWriter, entries: [string, string][]) {
  const parts: Buffer[] = [];
  for (const [name, text] of entries) parts.push(...writer.add(name, Buffer.from(text), new Date("2026-10-27T08:30:10Z")));
  parts.push(writer.finish());
  return Buffer.concat(parts);
}

// Central directory entries, read from the end records (ZIP64 when present).
function centralDirectory(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  let count = zip.readUInt16LE(end + 10);
  let cdOffset = zip.readUInt32LE(end + 16);
  const zip64 = count === 0xffff;
  if (zip64) {
    const locator = end - 20;
    expect(zip.readUInt32LE(locator)).toBe(0x07064b50);
    const record = Number(zip.readBigUInt64LE(locator + 8));
    expect(zip.readUInt32LE(record)).toBe(0x06064b50);
    count = Number(zip.readBigUInt64LE(record + 32));
    cdOffset = Number(zip.readBigUInt64LE(record + 48));
  }
  const entries: { name: string; offset: number; flags: number; crc: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    let offset = zip.readUInt32LE(p + 42);
    if (offset === 0xffffffff) {
      expect(zip.readUInt16LE(p + 46 + nameLength)).toBe(0x0001);
      offset = Number(zip.readBigUInt64LE(p + 46 + nameLength + 4));
    }
    entries.push({ name: zip.subarray(p + 46, p + 46 + nameLength).toString("utf8"), offset, flags: zip.readUInt16LE(p + 8), crc: zip.readUInt32LE(p + 16) });
    p += 46 + nameLength + extraLength;
  }
  return { zip64, entries };
}

describe("ZipStreamWriter", () => {
  it("writes stored entries with UTF-8 names, CRCs and a central directory pointing at each local header", () => {
    const zip = build(new ZipStreamWriter(), [
      ["Artikelfiler/1001/Ritning å.pdf", "första"],
      ["Avvikelser/AV-1/bild.png", "andra"],
    ]);
    const local = readStoredZipEntries(zip);
    expect([...local.keys()]).toEqual(["Artikelfiler/1001/Ritning å.pdf", "Avvikelser/AV-1/bild.png"]);
    expect(local.get("Avvikelser/AV-1/bild.png")!.toString()).toBe("andra");
    const { zip64, entries } = centralDirectory(zip);
    expect(zip64).toBe(false);
    expect(entries.map((e) => e.name)).toEqual([...local.keys()]);
    expect(entries.every((e) => e.flags === 0x0800)).toBe(true);
    expect(entries[0]!.crc).toBe(crc32(Buffer.from("första")));
    for (const e of entries) expect(zip.readUInt32LE(e.offset)).toBe(0x04034b50);
  });

  it("switches to ZIP64 end records and offsets past the threshold", () => {
    const zip = build(new ZipStreamWriter(60), [
      ["a.txt", "x".repeat(40)],
      ["b.txt", "y".repeat(40)],
      ["c.txt", "z"],
    ]);
    const { zip64, entries } = centralDirectory(zip);
    expect(zip64).toBe(true);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    for (const e of entries) expect(zip.readUInt32LE(e.offset)).toBe(0x04034b50);
    expect(readStoredZipEntries(zip).get("c.txt")!.toString()).toBe("z");
  });

  it("stamps the Stockholm wall-clock time", () => {
    // 08:30:10Z is 09:30:10 in Stockholm in October (CET after the switch on the 25th).
    expect(stockholmDosDateTime(new Date("2026-10-27T08:30:10Z"))).toEqual(
      dosDateTime({ year: 2026, month: 10, day: 27, hour: 9, minute: 30, second: 10 })
    );
  });
});

describe("safeSegment and UniquePaths", () => {
  it("strips separators and reserved characters, keeps the extension when shortening", () => {
    expect(safeSegment("../ritning: v2?.pdf")).toBe("_ritning_ v2_.pdf");
    expect(safeSegment("  ..  ")).toBe("fil");
    const long = safeSegment(`${"a".repeat(200)}.pdf`);
    expect(long).toHaveLength(150);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("numbers repeated names within a folder, ignoring case", () => {
    const paths = new UniquePaths();
    expect(paths.claim("A", "Ritning.pdf")).toBe("A/Ritning.pdf");
    expect(paths.claim("A", "ritning.PDF")).toBe("A/ritning (2).PDF");
    expect(paths.claim("B", "Ritning.pdf")).toBe("B/Ritning.pdf");
    expect(paths.claim("A", "README")).toBe("A/README");
    expect(paths.claim("A", "README")).toBe("A/README (2)");
  });
});
