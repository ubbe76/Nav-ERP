// PAXml export — the file format Swedish payroll programs import a period's
// basis (löneunderlag) from. ALL XML knowledge lives in this module; the
// service above it only decides which posts to send.
//
// Verified against the official schema at https://www.paxml.se/2.2/paxml.xsd
// (PAXml 2.2, dated 2023-04 — the newest published version; /3.0/ is a 404)
// and the format's technical description. The parts that matter here:
//
//   * <paxml> is the root, in NO namespace — validation is wired up with an
//     xsi:noNamespaceSchemaLocation reference, which the spec requires.
//   * headerTYPE is an xs:all of optional fields plus a REQUIRED <version>,
//     whose enumeration in the 2.2 schema admits exactly "2.2".
//   * header/<datum> is xs:dateTime (an export *timestamp*), while
//     tidtrans/<datum> is a plain xs:date.
//   * <foretagorgnr> is string12TYPE — max 12 characters.
//   * tidtransTYPE carries anstid/persnr/postid as ATTRIBUTES and
//     tidkod/datum/timmar as CHILD ELEMENTS. <tidkod> is required; the spec
//     requires at least one of anstid/persnr to identify the employee.
//   * personnummerTYPE is exactly 12 characters (yyyymmddnnnn) — no hyphen.
//   * <timmar> is xs:decimal, so a decimal POINT (the CSV export is the one
//     that uses a Swedish decimal comma).

import { xmlEscape } from "../../system/service/xml.js";

// Re-exported: payroll-export.test.ts (and any older caller) imports it here.
export { xmlEscape };

// One time transaction: a tidkod (TID/ÖT1/SJK/…) and the number of hours.
export interface PaxmlPost {
  code: string;
  hours: number;
}

export interface PaxmlEmployeeInput {
  employeeNumber: string;
  personalIdentityNumber: string | null;
  days: { date: string; posts: PaxmlPost[] }[];
}

export interface PaxmlInput {
  orgNo: string | null;
  companyName: string | null;
  exportDate: string; // ISO-8601 instant; rendered as xs:dateTime
  employees: PaxmlEmployeeInput[];
}

const SCHEMA_LOCATION = "http://www.paxml.se/2.2/paxml.xsd";
const VERSION = "2.2";
// The spec's documented <format> value for "löneunderlag från försystem,
// löne- & tidtransaktioner" — exactly what this export is.
const FORMAT = "LÖNIN";

// xs:dateTime without fractional seconds or a timezone designator —
// "2026-07-26T08:30:00". Accepts anything Date can parse.
function toXsDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 19);
}

// personnummerTYPE demands exactly 12 characters (yyyymmddnnnn), so the
// stored hyphen form is normalised away. A number that does not yield 12
// digits (e.g. the 10-digit short form, whose century is ambiguous) is
// dropped rather than guessed — anstid still identifies the employee, and a
// wrong personnummer in a payroll file is worse than a missing one.
function normalizePersonalIdentityNumber(value: string | null): string | null {
  if (value === null) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
}

function element(name: string, value: string, indent: string): string {
  return `${indent}<${name}>${xmlEscape(value)}</${name}>\n`;
}

export function buildPaxmlXml(input: PaxmlInput): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<paxml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${SCHEMA_LOCATION}">\n`;

  // --- header (element order follows the XSD's own listing) ---
  xml += "  <header>\n";
  xml += element("format", FORMAT, "    ");
  xml += element("version", VERSION, "    ");
  xml += element("datum", toXsDateTime(input.exportDate), "    ");
  const orgNo = input.orgNo?.trim() ?? "";
  // string12TYPE — a longer value would fail validation, so it is left out.
  if (orgNo !== "" && orgNo.length <= 12) xml += element("foretagorgnr", orgNo, "    ");
  const companyName = input.companyName?.trim() ?? "";
  if (companyName !== "") xml += element("foretagnamn", companyName, "    ");
  xml += "  </header>\n";

  // --- tidtransaktioner ---
  // Always emitted, even when empty: an export with nothing to report is a
  // meaningful (and schema-valid) answer, not a malformed file.
  xml += "  <tidtransaktioner>\n";
  for (const employee of input.employees) {
    const persnr = normalizePersonalIdentityNumber(employee.personalIdentityNumber);
    let attributes = ` anstid="${xmlEscape(employee.employeeNumber)}"`;
    if (persnr !== null) attributes += ` persnr="${xmlEscape(persnr)}"`;

    for (const day of employee.days) {
      for (const post of day.posts) {
        xml += `    <tidtrans${attributes}>\n`;
        xml += element("tidkod", post.code, "      ");
        xml += element("datum", day.date, "      ");
        xml += `      <timmar>${post.hours.toFixed(2)}</timmar>\n`;
        xml += "    </tidtrans>\n";
      }
    }
  }
  xml += "  </tidtransaktioner>\n";

  xml += "</paxml>\n";
  return xml;
}
