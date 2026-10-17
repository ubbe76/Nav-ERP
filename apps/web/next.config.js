/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app version shown at the bottom of the sidebar — read from this
  // package.json at build time, so it follows every version bump.
  env: { NEXT_PUBLIC_APP_VERSION: require("./package.json").version },
  // Hosts the dev server may be reached through (Next.js blocks cross-origin
  // requests to /_next/* dev resources from unlisted hosts, which silently
  // kills all client-side JS on the page).
  allowedDevOrigins: ["dev.cibbe.org", "192.168.1.215"],
  // Same-origin API proxy: the browser only ever talks to the web origin,
  // which forwards /api/v1/* to the API server. This makes the app reachable
  // through any hostname (LAN IP, tunnel domain, ...) without CORS, cookie
  // SameSite, or https→http mixed-content issues. INTERNAL_API_URL is the
  // Docker-network address of the api container; the localhost fallback
  // covers running `npm run dev:web` directly on the host.
  // "Maskiner" was renamed to "Resurser" — keep old bookmarks working.
  async redirects() {
    return [{ source: "/tillverkning/maskiner", destination: "/tillverkning/resurser", permanent: true }];
  },
  async rewrites() {
    const apiUrl = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
};

module.exports = nextConfig;
