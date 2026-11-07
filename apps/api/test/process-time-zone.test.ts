import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Vakttest, Datum är Stockholmsdagar: nothing in the API may read the
// process's own time zone. The container may run UTC (and the suite does, on
// purpose — test/setup.ts); docker-compose.yml's TZ=Europe/Stockholm is only a
// second safety. The Swedish day and wall clock come from
// system/service/delivery-days.ts (stockholmToday, stockholmDateOf,
// stockholmInstant), localDateOf, or an Intl formatter with
// timeZone: "Europe/Stockholm". Pure date arithmetic on YYYY-MM-DD goes
// through UTC (`${date}T00:00:00Z`, getUTCDay, setUTCDate) and is fine.
//
// What the guard sees, in code (comments stripped with TypeScript's own
// scanner, so a "//" or "/*" inside a string, a template or a regex is code):
// - toLocaleDateString(…) / toLocaleTimeString(…), new Date(…).toLocaleString(…)
//   and Intl.DateTimeFormat(…) (with or without new) without a timeZone in the
//   same call — a number's toLocaleString is no date and is not looked at;
//   toDateString() / toTimeString(), which take no zone at all;
// - the local getters and setters (getFullYear, getMonth, getDate, getDay,
//   getHours, getMinutes, getYear, getTimezoneOffset and their set*), not the
//   getUTC*/setUTC* ones;
// - new Date(year, month, …), the local component constructor (Date.UTC is
//   fine);
// - new Date / Date.parse of one argument holding a date-time literal without
//   Z or an offset at its end — "2026-06-10T07:00", "2026-06-10 07:00",
//   `${date}T${clock}:00`, `${date} ${clock}`, date + "T07:00" — read in the
//   local zone (a heuristic: a clock is a T or blank after a digit, an
//   interpolation or a literal's quote, followed by a digit or an
//   interpolation);
// - CURRENT_DATE, CURRENT_TIME, LOCALTIMESTAMP, LOCALTIME, now()/
//   current_timestamp cast to date/timestamp/time, and date_trunc / to_char /
//   extract on now() or current_timestamp without a zone in SQL — the
//   database session's zone, the postgres container's (UTC).
//
// It cannot see a zone-less string in a variable (new Date(value)), a Date
// variable's toLocaleString, nor `${column}::date` / date_trunc('day',
// ${column}) in SQL: whether the column is a date (fine) or a timestamptz
// (the session's UTC day — write (${column} AT TIME ZONE
// 'Europe/Stockholm')::date) is in the schema, not in the text. Review those
// by hand.
//
// The count per file is a fingerprint, as in stock-on-hand-readers.test.ts:
// a new hit in a listed file changes it, and the test asks for it to be
// classified too.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// Deliberate uses of the process's zone, with why. Empty: every reader of
// the day or the clock names its zone. A new entry needs a reason the day or
// the clock cannot be Stockholm's (or does not matter).
const ALLOWED: Record<string, { hits: number; why: string }> = {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const K = ts.SyntaxKind;

// After one of these a "/" divides; after anything else it starts a regex
// (the parser's own question, answered the way it does for ordinary code).
function endsOperand(kind: ts.SyntaxKind): boolean {
  return (
    kind === K.Identifier ||
    kind === K.PrivateIdentifier ||
    (kind > K.LastFutureReservedWord && kind <= K.LastKeyword) || // contextual keywords (type, of, get …) name things too
    kind === K.NumericLiteral ||
    kind === K.BigIntLiteral ||
    kind === K.StringLiteral ||
    kind === K.RegularExpressionLiteral ||
    kind === K.NoSubstitutionTemplateLiteral ||
    kind === K.TemplateTail ||
    kind === K.CloseParenToken ||
    kind === K.CloseBracketToken ||
    kind === K.CloseBraceToken ||
    kind === K.ThisKeyword ||
    kind === K.SuperKeyword ||
    kind === K.TrueKeyword ||
    kind === K.FalseKeyword ||
    kind === K.NullKeyword ||
    kind === K.PlusPlusToken ||
    kind === K.MinusMinusToken
  );
}

// Comments read no clock ("not the server's CURRENT_DATE"). TypeScript's
// scanner tells them from a "//" in a string ("http://…"), a "*/*" in an
// Accept header, a template or a regex; the two things only the parser knows
// — that a "}" closes a template's ${…}, and that a "/" starts a regex — are
// rescanned here. Comments become blanks; newlines stay.
function code(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const braces: boolean[] = []; // per open "{": true when it is a template's "${"
  let previous: ts.SyntaxKind = K.Unknown;
  let out = "";
  for (let kind = scanner.scan(); kind !== K.EndOfFileToken; kind = scanner.scan()) {
    if (kind === K.CloseBraceToken && braces.at(-1) === true) kind = scanner.reScanTemplateToken(false);
    else if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !endsOperand(previous)) kind = scanner.reScanSlashToken();
    const token = scanner.getTokenText();
    if (kind === K.SingleLineCommentTrivia || kind === K.MultiLineCommentTrivia) {
      out += token.replace(/[^\n]/g, " ");
      continue;
    }
    if (kind === K.OpenBraceToken) braces.push(false);
    else if (kind === K.TemplateHead) braces.push(true);
    else if (kind === K.CloseBraceToken || kind === K.TemplateTail) braces.pop(); // a TemplateMiddle keeps its ${ open
    if (kind !== K.WhitespaceTrivia && kind !== K.NewLineTrivia) previous = kind;
    out += token;
  }
  return out;
}

// The text between the parenthesis at `open` and its partner.
function callArgs(body: string, open: number): string {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const c = body[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return body.slice(open + 1);
}

// A comma outside any nested bracket: more than one argument.
function hasTopLevelComma(args: string): boolean {
  let depth = 0;
  for (const c of args) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return true;
  }
  return false;
}

// Calls that format in the process's zone unless the call names one.
const FORMATTERS = [/\.toLocaleDateString\(/g, /\.toLocaleTimeString\(/g, /new Date\([^()]*\)\.toLocaleString\(/g, /\bIntl\.DateTimeFormat\(/g];
// Date-only methods that take no zone at all.
const ZONELESS_FORMATTERS = /\.(?:toDateString|toTimeString)\(\)/g;
const LOCAL_ACCESSORS = /\.(?:get|set)(?:FullYear|Month|Date|Day|Hours|Minutes|Year|TimezoneOffset)\(/g;
const DATE_CONSTRUCTOR = /new Date\(/g;
// One argument with a date-time in it, handed to the parser.
const PARSER_CALL = /(?:new Date|Date\.parse)\(/g;
const NESTED_PARSER_CALL = /(?:new Date|Date\.parse)\(/;
const HAS_LITERAL = /["'`]/;
const HAS_CLOCK = /(?:\d|\}|["'`])[T ](?:\d|\$\{)/;
// The zone is the last thing in the argument.
const ENDS_IN_ZONE = /(?:Z|[+-]\d{2}:?\d{2})["'`]$/;
// Upper or lower case as SQL is written; a camelCase localTime variable is no SQL.
const SQL_SESSION_CLOCK = /\b(?:CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|current_date|current_time|localtimestamp|localtime)\b/g;
// The session's clock turned into a day or a wall clock in the session's zone.
const SESSION_NOW = String.raw`(?:now\(\)|current_timestamp)`;
const SQL_SESSION_DAY = new RegExp(
  [
    String.raw`\b${SESSION_NOW}\s*::\s*(?:date|timestamp|time)\b`,
    // A day or longer — an hour or less is the same in every whole-hour zone.
    String.raw`\bdate_trunc\(\s*'(?:day|week|month|quarter|year|decade|century|millennium)'\s*,\s*${SESSION_NOW}\s*\)`,
    String.raw`\bto_char\(\s*${SESSION_NOW}\s*,`,
    // Any field but the epoch, which has no zone.
    String.raw`\b(?:extract\(\s*(?!epoch\b)\w+\s+from|date_part\(\s*'(?!epoch')\w+'\s*,)\s*${SESSION_NOW}\s*\)`,
  ].join("|"),
  "gi"
);

function hitsIn(text: string): string[] {
  const body = code(text);
  const hits: string[] = [];
  for (const pattern of FORMATTERS) {
    for (const m of body.matchAll(pattern)) {
      const args = callArgs(body, m.index! + m[0].length - 1);
      if (!/\btimeZone\b/.test(args)) hits.push(`${m[0]}${args})`);
    }
  }
  for (const m of body.matchAll(ZONELESS_FORMATTERS)) hits.push(m[0]);
  for (const m of body.matchAll(LOCAL_ACCESSORS)) hits.push(m[0]);
  for (const m of body.matchAll(DATE_CONSTRUCTOR)) {
    const args = callArgs(body, m.index! + m[0].length - 1);
    if (hasTopLevelComma(args)) hits.push(`new Date(${args})`);
  }
  for (const m of body.matchAll(PARSER_CALL)) {
    const args = callArgs(body, m.index! + m[0].length - 1).trim();
    // Several arguments are the constructor above; a nested parser call is looked at on its own.
    if (hasTopLevelComma(args) || !HAS_LITERAL.test(args) || NESTED_PARSER_CALL.test(args)) continue;
    if (HAS_CLOCK.test(args) && !ENDS_IN_ZONE.test(args)) hits.push(`${m[0]}${args})`);
  }
  for (const m of body.matchAll(SQL_SESSION_CLOCK)) hits.push(m[0]);
  for (const m of body.matchAll(SQL_SESSION_DAY)) hits.push(m[0]);
  return hits;
}

describe("the process's time zone", () => {
  const found = new Map(
    sourceFiles(SRC)
      .map((path) => [relative(SRC, path).split("\\").join("/"), hitsIn(readFileSync(path, "utf8"))] as const)
      .filter(([, hits]) => hits.length > 0)
  );

  it("no file reads the day or the clock in the process's zone unless listed with a reason", () => {
    const unlisted = [...found.entries()].filter(([file]) => !(file in ALLOWED)).map(([file, hits]) => `${file}: ${hits.join(" | ")}`);
    expect(
      unlisted,
      "use stockholmToday/stockholmDateOf/stockholmInstant (system/service/delivery-days.ts) or an Intl formatter with timeZone: \"Europe/Stockholm\" — or list the file with why"
    ).toEqual([]);
  });

  it("each listed file still has as many hits as it was classified with", () => {
    const changed = Object.entries(ALLOWED)
      .filter(([file, entry]) => (found.get(file)?.length ?? 0) !== entry.hits)
      .map(([file, entry]) => `${file}: listed ${entry.hits}, found ${found.get(file)?.length ?? 0}`);
    expect(changed, "classify the new or removed hits, then update the count").toEqual([]);
  });

  it("the patterns see a local-zone read (the guard is not blind)", () => {
    // Formatting without a zone — and with one, on one line and spread over several.
    expect(hitsIn('const today = new Date().toLocaleDateString("sv-SE");')).toHaveLength(1);
    expect(hitsIn('d.toLocaleTimeString("sv-SE", { hour: "2-digit" })')).toHaveLength(1);
    expect(hitsIn('new Date(at).toLocaleString("sv-SE")')).toHaveLength(1);
    expect(hitsIn('new Intl.DateTimeFormat("sv-SE", { year: "numeric" })')).toHaveLength(1);
    expect(hitsIn('d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })')).toHaveLength(0);
    expect(
      hitsIn('const F = new Intl.DateTimeFormat("sv-SE", {\n  timeZone: "Europe/Stockholm",\n  hour: "2-digit",\n});')
    ).toHaveLength(0);
    // A number's toLocaleString is no date.
    expect(hitsIn('n.toLocaleString("sv-SE", { maximumFractionDigits: 2 })')).toHaveLength(0);
    // Local accessors; the UTC ones are fine.
    expect(hitsIn("const year = new Date().getFullYear();")).toHaveLength(1);
    expect(hitsIn("cursor.setDate(cursor.getDate() + 1);")).toHaveLength(2);
    expect(hitsIn("const h = at.getHours();")).toHaveLength(1);
    expect(hitsIn("d.setUTCDate(d.getUTCDate() + days); d.getUTCDay();")).toHaveLength(0);
    // The local component constructor; Date.UTC and a single argument are fine.
    expect(hitsIn("new Date(year, month - 1, day)")).toHaveLength(1);
    expect(hitsIn("new Date(Date.UTC(year, month - 1, day))")).toHaveLength(0);
    expect(hitsIn("new Date(now + i)")).toHaveLength(0);
    // Zone-less date-time literals; a date alone or a zone is fine.
    expect(hitsIn("new Date(`${date}T${clock}:00`)")).toHaveLength(1);
    expect(hitsIn('Date.parse("2026-06-10T07:00")')).toHaveLength(1);
    expect(hitsIn("new Date(`${date}T00:00:00Z`)")).toHaveLength(0);
    expect(hitsIn('new Date("2026-06-10T07:00:00+02:00")')).toHaveLength(0);
    expect(hitsIn('new Date("2026-06-10")')).toHaveLength(0);
    // The database session's clock.
    expect(hitsIn("sql`${invoices.dueDate} < CURRENT_DATE`")).toHaveLength(1);
    expect(hitsIn("sql`select now()::date`")).toHaveLength(1);
    expect(hitsIn("sql`where due_date < current_date`")).toHaveLength(1);
    expect(hitsIn("const localTime = stockholmNow(at).time;")).toHaveLength(0);
    expect(hitsIn("sql`(${t.createdAt} AT TIME ZONE 'Europe/Stockholm')::date`")).toHaveLength(0);
    // Comments read no clock.
    expect(hitsIn("// not new Date().toLocaleDateString(\"sv-SE\") nor CURRENT_DATE")).toHaveLength(0);
  });

  it("sees the forms the first version let through", () => {
    // A blank instead of the T, a template or a concatenation building the date-time.
    expect(hitsIn('new Date("2026-11-07 07:00")')).toHaveLength(1);
    expect(hitsIn("new Date(`${date} ${clock}`)")).toHaveLength(1);
    expect(hitsIn('new Date(date + "T07:00")')).toHaveLength(1);
    expect(hitsIn("Date.parse(`${date}T${clock}`)")).toHaveLength(1);
    expect(hitsIn('new Date(date + "T07:00:00Z")')).toHaveLength(0);
    expect(hitsIn("new Date(`${date} 07:00+01:00`)")).toHaveLength(0);
    expect(hitsIn("new Date(`${year}-01-01`)")).toHaveLength(0);
    expect(hitsIn("new Date(value)")).toHaveLength(0); // a variable cannot be read
    // Intl.DateTimeFormat without new; the zone-less Date formatters.
    expect(hitsIn('Intl.DateTimeFormat("sv-SE").format(d)')).toHaveLength(1);
    expect(hitsIn('Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(d)')).toHaveLength(0);
    expect(hitsIn("d.toDateString(); d.toTimeString()")).toHaveLength(2);
    expect(hitsIn("const toDateString = (d: Date) => d.toISOString().slice(0, 10); toDateString(d);")).toHaveLength(0);
    // The session's clock as a day, in any case; with a zone it is fine.
    expect(hitsIn("sql`select NOW()::date`")).toHaveLength(1);
    expect(hitsIn("sql`select current_timestamp::date`")).toHaveLength(1);
    expect(hitsIn("sql`select now()::timestamp`")).toHaveLength(1);
    expect(hitsIn("sql`where d >= date_trunc('day', now())`")).toHaveLength(1);
    expect(hitsIn("sql`where d >= DATE_TRUNC('month', CURRENT_TIMESTAMP)`")).toHaveLength(1);
    expect(hitsIn("sql`to_char(now(), 'YYYY-MM-DD')`")).toHaveLength(1);
    expect(hitsIn("sql`extract(dow from now())`")).toHaveLength(1);
    expect(hitsIn("sql`date_trunc('day', now(), 'Europe/Stockholm')`")).toHaveLength(0);
    expect(hitsIn("sql`(now() AT TIME ZONE 'Europe/Stockholm')::date`")).toHaveLength(0);
    expect(hitsIn("sql`date_trunc('milliseconds', now()) = x`")).toHaveLength(0);
    expect(hitsIn("sql`extract(epoch from now())`")).toHaveLength(0);
    expect(hitsIn("sql`${t.validFrom} < now() - interval '2 minutes'`")).toHaveLength(0);
    expect(hitsIn("now()::timestamptz")).toHaveLength(0);
    // Not flagged: a column's ::date, since the text cannot say whether it is
    // a date (fine) or a timestamptz (the session's UTC day).
    expect(hitsIn("sql`${t.validFrom}::date <= ${asOf}::date`")).toHaveLength(0);
  });

  it("strips comments as the compiler does, not by pattern", () => {
    // The clock read in a comment only, and in code.
    expect(hitsIn('const a = 1; // new Date().toLocaleDateString("sv-SE")')).toHaveLength(0);
    expect(hitsIn('/* new Date().toLocaleDateString("sv-SE") */ const a = 1;')).toHaveLength(0);
    expect(hitsIn('const a = 1;\nconst today = new Date().toLocaleDateString("sv-SE");')).toHaveLength(1);
    // "//" in a string, a template or a regex does not start a comment.
    expect(hitsIn('const url = "https://x"; const h = at.getHours();')).toHaveLength(1);
    expect(hitsIn("const u = `https://${host}/`; const h = at.getHours();")).toHaveLength(1);
    expect(hitsIn("const u = `a ${b} // c`; const h = at.getHours();")).toHaveLength(1);
    // "*/*" in a string (b2brouter-provider's Accept header) neither opens nor closes one.
    expect(hitsIn('const h = { accept: "*/*" };\nconst d = at.getHours();\n/* x */')).toHaveLength(1);
    // A regex holding "/*" or a quote is a regex, also after ! and return.
    expect(hitsIn("if (!/[/*]/.test(s)) n++; const h = at.getHours(); // */")).toHaveLength(1);
    expect(hitsIn("function f(s) { return /[\"']/.test(s) && at.getHours(); }")).toHaveLength(1);
    // Division stays division.
    expect(hitsIn("const r = a / b; const s = (c) / d / e; const h = at.getHours();")).toHaveLength(1);
    // A template inside a template's ${…}, and an object literal in one.
    expect(hitsIn("const s = `${`${a}`} ${{ x: 1 }.x} // ${b}`; const h = at.getHours();")).toHaveLength(1);
  });

  it("reads every line of a file with a */* string (the first version lost 47 lines of b2brouter-provider.ts)", () => {
    const path = join(SRC, "modules/einvoice/service/b2brouter-provider.ts");
    const text = readFileSync(path, "utf8");
    const stripped = code(text);
    expect(stripped.length).toBe(text.length);
    expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
    // A probe after the code line comparing the Accept header with "*/*" is seen.
    const marker = text.indexOf('accept === "*/*"');
    expect(marker).toBeGreaterThan(0);
    const lineEnd = text.indexOf("\n", marker);
    const probed = `${text.slice(0, lineEnd)}\nconst probe = new Date().toLocaleDateString("sv-SE");${text.slice(lineEnd)}`;
    expect(hitsIn(probed)).toHaveLength(hitsIn(text).length + 1);
  });
});
