import { API_URL, apiErrorFromBody } from "./api";

// A PDF the API renders from a POST body (the label dialogs, pallkort
// INLEVERANS). The tab is opened first — call this straight from the click
// handler, before any other await, so popup blockers allow it — and pointed
// at the PDF once it has arrived. A refusal closes the tab and throws the
// API's error with its code (apiErrorMessage turns it into Swedish).
export async function openPostedPdf(endpoint: string, body: unknown, fallback: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      throw apiErrorFromBody(res.status, errorBody, fallback);
    }
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
    // Leave the URL alive long enough for the tab to load it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
