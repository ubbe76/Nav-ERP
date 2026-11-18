"use client";

import { useState } from "react";
import { apiErrorMessage } from "../../lib/errorMessages";
import { printPdf } from "../../lib/printPdf";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";

// "Skriv ut" for a PDF behind a GET url: fetches it and opens the browser's
// print dialog (lib/printPdf.ts). Disabled with "Skriver ut…" while the PDF is
// being fetched; a failure is shown next to the button.
export function PrintButton({
  href,
  label = "Skriv ut",
  variant = "ghost",
  size = "small",
}: {
  href: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "default" | "small";
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function print() {
    setError(null);
    setPending(true);
    // printPdf opens its fallback tab synchronously, before its first await.
    printPdf(href)
      .catch((err) => setError(apiErrorMessage(err, "Kunde inte skriva ut")))
      .finally(() => setPending(false));
  }

  return (
    <>
      <Button type="button" variant={variant} size={size} onClick={print} disabled={pending}>
        {pending ? "Skriver ut…" : label}
      </Button>
      <FormError inline>{error}</FormError>
    </>
  );
}
