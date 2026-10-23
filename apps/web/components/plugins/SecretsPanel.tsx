"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { FormNotice } from "../ui/Form";
import styles from "./Plugins.module.css";

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className={styles.secret}>
      <strong>{label}</strong>
      <code className={styles.secretValue}>{value}</code>
      <div className={styles.actions}>
        <Button type="button" variant="secondary" size="small" onClick={copy}>
          {copied ? "Kopierad" : "Kopiera"}
        </Button>
        {failed && <span className={styles.mutedLine}>Kunde inte kopiera automatiskt — markera och kopiera manuellt.</span>}
      </div>
    </div>
  );
}

// The API key and the webhook secret exist in clear text only in the answer
// that creates or replaces them — this panel is the one chance to copy them.
export function SecretsPanel({ apiKey, webhookSecret }: { apiKey?: string; webhookSecret?: string }) {
  return (
    <div className={styles.body}>
      <FormNotice>
        Nycklarna visas bara nu. Kopiera dem och lägg in dem i tillägget innan du stänger rutan — de går inte att visa igen,
        bara att ersätta med nya.
      </FormNotice>
      {apiKey && <CopyRow label="API-nyckel" value={apiKey} />}
      {webhookSecret && <CopyRow label="Webbhookshemlighet" value={webhookSecret} />}
    </div>
  );
}
