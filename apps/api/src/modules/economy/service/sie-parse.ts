// SIE file reader for the opening-balance import. Deliberately narrow: it
// reads #RAR, #KONTO and #IB and ignores everything else, including whole
// #VER/#TRANS blocks — B6b imports opening balances, not a full ledger.
import { decodeCp437 } from "./sie-encoding.js";

export class SieParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SieParseError";
  }
}

export interface ParsedSieFile {
  companyName: string | null;
  fiscalYear: { startDate: string; endDate: string };
  accounts: { number: string; name: string }[];
  // Year 0 only, debit-positive (the spec's own sign convention).
  openingBalances: { accountNumber: string; amount: number }[];
}

// The spec mandates CP437, but real exporters emit UTF-8 too (php-sie ships
// a UTF-8 path for exactly this reason). Strict UTF-8 decoding either
// succeeds — in which case the file really was UTF-8 — or throws, and then
// CP437 is the right reading. Same BOM-first idiom as the CSV parser.
function decode(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf-8");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    // A pure-ASCII file decodes as valid UTF-8 either way, and so does a
    // CP437 file that happens to contain no high bytes — both readings agree.
    return text;
  } catch {
    return decodeCp437(buffer);
  }
}

// Splits one record into fields: whitespace-separated, double quotes group,
// backslash escapes the next character inside a quoted field.
function splitFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === "\\" && i + 1 < line.length) {
        current += line[i + 1];
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) {
        fields.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) fields.push(current);
  return fields;
}

function isoDate(sieDate: string): string {
  if (!/^\d{8}$/.test(sieDate)) throw new SieParseError(`Ogiltigt datum i SIE-filen: ${sieDate}`);
  return `${sieDate.slice(0, 4)}-${sieDate.slice(4, 6)}-${sieDate.slice(6, 8)}`;
}

function amount(raw: string): number {
  // The spec allows only a leading minus, digits and at most two decimals.
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new SieParseError(`Ogiltigt belopp i SIE-filen: ${raw}`);
  }
  return Number(raw);
}

export function parseSieFile(buffer: Buffer): ParsedSieFile {
  const text = decode(buffer);
  let companyName: string | null = null;
  let fiscalYear: { startDate: string; endDate: string } | null = null;
  const accounts: { number: string; name: string }[] = [];
  const openingBalances: { accountNumber: string; amount: number }[] = [];

  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || !line.startsWith("#")) continue;
    const fields = splitFields(line);
    const label = fields[0];

    switch (label) {
      case "#FNAMN":
        companyName = fields[1] ?? null;
        break;
      case "#RAR":
        // Year index 0 is the year the balances belong to; -1 and further
        // back are comparison years we do not import.
        if (fields[1] === "0" && fields[2] && fields[3]) {
          fiscalYear = { startDate: isoDate(fields[2]), endDate: isoDate(fields[3]) };
        }
        break;
      case "#KONTO":
        if (fields[1]) accounts.push({ number: fields[1], name: fields[2] ?? fields[1] });
        break;
      case "#IB":
        if (fields[1] === "0" && fields[2] && fields[3] !== undefined) {
          openingBalances.push({ accountNumber: fields[2], amount: amount(fields[3]) });
        }
        break;
      default:
        // Everything else — #VER, #TRANS, braces, #UB, #RES — is ignored.
        break;
    }
  }

  if (!fiscalYear) {
    throw new SieParseError("Filen saknar #RAR 0 — vilket räkenskapsår balanserna gäller går inte att avgöra");
  }
  if (openingBalances.length === 0) {
    throw new SieParseError("Filen innehåller inga ingående balanser (#IB) för år 0");
  }

  return { companyName, fiscalYear, accounts, openingBalances };
}
