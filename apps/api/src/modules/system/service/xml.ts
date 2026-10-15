// Escapes the five XML entities. `&` must go first so the ampersands
// introduced by the later replacements are not escaped a second time. Also
// strips C0 control characters that are illegal in XML 1.0 (tab/LF/CR are
// legal and excluded from the range). Shared by the PAXml export and the
// ISO 20022 builder — a cross-module leaf like ocr.ts.
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
