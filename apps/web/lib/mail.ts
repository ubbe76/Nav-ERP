import { apiFetch, apiGet } from "./api";
import type { ArticleFile, Customer, EmailLogEntry, Paged, PartnerContact, Supplier } from "./types";

// How many drawings the order's articles carry — the send dialog offers to
// attach them when there are any.
export async function countDrawings(articleIds: string[], cookieHeader: string | undefined): Promise<number> {
  const unique = [...new Set(articleIds)];
  const lists = await Promise.all(
    unique.map((id) => apiGet<ArticleFile[]>(`/api/v1/articles/${id}/files`, cookieHeader).catch(() => []))
  );
  return lists.reduce((sum, files) => sum + files.length, 0);
}

// Send history for one document card, newest first.
export async function getDocumentEmails(documentId: string, cookieHeader: string | undefined): Promise<EmailLogEntry[]> {
  const result = await apiGet<Paged<EmailLogEntry>>(
    `/api/v1/email-log?documentId=${documentId}&limit=20`,
    cookieHeader
  ).catch(() => null);
  return result?.rows ?? [];
}

// Default recipient for the send dialog: the partner's primary contact's
// email, falling back to the partner's own `email` column. That column is no
// longer shown or editable on the partner card (contacts took over), but it
// still holds addresses from the Monitor import and older registrations —
// dropping the fallback would blank the recipient for every partner without
// a contact.
export async function getDefaultRecipient(
  partnerBase: "suppliers" | "customers",
  partnerId: string,
  partnerEmail: string | null,
  cookieHeader: string | undefined
): Promise<string> {
  const contacts = await apiGet<PartnerContact[]>(`/api/v1/${partnerBase}/${partnerId}/contacts`, cookieHeader).catch(
    () => []
  );
  const primary = contacts.find((c) => c.isPrimary && c.email);
  return primary?.email ?? partnerEmail ?? "";
}

// Client-side twin of getDefaultRecipient, for send dialogs opened outside a
// server-rendered document card (the behovsberäkning's created orders). Same
// priority — primary contact, then the partner's legacy `email` — but it fetches
// the partner itself since the caller only has an id. Never throws: an empty
// string just means the user types the address.
export async function fetchDefaultRecipient(
  partnerBase: "suppliers" | "customers",
  partnerId: string
): Promise<string> {
  const [contacts, partner] = await Promise.all([
    apiFetch<PartnerContact[]>(`/api/v1/${partnerBase}/${partnerId}/contacts`).catch(() => []),
    apiFetch<Supplier | Customer>(`/api/v1/${partnerBase}/${partnerId}`).catch(() => null),
  ]);
  const primary = contacts.find((c) => c.isPrimary && c.email);
  return primary?.email ?? partner?.email ?? "";
}
