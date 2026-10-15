import type { Metadata } from "next";
import { Space_Grotesk, Figtree } from "next/font/google";
import "./globals.css";
import { themeBootScript } from "../lib/themes";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script sets data-theme on <html>
    // before React hydrates — this element's own attributes only.
    <html lang="sv" suppressHydrationWarning>
      <head>
        {/* Applies the stored colour theme before first paint (lib/themes.ts). */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      {/* Browser extensions inject attributes on <body> before React hydrates
          (ColorZilla's cz-shortcut-listen, for one), which otherwise reports a
          hydration mismatch we can neither cause nor fix. This suppresses the
          warning for this element's own attributes only — never the tree. */}
      <body suppressHydrationWarning className={`${spaceGrotesk.variable} ${figtree.variable}`}>
        {children}
      </body>
    </html>
  );
}
