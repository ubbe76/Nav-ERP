// SIE file reader. Two consumers: the opening-balance import (parseSieFile:
// #RAR, #KONTO, #IB — B6b) and the verification import (parseSieVerifications:
// #VER with #TRANS — etapp 3). Both read the same document model built by
// parseSieDocument; the narrowing and the "this file has what I need" checks
// are each consumer's own.
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

// A #TRANS row: debit-positive amount, the object list ({dimension object}
// pairs) kept but not used until kostnadsställen (etapp 5).
export interface ParsedSieTransaction {
  accountNumber: string;
  objects: { dimension: string; object: string }[];
  amount: number;
  transDate: string | null;
  description: string | null;
}

// A #VER block. series/number are the file's own (text — SIE allows letters
// in both); the importer assigns Nav's series and number.
export interface ParsedSieVerification {
  series: string;
  number: string;
  date: string;
  text: string;
  rows: ParsedSieTransaction[];
}

export interface ParsedSieDocument {
  program: string | null;
  companyName: string | null;
  fiscalYears: { index: number; startDate: string; endDate: string }[];
  accounts: { number: string; name: string }[];
  openingBalances: { accountNumber: string; amount: number }[];
  verifications: ParsedSieVerification[];
  // #OBJEKT dimnr objektnr objektnamn — the names the import gives the cost
  // centers/projects it creates (kostnadsställen och projekt).
  objects: { dimension: string; code: string; name: string | null }[];
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
// backslash escapes the next character inside a quoted field, and a brace
// list `{…}` outside quotes is ONE field (the #TRANS object list — it may
// itself hold spaces and quoted strings). The braces are kept so the caller
// can tell a list from a plain field.
export function splitFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  let braceDepth = 0;

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
        // Inside a brace list the quote characters are kept for the inner
        // split; outside they just delimit the field.
        if (braceDepth > 0) current += ch;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      if (braceDepth > 0) current += ch;
      continue;
    }
    if (ch === "{") {
      if (braceDepth === 0 && started) {
        fields.push(current);
        current = "";
      }
      braceDepth++;
      started = true;
      current += ch;
      continue;
    }
    if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      current += ch;
      if (braceDepth === 0) {
        fields.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if ((ch === " " || ch === "\t") && braceDepth === 0) {
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

// YYYYMMDD → ISO. The shape alone is not enough: 20260230 is eight digits
// and would reach Postgres as an invalid date (a 500) — a UTC round trip
// catches it here, as a 400 with the offending value.
function isoDate(sieDate: string): string {
  if (!/^\d{8}$/.test(sieDate)) throw new SieParseError(`Ogiltigt datum i SIE-filen: ${sieDate}`);
  const year = Number(sieDate.slice(0, 4));
  const month = Number(sieDate.slice(4, 6));
  const day = Number(sieDate.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new SieParseError(`Ogiltigt datum i SIE-filen: ${sieDate}`);
  }
  return `${sieDate.slice(0, 4)}-${sieDate.slice(4, 6)}-${sieDate.slice(6, 8)}`;
}

function amount(raw: string): number {
  // The spec allows only a leading minus, digits and at most two decimals.
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new SieParseError(`Ogiltigt belopp i SIE-filen: ${raw}`);
  }
  return Number(raw);
}

// "{1 "100" 2 "Avd"}" → [{dimension: "1", object: "100"}, …]. An empty list
// {} is the common case.
function parseObjectList(raw: string): { dimension: string; object: string }[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = splitFields(inner);
  const objects: { dimension: string; object: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    objects.push({ dimension: parts[i]!, object: parts[i + 1]! });
  }
  return objects;
}

function isObjectList(field: string | undefined): field is string {
  return field !== undefined && field.startsWith("{") && field.endsWith("}");
}

// #TRANS kontonr {objektlista} belopp [transdat] [transtext] [kvantitet] [sign]
// The object list is optional in practice (older exporters omit it), so the
// amount is the first field after the account that is not a brace list.
function parseTrans(fields: string[]): ParsedSieTransaction {
  const accountNumber = fields[1];
  if (!accountNumber) throw new SieParseError("#TRANS utan kontonummer");
  let next = 2;
  let objects: { dimension: string; object: string }[] = [];
  if (isObjectList(fields[next])) {
    objects = parseObjectList(fields[next]!);
    next++;
  }
  const rawAmount = fields[next];
  if (rawAmount === undefined) throw new SieParseError(`#TRANS ${accountNumber} utan belopp`);
  const transDateRaw = fields[next + 1];
  const description = fields[next + 2];
  return {
    accountNumber,
    objects,
    amount: amount(rawAmount),
    transDate: transDateRaw !== undefined && transDateRaw !== "" ? isoDate(transDateRaw) : null,
    description: description !== undefined && description !== "" ? description : null,
  };
}

export function parseSieDocument(buffer: Buffer): ParsedSieDocument {
  const text = decode(buffer);
  let program: string | null = null;
  let companyName: string | null = null;
  const fiscalYears: ParsedSieDocument["fiscalYears"] = [];
  const accounts: { number: string; name: string }[] = [];
  const openingBalances: { accountNumber: string; amount: number }[] = [];
  const verifications: ParsedSieVerification[] = [];
  const objects: ParsedSieDocument["objects"] = [];

  // The #VER block being read: its header, then `{`, its #TRANS rows, `}`.
  let current: ParsedSieVerification | null = null;
  let inBlock = false;

  // A #VER header must be followed by its `{ … }` block (SIE 4: the rows ARE
  // the verification). A header with no block is a broken file, refused
  // rather than dropped silently.
  function assertNoOpenHeader(where: string) {
    if (current && !inBlock) {
      throw new SieParseError(`#VER ${current.series} ${current.number} saknar sitt { … }-block (${where})`);
    }
  }

  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line === "{") {
      if (current) inBlock = true;
      continue;
    }
    if (line === "}") {
      if (current && inBlock) {
        verifications.push(current);
        current = null;
        inBlock = false;
      }
      continue;
    }
    if (!line.startsWith("#")) continue;

    const fields = splitFields(line);
    const label = fields[0];
    // Any record between a #VER header and its `{` means the block is missing.
    assertNoOpenHeader(`följs av ${label ?? "en annan post"}`);

    // Inside a #VER block only the transaction records matter. #RTRANS is a
    // row's original (the spec says a #TRANS with the same content follows
    // for backwards compatibility) and #BTRANS a removed row — neither is a
    // booked row.
    if (current && inBlock) {
      if (label === "#TRANS") current.rows.push(parseTrans(fields));
      continue;
    }

    switch (label) {
      case "#PROGRAM":
        program = fields.slice(1).filter((f) => f !== "").join(" ") || null;
        break;
      case "#FNAMN":
        companyName = fields[1] ?? null;
        break;
      case "#RAR":
        if (fields[1] !== undefined && fields[2] && fields[3]) {
          fiscalYears.push({ index: Number(fields[1]), startDate: isoDate(fields[2]), endDate: isoDate(fields[3]) });
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
      case "#OBJEKT":
        if (fields[1] && fields[2]) objects.push({ dimension: fields[1], code: fields[2], name: fields[3] && fields[3] !== "" ? fields[3] : null });
        break;
      case "#VER": {
        // #VER serie vernr verdatum [vertext] [regdatum] [sign]
        const dateRaw = fields[3];
        if (!dateRaw) throw new SieParseError(`#VER ${fields[1] ?? ""} ${fields[2] ?? ""} saknar datum`);
        current = {
          series: fields[1] ?? "",
          number: fields[2] ?? "",
          date: isoDate(dateRaw),
          text: fields[4] ?? "",
          rows: [],
        };
        inBlock = false;
        break;
      }
      default:
        // #UB, #RES, #FLAGGA, #FORMAT, #GEN, #SIETYP, #ORGNR, #DIM …
        break;
    }
  }
  if (current && inBlock) throw new SieParseError("Filen slutar mitt i ett #VER-block");
  assertNoOpenHeader("filen slutar");

  return { program, companyName, fiscalYears, accounts, openingBalances, verifications, objects };
}

// The opening-balance import's view: #RAR 0 and at least one #IB 0.
export function parseSieFile(buffer: Buffer): ParsedSieFile {
  const document = parseSieDocument(buffer);
  // Year index 0 is the year the balances belong to; -1 and further back are
  // comparison years we do not import.
  const year0 = document.fiscalYears.find((year) => year.index === 0);
  if (!year0) {
    throw new SieParseError("Filen saknar #RAR 0 — vilket räkenskapsår balanserna gäller går inte att avgöra");
  }
  if (document.openingBalances.length === 0) {
    throw new SieParseError("Filen innehåller inga ingående balanser (#IB) för år 0");
  }
  return {
    companyName: document.companyName,
    fiscalYear: { startDate: year0.startDate, endDate: year0.endDate },
    accounts: document.accounts,
    openingBalances: document.openingBalances,
  };
}
