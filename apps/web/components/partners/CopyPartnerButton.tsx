"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  PARTNER_COPY_TARGET,
  duplicateSearchTerms,
  likelyDuplicates,
  partnerCopyBody,
  type ExistingPartner,
  type PartnerSide,
} from "../../lib/partnerCopy";
import type { Customer, Paged, Supplier } from "../../lib/types";

// Kopiera till kund (supplier card) / Kopiera till leverantör (customer
// card): creates a NEW partner on the other side from this card's own data —
// POST /customers/from-supplier or /suppliers/from-customer, which copy the
// contacts and delivery addresses too — and opens it. Shown to those who may
// write the other side (Försäljning / Inköp). The dialog names a partner that
// probably is the same company already, without stopping the copy.
export function CopyPartnerButton({
  side,
  partner,
}: {
  side: PartnerSide;
  partner: { id: string; name: string; orgNumber: string | null };
}) {
  const can = useCan();
  const target = PARTNER_COPY_TARGET[side];
  const [open, setOpen] = useState(false);
  if (!can([side === "supplier" ? "forsaljning" : "inkop"])) return null;
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {target.buttonLabel}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`${target.title} — ${partner.name}`}>
        {open && <CopyPartnerForm side={side} partner={partner} />}
      </Modal>
    </>
  );
}

function CopyPartnerForm({ side, partner }: { side: PartnerSide; partner: { id: string; name: string; orgNumber: string | null } }) {
  const router = useRouter();
  const target = PARTNER_COPY_TARGET[side];
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [existing, setExisting] = useState<ReturnType<typeof likelyDuplicates>>([]);

  // The other side's list, searched on the organisationsnummer and the name.
  // A failed search only means no warning.
  useEffect(() => {
    let current = true;
    const identity = { name: partner.name, orgNumber: partner.orgNumber };
    Promise.all(
      duplicateSearchTerms(identity).map((term) =>
        apiFetch<Paged<Customer | Supplier>>(`${target.listEndpoint}?search=${encodeURIComponent(term)}&limit=20`).then((page) =>
          page.rows.map(
            (row): ExistingPartner => ({
              id: row.id,
              number: "customerNumber" in row ? row.customerNumber : row.supplierNumber,
              name: row.name,
              orgNumber: row.orgNumber,
            })
          )
        )
      )
    )
      .then((pages) => {
        if (current) setExisting(likelyDuplicates(identity, pages.flat()));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [partner.name, partner.orgNumber, target.listEndpoint]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<{ id: string }>(target.createEndpoint, {
        method: "POST",
        body: JSON.stringify(partnerCopyBody(side, partner.id, number)),
      });
      router.push(target.cardHref(created.id));
    } catch (err) {
      setError(apiErrorMessage(err, `Kunde inte skapa ${target.targetNoun}en`));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>
      <FormHint>
        En ny {target.targetNoun} skapas med {target.sourceNoun} namn, adress, organisations- och momsnummer, kontaktperson,
        e-post, telefon, valuta och språk, och med kontakterna och leveransadresserna. Villkor, leveransdagar, priser och
        bankuppgifter följer inte med — fyll i dem på det nya kortet.
      </FormHint>

      {existing.length > 0 && (
        <FormNotice>
          Finns redan som {target.targetNoun}:{" "}
          {existing.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <GatedLink href={target.cardHref(p.id)}>
                {p.number} {p.name}
              </GatedLink>{" "}
              ({p.reason === "org" ? "samma organisationsnummer" : "samma namn"})
            </span>
          ))}
          . Du kan skapa en ny ändå.
        </FormNotice>
      )}

      <Field label={target.numberLabel} htmlFor="copyPartnerNumber">
        <Input
          id="copyPartnerNumber"
          size="md"
          maxLength={50}
          placeholder="Automatiskt"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : target.submitLabel}
        </Button>
      </FormActions>
    </Form>
  );
}
