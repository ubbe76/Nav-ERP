import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, getCurrentUser } from "./lib/api";
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

  if (hasSession && isPublicPath) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Behörighetsgrupper: page guard. The API refuses the data anyway; this
  // turns a refused page into a clear "Ingen behörighet" instead of a crash.
  // A failed /auth/me (expired session, or the API unreachable) falls
  // through — AppShell sends the user to /login exactly as before.
  if (hasSession && !isPublicPath) {
    let user: Awaited<ReturnType<typeof getCurrentUser>> = null;
    try {
      user = await getCurrentUser(req.headers.get("cookie") ?? undefined);
    } catch {
      return NextResponse.next();
    }
    if (user && !canOpen(user, req.nextUrl.pathname)) {
      const target = req.nextUrl.pathname === "/" ? landingFor(user) : "/ingen-behorighet";
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
  // with nothing sensitive, linked from the manual and the website).
  matcher: [
    "/((?!api/v1|_next/static|_next/image|importmallar/|favicon.ico|favicon-16x16.png|favicon-32x32.png|apple-icon.png|manifest.webmanifest|android-chrome-192x192.png|android-chrome-512x512.png).*)",
  ],
};
