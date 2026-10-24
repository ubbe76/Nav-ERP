"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { ListExportLink, ListToolbar, Pagination } from "../ui/ListControls";
import { apiFetch } from "../../lib/api";
import type { Paged, PriceList } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { CurrencyInput } from "../ui/CurrencyInput";

// Prislistor — registerlistan (kopierad från kundlistans form, se
// CustomersPageClient.tsx): URL-driven sök/sida via ListToolbar/Pagination,
// "+ Ny prislista" öppnar en modal, raderna länkar till kortet.
export function PriceListsPageClient({ priceLists, pageSize }: { priceLists: Paged<PriceList>; pageSize: number }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Prislistor</div>
          <div className={shellStyles.meta}>{priceLists.total.toLocaleString("sv-SE")} prislistor</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny prislista
          </Button>
          <HelpLink chapter="forsaljning" anchor="prislistor" label="Hjälp om prislistor" />
        </div>
      </div>

      <ListToolbar placeholder="Sök kod eller namn…">
        <ListExportLink endpoint="/api/v1/price-lists/csv" />
      </ListToolbar>

      <Table<PriceList>
        columns={[
          { key: "code", label: "Kod", width: "140px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "description", label: "Beskrivning", width: "1.6fr" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "rowCount", label: "Antal rader", width: "120px", align: "right" },
        ]}
        rows={priceLists.rows}
        emptyText="Inga prislistor matchar sökningen"
        renderCell={(list, key) => {
          switch (key) {
            case "code":
              return (
                <Link href={`/forsaljning/prislistor/${list.id}`} style={{ color: "inherit" }}>
                  <strong>{list.code}</strong>
                </Link>
              );
            case "name":
              return (
                <Link href={`/forsaljning/prislistor/${list.id}`} style={{ color: "inherit" }}>
                  {list.name}
                </Link>
              );
            case "description":
              return list.description ?? "–";
            case "currency":
              return list.currency;
            case "rowCount":
              return list.rowCount;
            default:
              return null;
          }
        }}
      />

      <Pagination total={priceLists.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny prislista">
        <NewPriceListForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

// Creates a price list — editing (and the price rows) happens on the card
// (/forsaljning/prislistor/[id]), same split as NewCustomerForm/kundkortet.
function NewPriceListForm({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("SEK");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/price-lists", {
        method: "POST",
        body: JSON.stringify({
          code,
          name,
          description: description.trim() || undefined,
          currency: currency.trim() || undefined,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa prislistan");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Kod" htmlFor="priceListCode">
        <Input id="priceListCode" size="md" required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>

      <Field label="Namn" htmlFor="priceListName">
        <Input id="priceListName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Beskrivning" htmlFor="priceListDescription">
        <Input
          id="priceListDescription"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field label="Valuta" htmlFor="priceListCurrency">
        <CurrencyInput id="priceListCurrency" required value={currency} onValueChange={setCurrency} />
      </Field>
      <FormHint attached>
        Listans priser anges i den. Priskedjan använder listan bara på ordrar i samma valuta.
      </FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Skapa prislista"}
        </Button>
      </FormActions>
    </Form>
  );
}
