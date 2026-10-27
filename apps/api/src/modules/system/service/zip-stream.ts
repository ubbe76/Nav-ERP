import { crc32 } from "node:zlib";

// A streaming ZIP writer for the file export (System → Säkerhetskopiering,
// Exportera filer): every entry is STORED (PDFs and images are already
// compressed), written as soon as it is added, so only the central directory
// stays in memory. Each entry's bytes are in hand when it is added, so CRC and
// size go straight into the local header — no data descriptors. ZIP64 records
// are written only when the archive needs them: more than 65 535 entries, or
// an entry or the central directory starting beyond 4 GiB (one entry itself
// is at most 20 MB, so entry sizes never need it). Names are UTF-8 (flag 11).
// The threshold is a parameter only so the tests can reach the ZIP64 path
// without writing 4 GiB.

const UTF8_FLAG = 0x0800;
const MAX_16 = 0xffff;
const MAX_32 = 0xffffffff;

interface CentralEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

// MS-DOS date/time from the wall clock the caller gives (year 1980–2107).
export function dosDateTime(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }) {
  const year = Math.min(Math.max(parts.year, 1980), 2107);
  return {
    time: (parts.hour << 11) | (parts.minute << 5) | Math.floor(parts.second / 2),
    date: ((year - 1980) << 9) | (parts.month << 5) | parts.day,
  };
}

const STOCKHOLM = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// The entry's timestamp as Stockholm wall-clock time (zip has no time zone).
export function stockholmDosDateTime(at: Date) {
  const p = Object.fromEntries(STOCKHOLM.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return dosDateTime({ year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! });
}

export class ZipStreamWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];

  constructor(private readonly zip64Threshold = MAX_32) {}

  get entryCount() {
    return this.entries.length;
  }

  // The local header followed by the data, to write out in order.
  add(name: string, data: Buffer, modified: Date): Buffer[] {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const { time, date } = stockholmDosDateTime(modified);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({ name: nameBytes, crc, size: data.length, offset: this.offset, time, date });
    this.offset += header.length + nameBytes.length + data.length;
    return [header, nameBytes, data];
  }

  // The central directory and the end records.
  finish(): Buffer {
    const parts: Buffer[] = [];
    const cdStart = this.offset;
    for (const e of this.entries) {
      const zip64 = e.offset >= this.zip64Threshold;
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(zip64 ? 45 : 20, 4); // made by (MS-DOS, spec version)
      header.writeUInt16LE(zip64 ? 45 : 20, 6); // version needed
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(e.time, 12);
      header.writeUInt16LE(e.date, 14);
      header.writeUInt32LE(e.crc, 16);
      header.writeUInt32LE(e.size, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt16LE(zip64 ? 12 : 0, 30); // extra length
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(0, 38); // external attributes
      header.writeUInt32LE(zip64 ? MAX_32 : e.offset, 42);
      parts.push(header, e.name);
      if (zip64) {
        // ZIP64 extended information: only the field set to 0xFFFFFFFF above.
        const extra = Buffer.alloc(12);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
        parts.push(extra);
      }
    }
    const cdSize = parts.reduce((sum, b) => sum + b.length, 0);
    const count = this.entries.length;
    const needsZip64 = count > MAX_16 || cdStart >= this.zip64Threshold || cdSize >= this.zip64Threshold;

    if (needsZip64) {
      const zip64EndOffset = cdStart + cdSize;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4); // size of the rest of the record
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16); // this disk
      record.writeUInt32LE(0, 20); // disk with the central directory
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(cdSize), 40);
      record.writeBigUInt64LE(BigInt(cdStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
      locator.writeUInt32LE(1, 16); // total disks
      parts.push(record, locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needsZip64 ? MAX_16 : count, 8);
    end.writeUInt16LE(needsZip64 ? MAX_16 : count, 10);
    end.writeUInt32LE(needsZip64 ? MAX_32 : cdSize, 12);
    end.writeUInt32LE(needsZip64 ? MAX_32 : cdStart, 16);
    end.writeUInt16LE(0, 20);
    parts.push(end);
    const out = Buffer.concat(parts);
    this.offset += out.length;
    return out;
  }
}

// A path segment that is safe in every unzip tool: no separators, control or
// Windows-reserved characters, no leading/trailing dots or spaces, at most
// 150 characters (the extension is kept when shortening).
export function safeSegment(value: string, fallback = "fil"): string {
  let s = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  if (s === "") s = fallback;
  if (s.length > 150) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
    s = s.slice(0, 150 - ext.length) + ext;
  }
  return s;
}

// Hands out unique paths: a second "Ritning.pdf" in the same folder becomes
// "Ritning (2).pdf". Comparison ignores case (Windows and macOS do).
export class UniquePaths {
  private readonly taken = new Set<string>();

  claim(folder: string, filename: string): string {
    const dot = filename.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
    for (let n = 1; ; n++) {
      const path = `${folder}/${n === 1 ? filename : `${stem} (${n})${ext}`}`;
      if (!this.taken.has(path.toLowerCase())) {
        this.taken.add(path.toLowerCase());
        return path;
      }
    }
  }
}
