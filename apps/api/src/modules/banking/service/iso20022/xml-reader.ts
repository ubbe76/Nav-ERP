import {
  DEFAULT_XML_LIMITS,
  parseXml as parseXmlShared,
  XmlParseError,
  type XmlNode,
} from "../../../system/service/xml-reader.js";
import { BankFileParseError } from "../banking.errors.js";

// The bank files' view of the shared XXE-safe reader
// (system/service/xml-reader.ts): the bank file's limits (20 MB, 500 000
// nodes — spec §3.5) and its own error class, so the upload still answers
// 400 with the parse message. The node helpers are the shared ones.
export { child, children, path, textAt, type XmlNode } from "../../../system/service/xml-reader.js";

export function parseXml(input: string): { root: XmlNode; namespace: string | null } {
  try {
    return parseXmlShared(input, DEFAULT_XML_LIMITS);
  } catch (err) {
    if (err instanceof XmlParseError) throw new BankFileParseError(err.message);
    throw err;
  }
}
