import { API_URL, apiErrorFromBody } from "./api";

// ONE print route for every PDF the web app prints. The PDF is fetched with
// the session cookie, loaded as a blob into an invisible same-origin iframe
// and iframe.contentWindow.print() opens the browser's own print dialog (with
// the printer picker) — also in Edge/Chrome as an installed app, where the API's
// `Content-Disposition: attachment` would otherwise only download the file.
// Safari/WebKit cannot print a PDF in an iframe reliably, so there (and when
// print() fails) the PDF opens in a new tab like before.

export type PrintStrategy = "iframe" | "tab";

// Pure, so it can be unit tested. Every iOS/iPadOS browser is WebKit (iPadOS
// reports a Macintosh user agent but has touch points); desktop Safari has
// "Safari" without a Chromium marker. A browser that says it cannot show a PDF
// inline (navigator.pdfViewerEnabled false — Chrome on Android) never fires the
// iframe's load, so it goes straight to the tab; so does Android, whatever it
// says. `pdfViewerEnabled` undefined (an older browser) decides nothing.
export function printStrategy(userAgent: string, maxTouchPoints: number, pdfViewerEnabled?: boolean): PrintStrategy {
  if (pdfViewerEnabled === false) return "tab";
  if (/Android/.test(userAgent)) return "tab";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "tab";
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return "tab";
  if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS|Edg\/|EdgA|OPR\/|Android|Firefox\/|FxiOS/.test(userAgent)) {
    return "tab";
  }
  return "iframe";
}

// A PDF viewer that has not loaded the blob by then is not coming — the tab
// fallback takes over (the button says Skriver ut… meanwhile).
const LOAD_TIMEOUT_MS = 10_000;
// The dialog is modal; afterprint normally ends it, this is the safety net.
const CLEANUP_TIMEOUT_MS = 10 * 60_000;

function printInIframe(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
    let done = false;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      iframe.remove();
      URL.revokeObjectURL(url);
    };
    const loadTimer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("print-load-timeout"));
    }, LOAD_TIMEOUT_MS);
    iframe.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(loadTimer);
      // Give the PDF viewer a moment to lay the document out.
      setTimeout(() => {
        try {
          const win = iframe.contentWindow;
          if (!win) throw new Error("print-no-window");
          try {
            win.addEventListener("afterprint", () => setTimeout(cleanup, 500));
          } catch {
            // Not listenable — the timeout below cleans up.
          }
          setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
          win.focus();
          win.print();
          resolve();
        } catch (err) {
          cleanup();
          reject(err);
        }
      }, 250);
    };
    iframe.src = url;
    document.body.appendChild(iframe);
  });
}

async function present(strategy: PrintStrategy, tab: Window | null, getBlob: () => Promise<Blob>): Promise<void> {
  let blob: Blob;
  try {
    blob = await getBlob();
  } catch (err) {
    tab?.close();
    throw err;
  }
  const url = URL.createObjectURL(blob);
  if (strategy === "iframe") {
    try {
      await printInIframe(url);
      return;
    } catch {
      // Fall through to the new tab.
    }
    const fallbackUrl = URL.createObjectURL(blob);
    // Opened after an await, so a popup blocker may stop it. Then the PDF is
    // downloaded instead — never a navigation away from the page (in the
    // installed app that would replace Nav with the PDF).
    if (!window.open(fallbackUrl, "_blank")) {
      const link = document.createElement("a");
      link.href = fallbackUrl;
      link.download = "utskrift.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    setTimeout(() => URL.revokeObjectURL(fallbackUrl), 60_000);
    return;
  }
  if (tab) tab.location.href = url;
  else window.open(url, "_blank");
  // Leave the URL alive long enough for the tab to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function currentStrategy(): PrintStrategy {
  return printStrategy(navigator.userAgent, navigator.maxTouchPoints ?? 0, navigator.pdfViewerEnabled);
}

async function failIfNotOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const errorBody = await res.json().catch(() => ({}));
  throw apiErrorFromBody(res.status, errorBody, fallback);
}

// Call straight from the click handler, before any other await: the new tab of
// the fallback is opened synchronously so popup blockers let it through.
export async function printPdf(href: string, fallback = "Kunde inte skapa PDF:en"): Promise<void> {
  const strategy = currentStrategy();
  const tab = strategy === "tab" ? window.open("", "_blank") : null;
  await present(strategy, tab, async () => {
    const res = await fetch(href.startsWith("/") ? `${API_URL}${href}` : href, { credentials: "include" });
    await failIfNotOk(res, fallback);
    return res.blob();
  });
}

// The same for a PDF the API renders from a POST body (label dialogs,
// pallkort INLEVERANS).
export async function printPostedPdf(endpoint: string, body: unknown, fallback: string): Promise<void> {
  const strategy = currentStrategy();
  const tab = strategy === "tab" ? window.open("", "_blank") : null;
  await present(strategy, tab, async () => {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await failIfNotOk(res, fallback);
    return res.blob();
  });
}
