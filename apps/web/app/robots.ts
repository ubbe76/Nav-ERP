import type { MetadataRoute } from "next";

// An installation of Nav|ERP is a company's own business system: nothing in
// it belongs in a search engine. The demo showed why — Google found
// demo.naverp.se through the website's Prova demon link and reported its
// login page under several addresses (/, /login, /login?next=…) as
// "Dubblett utan att användaren valt en kanonisk sida". Every crawler is
// shut out here, and the root layout adds noindex for one that comes anyway.
// proxy.ts exempts /robots.txt from the login redirect, or the crawler would
// get the login page instead (web-robots.test.ts).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
