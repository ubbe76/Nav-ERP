// A minimal, NON-validating XML reader — written for the bank notifications
// (banking spec §3.5), shared since the e-invoice reception reads received
// UBL with it (banking/service/iso20022/xml-reader.ts wraps it with the
// bank file's limits and error class). Refuses DOCTYPE/ENTITY outright, so
// XXE and entity expansion are impossible by construction. Elements,
// attributes, text, CDATA; comments and PIs are skipped; namespace prefixes
// are stripped (the root's namespace is reported for the version check). No
// dependency. The limits are parameters: a UBL with an embedded PDF is
// larger than a bank file, so each caller states its own ceiling.

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

export interface XmlLimits {
  maxBytes: number;
  // Elements AND attributes count — otherwise one element with a huge
  // attribute list would get past the cap that bounds the tree.
  maxNodes: number;
}

export interface XmlNode {
  name: string;
  prefix: string | null;
  qname: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 64;
// The bank file's limits (banking spec §3.5): the multipart limit already
// stops larger uploads, and a real notification has a few dozen elements
// per transaction, so 500 000 nodes bounds what a 20 MB upload can build.
export const DEFAULT_XML_LIMITS: XmlLimits = { maxBytes: 20 * 1024 * 1024, maxNodes: 500_000 };
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

// Parse errors reach the user (the upload answers 400 with the message), so
// any input they echo is clipped.
const ECHO_MAX = 40;
function clip(value: string): string {
  return value.length > ECHO_MAX ? `${value.slice(0, ECHO_MAX)}…` : value;
}

class NodeBudget {
  private used = 0;
  constructor(private readonly max: number) {}
  take() {
    if (++this.used > this.max) throw new XmlParseError("Filen har för många element");
  }
}

// A character reference outside Unicode (or NUL) would make
// String.fromCodePoint throw a RangeError — a 500 instead of a 400.
function codePoint(cp: number, ref: string): string {
  if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff) throw new XmlParseError(`Ogiltig teckenreferens &${clip(ref)};`);
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
    if (semi === -1) throw new XmlParseError("Ogiltigt &-tecken i texten");
    const ref = raw.slice(amp + 1, semi);
    if (Object.hasOwn(NAMED, ref)) out += NAMED[ref];
    else if (/^#\d+$/.test(ref)) out += codePoint(Number(ref.slice(1)), ref);
    else if (/^#x[0-9a-fA-F]+$/.test(ref)) out += codePoint(parseInt(ref.slice(2), 16), ref);
    else throw new XmlParseError(`Okänd entitet &${clip(ref)};`);
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
  throw new XmlParseError("Filen tar slut mitt i en tagg");
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
    if (i === before && before > 0) throw new XmlParseError("Attribut måste skiljas åt med mellanslag");
    const nameStart = i;
    while (i < n && !isSpace(raw[i]) && raw[i] !== "=" && raw[i] !== '"' && raw[i] !== "'") i++;
    if (i === nameStart) throw new XmlParseError("Attribut saknar namn");
    const name = raw.slice(nameStart, i);
    while (i < n && isSpace(raw[i])) i++;
    if (raw[i] !== "=") throw new XmlParseError(`Attributet ${clip(name)} saknar värde`);
    i++;
    while (i < n && isSpace(raw[i])) i++;
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") throw new XmlParseError(`Attributet ${clip(name)} saknar citattecken`);
    const end = raw.indexOf(quote, i + 1);
    if (end === -1) throw new XmlParseError(`Attributet ${clip(name)} är inte avslutat`);
    budget.take();
    attrs[name] = decodeEntities(raw.slice(i + 1, end));
    i = end + 1;
  }
}

export function parseXml(input: string, limits: XmlLimits = DEFAULT_XML_LIMITS): { root: XmlNode; namespace: string | null } {
  if (Buffer.byteLength(input, "utf8") > limits.maxBytes) {
    throw new XmlParseError(`Filen är större än ${Math.round(limits.maxBytes / (1024 * 1024))} MB`);
  }
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new XmlParseError("DTD och entiteter är inte tillåtna i filen");
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const budget = new NodeBudget(limits.maxNodes);
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const textEnd = lt === -1 ? s.length : lt;
    if (textEnd > i) {
      const text = s.slice(i, textEnd);
      if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(text);
      else if (text.trim() !== "") throw new XmlParseError("Text utanför rotelementet");
    }
    if (lt === -1) break;
    if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt);
      if (end === -1) throw new XmlParseError("Ofullständig XML-deklaration");
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt);
      if (end === -1) throw new XmlParseError("Ofullständig kommentar");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt);
      if (end === -1 || stack.length === 0) throw new XmlParseError("Ofullständig CDATA");
      stack[stack.length - 1]!.text += s.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (s.startsWith("<!", lt)) throw new XmlParseError("Deklarationer är inte tillåtna i filen");
    const gt = tagEnd(s, lt + 1);
    const raw = s.slice(lt + 1, gt);
    if (raw.startsWith("/")) {
      const qname = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new XmlParseError(`Felaktigt avslutad tagg </${clip(qname)}>`);
      i = gt + 1;
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const match = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!match) throw new XmlParseError("Tom tagg");
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
    else if (root) throw new XmlParseError("Filen har mer än ett rotelement");
    else root = node;
    if (stack.length + 1 > MAX_DEPTH) throw new XmlParseError("Filen är för djupt nästlad");
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  if (stack.length > 0) throw new XmlParseError("Filen tar slut mitt i ett element");
  if (!root) throw new XmlParseError("Filen innehåller inget XML-element");
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
