// Configurator formula language (konfiguratorns formelspråk): quantities on configured structure lines and
// times on configured operations are computed from the configuration's effective values.
//
// Formulas are user input. They are tokenised and parsed by hand into a syntax tree (recursive descent) and
// evaluated by walking that tree — never `eval`/`Function`. Every input terminates: the source is capped at
// MAX_FORMULA_LENGTH characters and nesting at MAX_FORMULA_DEPTH levels, and every evaluation result is a
// finite number or an error, never NaN/Infinity.
//
// Pure module: no DB imports.
import { roundUpToMultiple } from "@navet/shared";

export const MAX_FORMULA_LENGTH = 500;
export const MAX_FORMULA_DEPTH = 32;

export type FormulaGroupInfo = { code: string; kind: "choice" | "boolean" | "number"; valueCodes: string[] };

export type FormulaCompareOp = "=" | "<>" | "<" | "<=" | ">" | ">=";

/** Syntax tree. `pos` is the 1-based character index of the node's first character (for `cmp`: its operator). */
export type FormulaAst =
  | { type: "num"; value: number; text: string; pos: number } // text as written (all-digit code check)
  | { type: "ref"; code: string; pos: number } // code is upper-cased
  | { type: "str"; value: string; pos: number } // value is upper-cased
  | { type: "neg"; operand: FormulaAst; pos: number }
  | { type: "bin"; op: "+" | "-" | "*" | "/"; left: FormulaAst; right: FormulaAst; pos: number }
  | { type: "call"; name: string; args: FormulaAst[]; pos: number } // name as written
  | { type: "cmp"; op: FormulaCompareOp; left: FormulaAst; right: FormulaAst; pos: number };

export type FormulaError = { message: string; position: number };

export type FormulaValues = Map<string, { kind: "choice" | "boolean" | "number"; value: string | boolean | number | null }>;

// ---------------------------------------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { type: "num"; value: number; text: string; pos: number }
  | { type: "ident"; text: string; pos: number }
  | { type: "str"; value: string; text: string; pos: number }
  | { type: "op"; text: string; pos: number } // + - * / ( ) ; and comparison operators
  | { type: "bad"; text: string; pos: number } // a character that cannot start or continue a token
  | { type: "eof"; text: ""; pos: number };

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isIdentStart = (c: string | undefined) =>
  c !== undefined && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_");
const isIdentPart = (c: string | undefined) => isIdentStart(c) || isDigit(c);
const isCodeChar = (c: string | undefined) =>
  c !== undefined && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || isDigit(c));
const MAX_STRING_LENGTH = 20;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const pos = i + 1;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

    if (isDigit(c)) {
      let j = i;
      while (isDigit(src[j])) j++;
      if (isIdentStart(src[j])) {
        // An identifier may start with digits (e.g. a code like 2DORR); it must contain a letter or '_'.
        while (isIdentPart(src[j])) j++;
        tokens.push({ type: "ident", text: src.slice(i, j), pos });
        i = j;
        continue;
      }
      // A '.' or ',' directly between digits is the decimal separator; ';' always separates arguments.
      if ((src[j] === "." || src[j] === ",") && isDigit(src[j + 1])) {
        j++;
        while (isDigit(src[j])) j++;
      }
      const text = src.slice(i, j);
      tokens.push({ type: "num", value: Number(text.replace(",", ".")), text, pos });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (isIdentPart(src[j])) j++;
      tokens.push({ type: "ident", text: src.slice(i, j), pos });
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let bad: Token | null = null;
      while (j < src.length && src[j] !== '"') {
        if (!isCodeChar(src[j]) || j - i > MAX_STRING_LENGTH) { bad = { type: "bad", text: src[j]!, pos: j + 1 }; break; }
        j++;
      }
      if (!bad && j >= src.length) bad = { type: "bad", text: '"', pos }; // unterminated
      if (!bad && j === i + 1) bad = { type: "bad", text: '"', pos: j + 1 }; // empty ""
      if (bad) { tokens.push(bad); return finish(tokens, src); }
      const value = src.slice(i + 1, j);
      tokens.push({ type: "str", value: value.toUpperCase(), text: src.slice(i, j + 1), pos });
      i = j + 1;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ type: "op", text: two, pos });
      i += 2;
      continue;
    }
    if ("+-*/();=<>".includes(c)) {
      tokens.push({ type: "op", text: c, pos });
      i++;
      continue;
    }

    // Unknown character: the parser reports it when (and only if) it reaches it, so an earlier syntax
    // error still wins.
    tokens.push({ type: "bad", text: c, pos });
    return finish(tokens, src);
  }
  return finish(tokens, src);
}

function finish(tokens: Token[], src: string): Token[] {
  tokens.push({ type: "eof", text: "", pos: src.length + 1 });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------------

class FormulaSyntaxError extends Error {
  constructor(readonly formulaError: FormulaError) {
    super(formulaError.message);
  }
}

const at = (message: string, position: number): FormulaError => ({ message: `${message} (tecken ${position})`, position });

const COMPARE_OPS = new Set<string>(["=", "<>", "<", "<=", ">", ">="]);

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaAst {
    const ast = this.arg();
    if (this.peek().type !== "eof") this.unexpected(this.peek());
    return ast;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.index++;
    return t;
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.type === "op" && t.text === text;
  }

  private expectOp(text: string): void {
    if (!this.isOp(text)) this.unexpected(this.peek());
    this.next();
  }

  private unexpected(t: Token): never {
    if (t.type === "eof") throw new FormulaSyntaxError({ message: "Formeln slutar oväntat", position: t.pos });
    // A no-break space (often pasted from a formatted number) is invisible inside quotes, so name it.
    if (t.text === "\u00a0" || t.text === "\u202f") throw new FormulaSyntaxError(at("Oväntat tecken (hårt mellanslag)", t.pos));
    throw new FormulaSyntaxError(at(`Oväntat tecken "${t.text}"`, t.pos));
  }

  private enter(pos: number): void {
    this.depth++;
    if (this.depth > MAX_FORMULA_DEPTH) throw new FormulaSyntaxError(at("För djup nästling", pos));
  }

  private leave(): void {
    this.depth--;
  }

  // arg := expr (CMP expr)? — whether a comparison is allowed here is checked by the validator.
  private arg(): FormulaAst {
    const left = this.expr();
    const t = this.peek();
    if (t.type === "op" && COMPARE_OPS.has(t.text)) {
      this.next();
      const right = this.expr();
      return { type: "cmp", op: t.text as FormulaCompareOp, left, right, pos: t.pos };
    }
    return left;
  }

  // expr := term (('+'|'-') term)*
  private expr(): FormulaAst {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().text as "+" | "-";
      const right = this.term();
      left = { type: "bin", op, left, right, pos: left.pos };
    }
    return left;
  }

  // term := unary (('*'|'/') unary)*
  private term(): FormulaAst {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next().text as "*" | "/";
      const right = this.unary();
      left = { type: "bin", op, left, right, pos: left.pos };
    }
    return left;
  }

  // unary := ('-'|'+') unary | primary — every nested sign is one level of nesting.
  private unary(): FormulaAst {
    if (this.isOp("-") || this.isOp("+")) {
      const sign = this.next();
      this.enter(sign.pos);
      const operand = this.unary();
      this.leave();
      return sign.text === "-" ? { type: "neg", operand, pos: sign.pos } : operand;
    }
    return this.primary();
  }

  // primary := NUMBER | STRING | IDENT | IDENT '(' args ')' | '(' expr ')'
  // A parenthesis or a function call is one level of nesting. STRING is accepted anywhere here so the
  // validator can explain where a quoted value code is allowed.
  private primary(): FormulaAst {
    const t = this.next();
    if (t.type === "num") return { type: "num", value: t.value, text: t.text, pos: t.pos };
    if (t.type === "str") return { type: "str", value: t.value, pos: t.pos };
    if (t.type === "ident") {
      if (!this.isOp("(")) return { type: "ref", code: t.text.toUpperCase(), pos: t.pos };
      this.enter(t.pos);
      this.next(); // '('
      const args = [this.arg()];
      while (this.isOp(";")) {
        this.next();
        args.push(this.arg());
      }
      this.expectOp(")");
      this.leave();
      return { type: "call", name: t.text, args, pos: t.pos };
    }
    if (t.type === "op" && t.text === "(") {
      this.enter(t.pos);
      const inner = this.arg();
      this.expectOp(")");
      this.leave();
      return inner;
    }
    return this.unexpected(t);
  }
}

export function parseFormula(source: string): { ok: true; ast: FormulaAst } | { ok: false; error: FormulaError } {
  if (source.length > MAX_FORMULA_LENGTH) {
    return { ok: false, error: { message: `Formeln är för lång (högst ${MAX_FORMULA_LENGTH} tecken)`, position: MAX_FORMULA_LENGTH + 1 } };
  }
  try {
    return { ok: true, ast: new Parser(tokenize(source)).parse() };
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return { ok: false, error: e.formulaError };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------------------------------------

type FunctionName = "min" | "max" | "avrunda" | "avrunda_upp" | "avrunda_ned" | "om";

const ARITY: Record<FunctionName, { min: number; max: number; text: string }> = {
  min: { min: 2, max: Infinity, text: "tar minst 2 argument" },
  max: { min: 2, max: Infinity, text: "tar minst 2 argument" },
  avrunda: { min: 1, max: 2, text: "tar 1 eller 2 argument" },
  avrunda_upp: { min: 2, max: 2, text: "tar exakt 2 argument" },
  avrunda_ned: { min: 2, max: 2, text: "tar exakt 2 argument" },
  om: { min: 3, max: 3, text: "tar exakt 3 argument" },
};

function functionName(name: string): FunctionName | null {
  const lower = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(ARITY, lower) ? (lower as FunctionName) : null;
}

const DECIMALS_MESSAGE = "Decimalerna i avrunda måste vara ett heltal 0–4";
const STEP_MESSAGE = "Steget måste vara större än 0";
const validDecimals = (n: number) => Number.isInteger(n) && n >= 0 && n <= 4;

const round4 = (x: number) => Number(x.toFixed(4));

/** `1E308` is an identifier under the grammar; an unknown one gets a hint that exponents are not supported. */
const unknownCode = (code: string) =>
  /^[0-9]+E[0-9]+$/.test(code) ? `Okänd kod ${code} — tal skrivs utan exponent` : `Okänd kod ${code}`;

/** Down to a multiple of step; the ratio goes through toFixed(6) like roundUpToMultiple (robust at 1e8 / 0.1). */
const floorToMultiple = (x: number, step: number) => round4(Math.floor(Number((x / step).toFixed(6))) * step);

/** Up to a multiple of step: the shared roundUpToMultiple for x > 0, mirrored avrunda_ned for x <= 0. */
const ceilToMultiple = (x: number, step: number) => (x > 0 ? roundUpToMultiple(x, step) : -floorToMultiple(-x, step) || 0);

/** Rounds half away from zero at `decimals`; toPrecision(15) strips binary noise (1.005 × 100 = 100.4999…). */
function roundHalfAway(x: number, decimals: number): number {
  const scale = 10 ** decimals;
  const scaled = Number((Math.abs(x) * scale).toPrecision(15));
  return (Math.sign(x) * Math.round(scaled)) / scale;
}

// ---------------------------------------------------------------------------------------------------------
// Validation (at save)
// ---------------------------------------------------------------------------------------------------------

class FormulaValidationError extends Error {
  constructor(readonly formulaError: FormulaError) {
    super(formulaError.message);
  }
}

/** Constant value of a subtree without codes, or null (also when its evaluation fails). */
function constantValue(node: FormulaAst): number | null {
  if (collectRefs(node, new Set()).size > 0) return null;
  const r = evaluateAst(node, new Map(), { roundResult: false });
  return r.ok ? r.value : null;
}

export function validateFormula(source: string, groups: FormulaGroupInfo[]): FormulaError | null {
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed.error;
  const byCode = new Map(groups.map((g) => [g.code.toUpperCase(), g]));
  const fail = (message: string, pos: number): never => { throw new FormulaValidationError(at(message, pos)); };

  const group = (ref: { code: string; pos: number }): FormulaGroupInfo =>
    byCode.get(ref.code) ?? fail(unknownCode(ref.code), ref.pos);

  const choiceMessage = (g: FormulaGroupInfo) =>
    `${g.code.toUpperCase()} är ett listval och kan bara jämföras med en alternativkod, t.ex. ${g.code.toUpperCase()} = "${g.valueCodes[0] ?? "KOD"}"`;

  // A numeric operand: anything but a comparison, a choice or a quoted value code.
  const numeric = (node: FormulaAst): void => {
    switch (node.type) {
      case "num":
        // An all-digit group code reads as a number literal and would be silently ignored.
        if (byCode.has(node.text)) {
          fail(`Koden ${node.text} består bara av siffror och kan inte användas i en formel — byt kod på valgruppen`, node.pos);
        }
        return;
      case "ref": {
        const g = group(node);
        if (g.kind === "choice") fail(choiceMessage(g), node.pos);
        return;
      }
      case "str":
        return fail(`"${node.value}" kan bara jämföras med ett listval`, node.pos);
      case "neg":
        return numeric(node.operand);
      case "bin":
        numeric(node.left);
        numeric(node.right);
        return;
      case "cmp":
        return fail("Jämförelser är bara tillåtna som första argument i om", node.pos);
      case "call":
        return call(node);
    }
  };

  const comparison = (node: Extract<FormulaAst, { type: "cmp" }>): void => {
    if (node.left.type === "str" && node.right.type === "ref") {
      const g = group(node.right);
      if (g.kind === "choice") fail(`Koden ska stå till vänster: ${g.code.toUpperCase()} = "${node.left.value}"`, node.left.pos);
    }
    if (node.right.type === "str") {
      const str = node.right;
      if (node.left.type === "ref") {
        const g = group(node.left);
        if (g.kind !== "choice") fail(`"${str.value}" kan bara jämföras med ett listval`, str.pos);
        if (node.op !== "=" && node.op !== "<>") fail("Ett listval kan bara jämföras med = eller <>", node.pos);
        if (!g.valueCodes.some((v) => v.toUpperCase() === str.value)) {
          fail(`"${str.value}" är inget alternativ i ${g.code.toUpperCase()}`, str.pos);
        }
        return;
      }
      numeric(node.left);
      return fail(`"${str.value}" kan bara jämföras med ett listval`, str.pos);
    }
    numeric(node.left);
    numeric(node.right);
  };

  const call = (node: Extract<FormulaAst, { type: "call" }>): void => {
    const fn = functionName(node.name) ?? fail(`Okänd funktion ${node.name}`, node.pos);
    const arity = ARITY[fn];
    if (node.args.length < arity.min || node.args.length > arity.max) fail(`${fn} ${arity.text}`, node.pos);
    if (fn === "om") {
      const [cond, ...branches] = node.args;
      if (cond!.type !== "cmp") fail("om kräver en jämförelse som första argument", node.pos);
      comparison(cond as Extract<FormulaAst, { type: "cmp" }>);
      branches.forEach(numeric);
      return;
    }
    node.args.forEach(numeric);
    const second = node.args[1];
    if (second && fn === "avrunda") {
      const n = constantValue(second);
      if (n !== null && !validDecimals(n)) fail(DECIMALS_MESSAGE, second.pos);
    }
    if (second && (fn === "avrunda_upp" || fn === "avrunda_ned")) {
      const step = constantValue(second);
      if (step !== null && step <= 0) fail(STEP_MESSAGE, second.pos);
    }
  };

  try {
    numeric(parsed.ast);
    return null;
  } catch (e) {
    if (e instanceof FormulaValidationError) return e.formulaError;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------------------

function collectRefs(node: FormulaAst, into: Set<string>): Set<string> {
  switch (node.type) {
    case "ref": into.add(node.code); break;
    case "neg": collectRefs(node.operand, into); break;
    case "bin": case "cmp": collectRefs(node.left, into); collectRefs(node.right, into); break;
    case "call": for (const a of node.args) collectRefs(a, into); break;
    default: break;
  }
  return into;
}

/** Upper-cased codes the formula uses; an empty set when it does not parse. */
export function formulaReferences(source: string): Set<string> {
  const parsed = parseFormula(source);
  return parsed.ok ? collectRefs(parsed.ast, new Set()) : new Set();
}

function collectValueRefs(node: FormulaAst, into: Set<string>): Set<string> {
  switch (node.type) {
    case "cmp": {
      // Either side order: the validator rejects `"EP" = FARG`, but the rename lock must still see a code that is
      // referenced however the stored formula is written.
      const ref = node.left.type === "ref" ? node.left : node.right.type === "ref" ? node.right : null;
      const str = node.left.type === "str" ? node.left : node.right.type === "str" ? node.right : null;
      if (ref && str) into.add(`${ref.code}=${str.value}`);
      collectValueRefs(node.left, into);
      collectValueRefs(node.right, into);
      break;
    }
    case "neg": collectValueRefs(node.operand, into); break;
    case "bin": collectValueRefs(node.left, into); collectValueRefs(node.right, into); break;
    case "call": for (const a of node.args) collectValueRefs(a, into); break;
    default: break;
  }
  return into;
}

/**
 * Every quoted alternative code the formula compares a group code against, as upper-cased `GROUP=ALT` pairs
 * (`om(FARG = "EP"; …)` → `FARG=EP`); an empty set when it does not parse. The alternative-code rename lock.
 */
export function formulaValueReferences(source: string): Set<string> {
  const parsed = parseFormula(source);
  return parsed.ok ? collectValueRefs(parsed.ast, new Set()) : new Set();
}

// ---------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------

class FormulaEvaluationError extends Error {}

const NOT_A_NUMBER = "Resultatet är inte ett giltigt tal";

function finite(x: number): number {
  if (!Number.isFinite(x)) throw new FormulaEvaluationError(NOT_A_NUMBER);
  return x;
}

function evaluateAst(
  ast: FormulaAst, values: FormulaValues, opts: { roundResult: boolean } = { roundResult: true },
): { ok: true; value: number } | { ok: false; message: string } {
  const fail = (message: string): never => { throw new FormulaEvaluationError(message); };

  const lookup = (code: string) => values.get(code) ?? fail(unknownCode(code));

  const num = (node: FormulaAst): number => {
    switch (node.type) {
      case "num":
        return finite(node.value);
      case "ref": {
        const v = lookup(node.code);
        if (v.kind === "boolean") return v.value === true ? 1 : 0;
        if (v.kind === "choice") return fail(`${node.code} är ett listval och kan bara jämföras med en alternativkod`);
        if (typeof v.value !== "number") return fail(`${node.code} saknar värde`);
        return finite(v.value);
      }
      case "str":
        return fail(`"${node.value}" kan bara jämföras med ett listval`);
      case "neg":
        return -num(node.operand);
      case "bin": {
        const l = num(node.left);
        const r = num(node.right);
        switch (node.op) {
          case "+": return finite(l + r);
          case "-": return finite(l - r);
          case "*": return finite(l * r);
          case "/": return r === 0 ? fail("Division med noll") : finite(l / r);
        }
        break;
      }
      case "cmp":
        return fail("Jämförelser är bara tillåtna som första argument i om");
      case "call":
        return call(node);
    }
    return fail(NOT_A_NUMBER);
  };

  const test = (node: FormulaAst): boolean => {
    if (node.type !== "cmp") return fail("om kräver en jämförelse som första argument");
    if (node.right.type === "str") {
      const str = node.right;
      if (node.left.type !== "ref") return fail(`"${str.value}" kan bara jämföras med ett listval`);
      const v = lookup(node.left.code);
      if (v.kind !== "choice") return fail(`"${str.value}" kan bara jämföras med ett listval`);
      // A choice without a value is never equal to any value code.
      const equal = typeof v.value === "string" && v.value.toUpperCase() === str.value;
      if (node.op === "=") return equal;
      if (node.op === "<>") return !equal;
      return fail("Ett listval kan bara jämföras med = eller <>");
    }
    // Both sides at 4 decimals, so float noise (1200 × 0,07 = 84.00000000000001) never picks the wrong branch.
    const l = round4(num(node.left));
    const r = round4(num(node.right));
    switch (node.op) {
      case "=": return l === r;
      case "<>": return l !== r;
      case "<": return l < r;
      case "<=": return l <= r;
      case ">": return l > r;
      case ">=": return l >= r;
    }
  };

  const call = (node: Extract<FormulaAst, { type: "call" }>): number => {
    const fn = functionName(node.name) ?? fail(`Okänd funktion ${node.name}`);
    const arity = ARITY[fn];
    if (node.args.length < arity.min || node.args.length > arity.max) fail(`${fn} ${arity.text}`);
    const args = node.args;
    switch (fn) {
      case "om":
        // Only the chosen branch is evaluated.
        return test(args[0]!) ? num(args[1]!) : num(args[2]!);
      case "min":
        return Math.min(...args.map(num));
      case "max":
        return Math.max(...args.map(num));
      case "avrunda": {
        const x = num(args[0]!);
        const n = args[1] ? num(args[1]) : 0;
        if (!validDecimals(n)) fail(DECIMALS_MESSAGE);
        return finite(roundHalfAway(x, n));
      }
      case "avrunda_upp": {
        const x = num(args[0]!);
        const step = num(args[1]!);
        if (step <= 0) fail(STEP_MESSAGE);
        return finite(ceilToMultiple(x, step));
      }
      case "avrunda_ned": {
        const x = num(args[0]!);
        const step = num(args[1]!);
        if (step <= 0) fail(STEP_MESSAGE);
        return finite(floorToMultiple(x, step));
      }
    }
  };

  try {
    const raw = finite(num(ast));
    const value = opts.roundResult ? round4(raw) : raw;
    return { ok: true, value: finite(value) };
  } catch (e) {
    if (e instanceof FormulaEvaluationError) return { ok: false, message: e.message };
    throw e;
  }
}

/**
 * Evaluates a formula against effective values (key = upper-cased code). The result is finite and rounded
 * to 4 decimals, or an error message. Syntax errors are reported with their message; unknown functions and
 * wrong argument counts are reported at evaluation too, so an unvalidated formula still cannot misbehave.
 */
export function evaluateFormula(source: string, values: FormulaValues): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = parseFormula(source);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  return evaluateAst(parsed.ast, values);
}
