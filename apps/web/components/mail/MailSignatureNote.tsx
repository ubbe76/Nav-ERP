"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import type { MailSignatureView } from "../../lib/mailSignature";

// The send dialogs' note that your E-postsignatur (Mina inställningar) goes
// under the message — shown only when it is switched on. A failed lookup
// shows nothing; the server signs the mail either way.
export function MailSignatureNote() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch<MailSignatureView>("/api/v1/me/mail-signature")
      .then((signature) => {
        if (!cancelled) setOn(signature.enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!on) return null;
  return <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Din e-postsignatur läggs till under meddelandet.</p>;
}
