"use client";

import Link from "next/link";
import { Button } from "../components/ui/Button";

// A page that failed to render (the API answered an error while the page
// fetched its data, or a bug): a Swedish page with a way back instead of
// Next's English "Application error". A dead session never ends here — the
// proxy and apiGet send it to /login.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main
      style={{
        maxWidth: 560,
        margin: "64px auto",
        padding: "0 16px",
        fontFamily: "var(--font-body)",
        color: "var(--color-text-primary)",
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>Sidan kunde inte visas</h1>
      <p style={{ color: "var(--color-text-secondary)", margin: "0 0 20px" }}>
        Något gick fel när sidan hämtade sina uppgifter. Försök igen — kvarstår felet kan servern vara tillfälligt
        otillgänglig.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Button type="button" variant="primary" onClick={reset}>
          Försök igen
        </Button>
        <Link href="/">Till startsidan</Link>
      </div>
    </main>
  );
}
