import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, checkSession } from "./lib/api";
import { canOpen, landingFor } from "./lib/pageAccess";

const PUBLIC_PATHS = ["/login", "/register"];

// Presence-only check for fast redirects — the API is the real authorization
// boundary (it verifies the JWT on every request), this just avoids rendering
// a page that would immediately fail its data fetch.
export async function proxy(req: NextRequest) {
  const hasSession = req.cookies.has(SESSION_COOKIE);
  const isPublicPath = PUBLIC_PATHS.includes(req.nextUrl.pathname);

  if (!hasSession && !isPublicPath) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  // Only a session the API still accepts leaves /login. A cookie the API
  // refuses (401 — the account was deactivated or removed, its password
  // changed, JWT_SECRET replaced) is cleared and the page opens; an API that
  // is down or busy (5xx, 429, unreachable) just opens the page and keeps the
  // cookie — a hiccup must not log anyone out.
  if (hasSession && isPublicPath) {
    const session = await checkSession(req.headers.get("cookie") ?? undefined);
    if (session.kind === "user") return NextResponse.redirect(new URL("/", req.url));
    const res = NextResponse.next();
    if (session.kind === "invalid") res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  // A cookie the API refuses goes to /login (and is cleared) here: the pages
  // fetch their data before AppShell could redirect, so a dead session used
  // to end on the error page. Behörighetsgrupper: page guard — the API
  // refuses the data anyway; this turns a refused page into a clear "Ingen
  // behörighet" instead of a crash. An unavailable API falls through.
  if (hasSession && !isPublicPath) {
    const session = await checkSession(req.headers.get("cookie") ?? undefined);
    if (session.kind === "invalid") {
      const res = NextResponse.redirect(new URL("/login", req.url));
      res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    if (session.kind === "user" && !canOpen(session.user, req.nextUrl.pathname)) {
      const target = req.nextUrl.pathname === "/" ? landingFor(session.user) : "/ingen-behorighet";
      return NextResponse.redirect(new URL(target, req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Also exempt the same-origin API proxy (/api/v1 — rewritten to the API
  // server, which does its own auth; a 307 to /login would break login and
  // register calls), the brand/PWA assets — browsers fetch these on the
  // login page too, and a 307 to /login would break the favicon and manifest
  // — and the Excel import templates (public/importmallar, generated files
  // with nothing sensitive). A path without a row in lib/pageAccess.ts is
  // admin-only, so without the exemption the page guard below would send a
  // non-admin following the manual's Ladda ned mallen link to
  // /ingen-behorighet (and a visitor from the website to /login).
  matcher: [
    "/((?!api/v1|_next/static|_next/image|importmallar/|favicon.ico|favicon-16x16.png|favicon-32x32.png|apple-icon.png|manifest.webmanifest|android-chrome-192x192.png|android-chrome-512x512.png).*)",
  ],
};
