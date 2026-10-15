import { BankFileParseError } from "../banking.errors.js";

// A minimal, NON-validating XML reader for bank notifications (spec §3.5).
// Refuses DOCTYPE/ENTITY outright, so XXE and entity expansion are impossible
// by construction. Elements, attributes, text, CDATA; comments and PIs are
// skipped; namespace prefixes are stripped (the root's namespace is reported
// for the version check). No dependency — the CP437/CSV line.
export interface XmlNode {
  name: string;
  prefix: string | null;
  qname: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 64;
// Spec §3.5. The multipart limit already stops larger uploads; this keeps
// the reader safe for any other caller.
const MAX_BYTES = 20 * 1024 * 1024;
// A real notification has a few dozen elements per transaction; this bounds
// the tree a 20 MB upload can build. Attributes count too — otherwise one
// element with a huge attribute list would get past it.
const MAX_NODES = 500_000;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

// Parse errors reach the user (the upload answers 400 with the message), so
// any input they echo is clipped.
const ECHO_MAX = 40;
function clip(value: string): string {
  return value.length > ECHO_MAX ? `${value.slice(0, ECHO_MAX)}…` : value;
}

class NodeBudget {
  private used = 0;
  take() {
    if (++this.used > MAX_NODES) throw new BankFileParseError("Filen har för många element");
  }
}

// A character reference outside Unicode (or NUL) would make
// String.fromCodePoint throw a RangeError — a 500 instead of a 400.
function codePoint(cp: number, ref: string): string {
  if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff) throw new BankFileParseError(`Ogiltig teckenreferens &${clip(ref)};`);
  return String.fromCodePoint(cp);
}

function decodeEntities(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(";", amp);
    if (semi === -1) throw new BankFileParseError("Ogiltigt &-tecken i texten");
    const ref = raw.slice(amp + 1, semi);
    if (Object.hasOwn(NAMED, ref)) out += NAMED[ref];
    else if (/^#\d+$/.test(ref)) out += codePoint(Number(ref.slice(1)), ref);
    else if (/^#x[0-9a-fA-F]+$/.test(ref)) out += codePoint(parseInt(ref.slice(2), 16), ref);
    else throw new BankFileParseError(`Okänd entitet &${clip(ref)};`);
    i = semi + 1;
  }
  return out;
}

function tagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  throw new BankFileParseError("Filen tar slut mitt i en tagg");
}

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

// A hand-written, single-pass scanner: every character is looked at a
// bounded number of times, so a huge attribute body cannot backtrack (the
// earlier regex went quadratic on a long body without "="). Anything that
// is not name = "value" / 'value', separated by whitespace, is refused.
function parseAttrs(raw: string, budget: NodeBudget): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = raw.length;
  let i = 0;
  for (;;) {
    const before = i;
    while (i < n && isSpace(raw[i])) i++;
    if (i >= n) return attrs;
    if (i === before && before > 0) throw new BankFileParseError("Attribut måste skiljas åt med mellanslag");
    const nameStart = i;
    while (i < n && !isSpace(raw[i]) && raw[i] !== "=" && raw[i] !== '"' && raw[i] !== "'") i++;
    if (i === nameStart) throw new BankFileParseError("Attribut saknar namn");
    const name = raw.slice(nameStart, i);
    while (i < n && isSpace(raw[i])) i++;
    if (raw[i] !== "=") throw new BankFileParseError(`Attributet ${clip(name)} saknar värde`);
    i++;
    while (i < n && isSpace(raw[i])) i++;
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") throw new BankFileParseError(`Attributet ${clip(name)} saknar citattecken`);
    const end = raw.indexOf(quote, i + 1);
    if (end === -1) throw new BankFileParseError(`Attributet ${clip(name)} är inte avslutat`);
    budget.take();
    attrs[name] = decodeEntities(raw.slice(i + 1, end));
    i = end + 1;
  }
}

export function parseXml(input: string): { root: XmlNode; namespace: string | null } {
  if (Buffer.byteLength(input, "utf8") > MAX_BYTES) throw new BankFileParseError("Filen är större än 20 MB");
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new BankFileParseError("DTD och entiteter är inte tillåtna i en bankfil");
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const budget = new NodeBudget();
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const textEnd = lt === -1 ? s.length : lt;
    if (textEnd > i) {
      const text = s.slice(i, textEnd);
      if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(text);
      else if (text.trim() !== "") throw new BankFileParseError("Text utanför rotelementet");
    }
    if (lt === -1) break;
    if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt);
      if (end === -1) throw new BankFileParseError("Ofullständig XML-deklaration");
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt);
      if (end === -1) throw new BankFileParseError("Ofullständig kommentar");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt);
      if (end === -1 || stack.length === 0) throw new BankFileParseError("Ofullständig CDATA");
      stack[stack.length - 1]!.text += s.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (s.startsWith("<!", lt)) throw new BankFileParseError("Deklarationer är inte tillåtna i en bankfil");
    const gt = tagEnd(s, lt + 1);
    const raw = s.slice(lt + 1, gt);
    if (raw.startsWith("/")) {
      const qname = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new BankFileParseError(`Felaktigt avslutad tagg </${clip(qname)}>`);
      i = gt + 1;
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const match = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!match) throw new BankFileParseError("Tom tagg");
    budget.take();
    const qname = match[1]!;
    const colon = qname.indexOf(":");
    const node: XmlNode = {
      name: colon === -1 ? qname : qname.slice(colon + 1),
      prefix: colon === -1 ? null : qname.slice(0, colon),
      qname,
      attrs: parseAttrs(match[2]!, budget),
      children: [],
      text: "",
    };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    else if (root) throw new BankFileParseError("Filen har mer än ett rotelement");
    else root = node;
    if (stack.length + 1 > MAX_DEPTH) throw new BankFileParseError("Filen är för djupt nästlad");
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  if (stack.length > 0) throw new BankFileParseError("Filen tar slut mitt i ett element");
  if (!root) throw new BankFileParseError("Filen innehåller inget XML-element");
  const nsAttr = root.prefix ? `xmlns:${root.prefix}` : "xmlns";
  return { root, namespace: root.attrs[nsAttr] ?? null };
}

export function child(node: XmlNode | null, name: string): XmlNode | null {
  return node?.children.find((c) => c.name === name) ?? null;
}

export function children(node: XmlNode | null, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

export function path(node: XmlNode | null, ...names: string[]): XmlNode | null {
  let current = node;
  for (const name of names) current = child(current, name);
  return current;
}

export function textAt(node: XmlNode | null, ...names: string[]): string | null {
  const found = path(node, ...names);
  const text = found?.text.trim();
  return text ? text : null;
}
