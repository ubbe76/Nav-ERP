import type { Metadata } from "next";
import { Space_Grotesk, Figtree } from "next/font/google";
import "./globals.css";
import { headers } from "next/headers";
import { fetchThemeBoot, themeBootScript } from "../lib/themes";
import { ThemeBootProvider } from "../components/ThemeBootProvider";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-figtree",
});

export const metadata: Metadata = {
  title: "nav | ERP",
  description: "Produktions-ERP för svenska tillverkande företag",
  // The pregenerated favicon set from Design/logo/favicon — favicon.ico ships
  // via the app/ file convention, the rest from public/. apple must be listed
  // here too: defining `icons` at all suppresses the apple-icon.png file
  // convention's <link>.
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Custom themes (System → Teman) + the company default/lock + the user's
  // own choice. Never fails: see fetchThemeBoot.
  const boot = await fetchThemeBoot((await headers()).get("cookie") ?? undefined);
  return (
    // suppressHydrationWarning: the boot script sets data-theme on <html>
    // before React hydrates — this element's own attributes only.
    <html lang="sv" suppressHydrationWarning>
      <head>
        {/* Applies the stored colour theme before first paint (lib/themes.ts). */}
        {/* Server-built CSS for the custom themes (validated tokens only). */}
        {boot.css && <style id="nav-themes" dangerouslySetInnerHTML={{ __html: boot.css }} />}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript(boot) }} />
      </head>
      {/* Browser extensions inject attributes on <body> before React hydrates
          (ColorZilla's cz-shortcut-listen, for one), which otherwise reports a
          hydration mismatch we can neither cause nor fix. This suppresses the
          warning for this element's own attributes only — never the tree. */}
      <body suppressHydrationWarning className={`${spaceGrotesk.variable} ${figtree.variable}`}>
        {/* Without the CSS: it is already in <head> above. */}
        <ThemeBootProvider
          boot={{ themes: boot.themes, defaultTheme: boot.defaultTheme, locked: boot.locked, userTheme: boot.userTheme }}
        >
          {children}
        </ThemeBootProvider>
      </body>
    </html>
  );
}
