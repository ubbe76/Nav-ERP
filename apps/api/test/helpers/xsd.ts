import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";

// Official ISO 20022 schemas, checked in under fixtures/iso20022/xsd and
// fetched from the ISO 20022 message archive (iso20022.org):
//   pain.001.001.03.xsd  sha256 6bb5c6f24250ab807f31f6164142bafd6d43bad8d162a926e258ff4c11e128af
//     https://www.iso20022.org/sites/default/files/documents/messages/pain/schemas/pain.001.001.03.xsd
//   camt.054.001.02.xsd  sha256 7ff18dd9ceb927ea6576cc1c367b1e14aa10df3332b21629e1ca5d001fa4cada
//     https://www.iso20022.org/sites/default/files/documents/messages/camt/schemas/camt.054.001.02.xsd
// xmllint-wasm is a devDependency ONLY — production builds the XML by hand
// and runs the structural check in pain001-check.ts (spec §3.4).
const XSD_DIR = new URL("../fixtures/iso20022/xsd/", import.meta.url);

export async function validateAgainstXsd(xml: string, schema: "pain.001.001.03" | "camt.054.001.02"): Promise<string[]> {
  const contents = readFileSync(new URL(`${schema}.xsd`, XSD_DIR), "utf8");
  const result = await validateXML({
    xml: [{ fileName: "document.xml", contents: xml }],
    schema: [{ fileName: `${schema}.xsd`, contents }],
  });
  return result.errors.map((error) => error.message);
}
