// HTML for the outgoing mails (the aviseringar digest, the document mails
// with a signature): text is always escaped through here.
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
