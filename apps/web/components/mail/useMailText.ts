"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { MailTextRequest } from "../../lib/mailText";

// The send dialog's Ämne and Meddelande, filled from the user's e-mail
// template (Mina inställningar) when the dialog opens. The fields stay
// disabled until the text is here; if it cannot be fetched they open empty
// with the error, so the mail can still be written by hand.
export function useMailText(request: MailTextRequest) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The request is built by the page on every render; the text is fetched
  // once per dialog (the dialog is mounted when it opens).
  const key = JSON.stringify(request);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ subject: string; body: string }>("/api/v1/me/mail-text", {
      method: "POST",
      body: key,
    })
      .then((text) => {
        if (cancelled) return;
        setSubject(text.subject);
        setMessage(text.body);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Kunde inte hämta e-posttexten — skriv den själv."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { subject, setSubject, message, setMessage, loading, error };
}
