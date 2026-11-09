import ts from "typescript";

// Shared scanner for the time-zone guards (process-time-zone.test.ts for the API,
// web-process-time-zone.test.ts for the web): ONE implementation of what counts
// as reading the process's zone.

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
export function code(text: string): string {
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

export function hitsIn(text: string): string[] {
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
