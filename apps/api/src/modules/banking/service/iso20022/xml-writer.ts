// xml-writer.ts — a minimal element builder; the element ORDER lives in the
// builder (schema order of pain.001.001.03), never here.
import { xmlEscape } from "../../../system/service/xml.js";

export type XmlChild = XmlElement | null | undefined | false;
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  content: string | readonly XmlChild[];
}

export function el(name: string, content: string | readonly XmlChild[], attrs: Record<string, string> = {}): XmlElement {
  return { name, attrs, content };
}

function render(node: XmlElement): string {
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${xmlEscape(value)}"`)
    .join("");
  if (typeof node.content === "string") return `<${node.name}${attrs}>${xmlEscape(node.content)}</${node.name}>`;
  const inner = node.content
    .filter((child): child is XmlElement => Boolean(child))
    .map(render)
    .join("");
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

export function renderXml(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${render(root)}`;
}
