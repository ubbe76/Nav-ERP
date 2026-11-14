"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  MAIL_SIGNATURE_COMPANY_FIELDS,
  MAIL_SIGNATURE_COMPANY_FIELD_LABELS,
  type MailSignatureCompanyField,
} from "../../lib/mailSignature";
import type { CompanyInfo, SystemSettings } from "../../lib/types";
import { Checkbox } from "../ui/Field";
import styles from "./CompanyInfoForm.module.css";
import sectionStyles from "./MailSignatureCompanySection.module.css";

// Whether Företagsinformation has the detail filled in (an empty one is
// simply left out of the signature).
function filled(info: CompanyInfo, field: MailSignatureCompanyField): boolean {
  switch (field) {
    case "logo":
      return info.hasLogo;
    case "address":
      return Boolean(info.address || info.postalCode || info.city);
    default:
      return Boolean(info[field]?.trim());
  }
}

// E-postsignatur on Företagsinformation: the admin picks which company
// details go under every user's signature. Each tick saves at once
// (PATCH /settings, the whole list in the catalog's order); the checkbox
// follows the server's answer.
export function MailSignatureCompanySection({ info, initial }: { info: CompanyInfo; initial: MailSignatureCompanyField[] }) {
  const [fields, setFields] = useState<MailSignatureCompanyField[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function toggle(field: MailSignatureCompanyField) {
    const next = MAIL_SIGNATURE_COMPANY_FIELDS.filter((f) => (f === field ? !fields.includes(f) : fields.includes(f)));
    setError(null);
    setPending(true);
    try {
      const updated = await apiFetch<SystemSettings>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({ mailSignatureCompanyFields: next }),
      });
      setFields(updated.mailSignatureCompanyFields);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara valet"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.logoTitle}>E-postsignatur</div>
      <div className={styles.logoHint}>
        Företagsuppgifterna som står under varje användares e-postsignatur. Användarna väljer sina egna uppgifter och slår på
        signaturen under Mina inställningar.
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={sectionStyles.grid}>
        {MAIL_SIGNATURE_COMPANY_FIELDS.map((field) => (
          <label key={field} className={sectionStyles.check}>
            <Checkbox checked={fields.includes(field)} disabled={pending} onChange={() => toggle(field)} />
            <span>
              {MAIL_SIGNATURE_COMPANY_FIELD_LABELS[field]}
              {!filled(info, field) && <span className={sectionStyles.empty}> (inte ifyllt)</span>}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
