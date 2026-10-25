"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select, Textarea, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type {
  ArticleGroup,
  Customer,
  CustomerDeliveryAddress,
  CustomerPrice,
  FreightProduct,
  PartnerContact,
  PriceList,
  RegisterEntry,
  Supplier,
  SupplierDeliveryAddress,
} from "../../lib/types";
import { PluginTabContent, pluginTabId, usePluginTabs } from "../plugins/PluginTabs";
import styles from "./PartnerTabs.module.css";
import { Card } from "../ui/Card";
import { CurrencyInput } from "../ui/CurrencyInput";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormSaved } from "../ui/Form";
import { SupplierPaymentDetailsSection } from "../banking/SupplierPaymentDetailsSection";
import { CustomerPricesTab } from "./CustomerPricesTab";
import { PeppolFields } from "./PeppolFields";
import { useDimensions } from "../../lib/dimensions";
import { CostCenterSelect } from "../economy/DimensionSelect";
import { DeliveryDaysFields, type DeliveryDayDefaults, type DeliveryDaysValue } from "./DeliveryDaysFields";
import {
  CUSTOMER_VAT_TREATMENT_LABELS,
  buyerVatNumberWarningText,
  customerVatNumberWarning,
  customerVatTreatment,
  supplierDefaultVatCode,
  vatCodeOptionLabel,
  vatCodesFor,
} from "../../lib/vatCodes";
import { useVatCodes } from "../../lib/useVatCodes";

// Prefixes https:// onto a bare domain (no "://" scheme) so the Webbsida
// link always navigates instead of being treated as a relative path.
function websiteHref(value: string): string {
  return value.includes("://") ? value : `https://${value}`;
}

type Tab = "Allmänt" | "Adresser" | "Villkor & frakt" | "Kontakter" | "Priser";

// The common shape of a delivery address regardless of which partner it
// belongs to — everything AdresserTab/DeliveryAddressForm needs, without the
// FK column (customerId/supplierId) that differs between the two.
export type PartnerDeliveryAddress = Omit<CustomerDeliveryAddress, "customerId"> | Omit<SupplierDeliveryAddress, "supplierId">;

export interface PartnerRegisters {
  deliveryTerms: RegisterEntry[];
  paymentTerms: RegisterEntry[];
  carriers: RegisterEntry[];
}

interface PartnerTabsProps {
  partner: Customer | Supplier;
  // "/api/v1/customers" or "/api/v1/suppliers"
  endpointBase: string;
  // Explicit partner kind — drives what's customer-specific: the Priser tab,
  // the invoice-address section in AdresserTab, and the customer-only PATCH
  // fields on Allmänt/Villkor & frakt.
  kind: "customer" | "supplier";
  // Both partner kinds carry a currency (Valuta): a supplier's is what its
  // invoices are in, a customer's what new quotes/orders are made in.
  showCurrency?: boolean;
  registers: PartnerRegisters;
  contacts: PartnerContact[];
  // Enables the Adresser tab (leveransadresser, both partner kinds) — for a
  // customer it also carries the fakturaadress section.
  deliveryAddresses?: PartnerDeliveryAddress[];
  // Customers only (C3 Kundpriser): the price-list register for the Villkor
  // & frakt dropdown.
  priceLists?: PriceList[];
  // Customers only (C3 Kundpriser): enables the Priser tab.
  customerPrices?: CustomerPrice[];
  articleGroups?: ArticleGroup[];
  // System default delivery-day mode/transit days for this side (from
  // GET /settings), only used to name the defaults on Villkor & frakt.
  // null = the settings could not be read.
  deliveryDayDefaults?: DeliveryDayDefaults | null;
}

// Kund-/leverantörskort — tabbed card shared by both partner types,
// same pattern as the article and employee cards.
export function PartnerTabs({
  partner,
  endpointBase,
  kind,
  showCurrency = false,
  registers,
  contacts,
  deliveryAddresses,
  priceLists,
  customerPrices,
  articleGroups,
  deliveryDayDefaults = null,
}: PartnerTabsProps) {
  const [activeTab, setActiveTab] = useState<string>("Allmänt");
  const isCustomer = kind === "customer";
  // Tillägg add their own tabs last.
  const pluginTabs = usePluginTabs(isCustomer ? "customer" : "supplier");
  const activePluginTab = pluginTabs.find((t) => pluginTabId(t) === activeTab);
  const showAddresses = deliveryAddresses !== undefined;
  const tabs: Tab[] = [
    "Allmänt",
    ...(showAddresses ? (["Adresser"] as Tab[]) : []),
    "Villkor & frakt",
    "Kontakter",
    ...(isCustomer ? (["Priser"] as Tab[]) : []),
  ];

  return (
    <div>
      <div className={styles.tabStrip}>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={styles.tab}
            data-active={tab === activeTab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
        {pluginTabs.map((tab) => (
          <button
            key={pluginTabId(tab)}
            type="button"
            className={styles.tab}
            data-active={pluginTabId(tab) === activeTab}
            title={`Tillägget ${tab.pluginName}`}
            onClick={() => setActiveTab(pluginTabId(tab))}
          >
            {tab.title}
          </button>
        ))}
      </div>

      {activeTab === "Allmänt" && (
        <AllmantTab partner={partner} endpointBase={endpointBase} showCurrency={showCurrency} isCustomer={isCustomer} />
      )}
      {activeTab === "Adresser" && showAddresses && (
        <AdresserTab
          partner={partner}
          endpointBase={endpointBase}
          deliveryAddresses={deliveryAddresses}
          kind={kind}
        />
      )}
      {activeTab === "Villkor & frakt" && (
        <VillkorTab
          partner={partner}
          endpointBase={endpointBase}
          registers={registers}
          isCustomer={isCustomer}
          priceLists={priceLists}
          deliveryDayDefaults={deliveryDayDefaults}
        />
      )}
      {activeTab === "Kontakter" && (
        <KontakterTab contacts={contacts} contactsBase={`${endpointBase}/${partner.id}/contacts`} />
      )}
      {activeTab === "Priser" && isCustomer && (
        <CustomerPricesTab
          prices={customerPrices ?? []}
          pricesBase={`${endpointBase}/${partner.id}/prices`}
          articleGroups={articleGroups ?? []}
          currency={(partner as Customer).currency}
        />
      )}
      {activePluginTab && <PluginTabContent key={pluginTabId(activePluginTab)} tab={activePluginTab} entityId={partner.id} />}
    </div>
  );
}

// Empty input = null in the register (fields are all optional).
const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

function useSaveState() {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  return { error, setError, saved, setSaved, pending, setPending };
}

function AllmantTab({
  partner,
  endpointBase,
  showCurrency,
  isCustomer,
}: {
  partner: Customer | Supplier;
  endpointBase: string;
  showCurrency: boolean;
  isCustomer: boolean;
}) {
  const router = useRouter();
  // Supplier-only fields live behind this flag — the mirror of the
  // customer-only fields (same mechanism, opposite partner type).
  const isSupplier = !isCustomer;
  const [name, setName] = useState(partner.name);
  const [customerNumber, setCustomerNumber] = useState(isCustomer ? (partner as Customer).customerNumber : "");
  const [supplierNumber, setSupplierNumber] = useState(isSupplier ? (partner as Supplier).supplierNumber : "");
  const [ourCustomerNumber, setOurCustomerNumber] = useState(
    isSupplier ? ((partner as Supplier).ourCustomerNumber ?? "") : ""
  );
  const [ourSupplierNumber, setOurSupplierNumber] = useState(
    isCustomer ? ((partner as Customer).ourSupplierNumber ?? "") : ""
  );
  const [website, setWebsite] = useState(isCustomer ? ((partner as Customer).website ?? "") : "");
  const [showConfigurationPrices, setShowConfigurationPrices] = useState(
    isCustomer ? (partner as Customer).showConfigurationPrices : false
  );
  const [palletCardCode, setPalletCardCode] = useState<string>(
    isCustomer ? ((partner as Customer).palletCardCode ?? "") : ""
  );
  const [address, setAddress] = useState(partner.address ?? "");
  const [postalCode, setPostalCode] = useState(partner.postalCode ?? "");
  const [city, setCity] = useState(partner.city ?? "");
  // Besöksadressens land — a supplier has one too (momskoder: it picks the
  // förvalda momskoden on its invoices).
  const [country, setCountry] = useState(isCustomer ? (partner as Customer).country : (partner as Supplier).country);
  const [currency, setCurrency] = useState("currency" in partner ? partner.currency : "SEK");
  const [active, setActive] = useState(partner.active);
  const { error, setError, saved, setSaved, pending, setPending } = useSaveState();

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`${endpointBase}/${partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          ...(isCustomer ? { customerNumber: customerNumber.trim() } : {}),
          ...(isSupplier ? { supplierNumber: supplierNumber.trim() } : {}),
          ...(isSupplier ? { ourCustomerNumber: orNull(ourCustomerNumber) } : {}),
          ...(isCustomer ? { ourSupplierNumber: orNull(ourSupplierNumber) } : {}),
          ...(isCustomer ? { website: orNull(website) } : {}),
          ...(isCustomer ? { showConfigurationPrices } : {}),
          ...(isCustomer ? { palletCardCode: palletCardCode === "" ? null : palletCardCode } : {}),
          address: orNull(address),
          postalCode: orNull(postalCode),
          city: orNull(city),
          country: country.trim().toUpperCase() || "SE",
          ...(showCurrency ? { currency } : {}),
          active,
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>

        <FormRow>
          {isCustomer && (
            <Field label="Kundnummer" htmlFor="customerNumber">
              <Input
                id="customerNumber"
                size="md"
                required
                maxLength={50}
                value={customerNumber}
                onChange={(e) => setCustomerNumber(e.target.value)}
              />
            </Field>
          )}
          {isSupplier && (
            <Field label="Leverantörsnummer" htmlFor="supplierNumber">
              <Input
                id="supplierNumber"
                size="md"
                required
                maxLength={50}
                value={supplierNumber}
                onChange={(e) => setSupplierNumber(e.target.value)}
              />
            </Field>
          )}
          <Field label="Aktiv" htmlFor="active">
            <Toggle id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
          </Field>
        </FormRow>

        {/* Company names are the longest text on the card — the full width is
            theirs. Contact person/phone/email live on the Kontakter tab. */}
        <Field label="Namn" htmlFor="name">
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {isSupplier && (
          <FormRow>
            <Field label="Vårt kundnummer" htmlFor="ourCustomerNumber">
              <Input
                id="ourCustomerNumber"
                size="md"
                maxLength={50}
                placeholder="Hos leverantören"
                value={ourCustomerNumber}
                onChange={(e) => setOurCustomerNumber(e.target.value)}
              />
            </Field>
            {showCurrency && (
              <Field label="Valuta" htmlFor="currency">
                <Input
                  id="currency"
                  size="xs"
                  required
                  maxLength={3}
                  pattern="[A-Z]{3}"
                  title="3 stora bokstäver, t.ex. SEK"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </Field>
            )}
          </FormRow>
        )}

        {isCustomer && (
          <FormRow>
            <Field label="Vårt leverantörsnummer" htmlFor="ourSupplierNumber">
              <Input
                id="ourSupplierNumber"
                size="md"
                maxLength={50}
                placeholder="Hos kunden"
                value={ourSupplierNumber}
                onChange={(e) => setOurSupplierNumber(e.target.value)}
              />
            </Field>
            <Field label="Webbsida" htmlFor="website">
              <Input
                id="website"
                maxLength={255}
                placeholder="www.exempel.se"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
              {website.trim() !== "" && (
                <FormHint>
                  <a href={websiteHref(website.trim())} target="_blank" rel="noopener noreferrer">
                    {website.trim()}
                  </a>
                </FormHint>
              )}
            </Field>
          </FormRow>
        )}
        {isCustomer && showCurrency && (
          <>
            <Field label="Valuta" htmlFor="currency">
              <CurrencyInput id="currency" required value={currency} onValueChange={setCurrency} />
            </Field>
            <FormHint attached>
              Kundens valuta. Nya offerter och kundorder tas i den, med dagens kurs, och kundens särpriser (fliken Priser)
              anges i den. Ordrar som redan finns behåller sin valuta. E-faktura (Peppol) går bara på SEK.
            </FormHint>
          </>
        )}
        {isCustomer && (
          <>
            <Field label="Visa tilläggspriser" htmlFor="showConfigurationPrices">
              <Toggle
                id="showConfigurationPrices"
                checked={showConfigurationPrices}
                onChange={(e) => setShowConfigurationPrices(e.target.checked)}
              />
            </Field>
            <FormHint attached>
              Förval för Visa tilläggspriser när offert och orderbekräftelse skrivs ut eller mejlas; fakturan följer
              inställningen när den utfärdas.
            </FormHint>
            <Field label="Kod på pallkort" htmlFor="palletCardCode">
              <Select id="palletCardCode" value={palletCardCode} onChange={(e) => setPalletCardCode(e.target.value)}>
                <option value="">Systemets förval</option>
                <option value="none">Ingen</option>
                <option value="barcode">Streckkod</option>
                <option value="qr">QR-kod</option>
              </Select>
            </Field>
            <FormHint attached>
              Om kundens pallkort får en streckkod eller QR-kod för artikelnumret och vårt ordernummer. Systemets
              förval är inställningen under System.
            </FormHint>
          </>
        )}

        <Field label={isCustomer ? "Besöksadress" : "Adress"} htmlFor="address">
          <Textarea id="address" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <FormRow columns="postal">
          <Field label="Postnummer" htmlFor="postalCode">
            <Input id="postalCode" size="sm" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </Field>
          <Field label="Postort" htmlFor="city">
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="Land" htmlFor="country">
            <Input
              id="country"
              size="xs"
              maxLength={2}
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </Field>
        </FormRow>
        <FormHint attached>
          {isCustomer
            ? "Landskod enligt ISO (SE, DE, NO …). Landet och VAT-numret avgör om fakturan får svensk moms, EU-försäljning eller export."
            : "Landskod enligt ISO (SE, DE, CN …). Landet avgör leverantörens förvalda momskod på leverantörsfakturan — Sverige svensk moms, annat EU-land omvänd moms."}
        </FormHint>
        {/* A supplier invoiced in another currency than SEK but with land
            Sverige: the country (which derives the förvalda momskod) is
            probably wrong — typically a foreign supplier left on the default. */}
        {!isCustomer && showCurrency && currency.trim().toUpperCase() !== "SEK" && country.trim().toUpperCase() === "SE" && (
          <FormNotice>
            Leverantören har annan valuta än SEK men land Sverige — kontrollera landet. Landet avgör momskoden på
            leverantörsfakturan (Sverige ger svensk moms, inte omvänd moms).
          </FormNotice>
        )}

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
  );
}

// Partnerns adresser: för kund fakturaadress + e-post för faktura (sparas på
// kunden) ovanpå listan med valbara leveransadresser; för leverantör bara
// leveransadresslistan (subresurs, kontaktmönstret, gemensam för båda).
function AdresserTab({
  partner,
  endpointBase,
  deliveryAddresses,
  kind,
}: {
  partner: Customer | Supplier;
  endpointBase: string;
  deliveryAddresses: PartnerDeliveryAddress[];
  kind: "customer" | "supplier";
}) {
  const router = useRouter();
  const isCustomer = kind === "customer";
  const customer = partner as Customer;
  const [invoiceName, setInvoiceName] = useState(customer.invoiceName ?? "");
  const [invoiceAddress, setInvoiceAddress] = useState(customer.invoiceAddress ?? "");
  const [invoicePostalCode, setInvoicePostalCode] = useState(customer.invoicePostalCode ?? "");
  const [invoiceCity, setInvoiceCity] = useState(customer.invoiceCity ?? "");
  const [invoiceCountry, setInvoiceCountry] = useState(customer.invoiceCountry ?? "");
  const [invoiceEmail, setInvoiceEmail] = useState(customer.invoiceEmail ?? "");
  const { error, setError, saved, setSaved, pending, setPending } = useSaveState();

  const addressesBase = `${endpointBase}/${partner.id}/delivery-addresses`;
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PartnerDeliveryAddress | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  async function saveInvoice(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`${endpointBase}/${partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          invoiceName: orNull(invoiceName),
          invoiceAddress: orNull(invoiceAddress),
          invoicePostalCode: orNull(invoicePostalCode),
          invoiceCity: orNull(invoiceCity),
          // Empty ⇒ null, same as the other invoice fields — the API's
          // countryCodeSchema only runs its ISO-2 regex when a value is sent.
          invoiceCountry: invoiceCountry.trim() ? invoiceCountry.trim().toUpperCase() : null,
          invoiceEmail: orNull(invoiceEmail),
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  async function removeAddress(address: PartnerDeliveryAddress) {
    if (!(await confirmDelete(`Ta bort leveransadressen ${address.label}?`))) return;
    setListError(null);
    try {
      await apiFetch(`${addressesBase}/${address.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Kunde inte ta bort leveransadressen");
    }
  }

  return (
    <div>
      {isCustomer && (
        <Card style={{ marginBottom: 20 }}>
          <Form onSubmit={saveInvoice}>
            <FormError>{error}</FormError>

            <Field label="Fakturanamn" htmlFor="invoiceName">
              <Input
                id="invoiceName"
                placeholder={partner.name}
                value={invoiceName}
                onChange={(e) => setInvoiceName(e.target.value)}
              />
            </Field>

            <Field label="Fakturaadress" htmlFor="invoiceAddress">
              <Textarea id="invoiceAddress" rows={2} value={invoiceAddress} onChange={(e) => setInvoiceAddress(e.target.value)} />
            </Field>

            <FormRow columns="postal">
              <Field label="Postnummer" htmlFor="invoicePostalCode">
                <Input
                  id="invoicePostalCode"
                  size="sm"
                  value={invoicePostalCode}
                  onChange={(e) => setInvoicePostalCode(e.target.value)}
                />
              </Field>
              <Field label="Postort" htmlFor="invoiceCity">
                <Input id="invoiceCity" value={invoiceCity} onChange={(e) => setInvoiceCity(e.target.value)} />
              </Field>
              <Field label="Land" htmlFor="invoiceCountry">
                <Input
                  id="invoiceCountry"
                  size="xs"
                  maxLength={2}
                  placeholder={customer.country}
                  value={invoiceCountry}
                  onChange={(e) => setInvoiceCountry(e.target.value.toUpperCase())}
                />
              </Field>
            </FormRow>

            <Field label="E-post för faktura" htmlFor="invoiceEmail">
              <Input
                id="invoiceEmail"
                type="email"
                value={invoiceEmail}
                onChange={(e) => setInvoiceEmail(e.target.value)}
              />
            </Field>

            <FormActions>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Sparar…" : "Spara"}
              </Button>
              {saved && <FormSaved>Sparat</FormSaved>}
            </FormActions>
          </Form>
        </Card>
      )}

      <FormError>{listError}</FormError>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <strong>Leveransadresser</strong>
        <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
          + Ny leveransadress
        </Button>
      </div>

      <Table<PartnerDeliveryAddress>
        columns={[
          { key: "label", label: "Benämning", width: "1fr" },
          { key: "address", label: "Adress", width: "1.4fr" },
          { key: "postalCode", label: "Postnummer", width: "110px" },
          { key: "city", label: "Postort", width: "140px" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={deliveryAddresses}
        emptyText="Inga leveransadresser registrerade"
        renderCell={(address, key) => {
          switch (key) {
            case "label":
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <strong>{address.label}</strong>
                  {address.isDefault && <StatusPill status="running" label="Förvald" compact />}
                </span>
              );
            case "address":
              return <span style={{ whiteSpace: "pre-line" }}>{address.address}</span>;
            case "postalCode":
              return address.postalCode ?? "–";
            case "city": {
              // Supplier delivery addresses have no country column — the
              // summary only ever adds it for a customer's, and only when it
              // differs from Sweden (documents follow the same rule).
              const country = "country" in address ? address.country : "SE";
              return address.city ? `${address.city}${country !== "SE" ? ` (${country})` : ""}` : "–";
            }
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button type="button" size="small" variant="ghost" onClick={() => setEditing(address)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removeAddress(address)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny leveransadress">
        <DeliveryAddressForm
          addressesBase={addressesBase}
          showCountry={isCustomer}
          visitingAddress={{ address: partner.address, postalCode: partner.postalCode, city: partner.city }}
          copyLabel={isCustomer ? "Kopiera från besöksadressen" : "Kopiera från adressen"}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Redigera ${editing.label}` : ""}
      >
        {editing && (
          <DeliveryAddressForm
            addressesBase={addressesBase}
            address={editing}
            showCountry={isCustomer}
            visitingAddress={{ address: partner.address, postalCode: partner.postalCode, city: partner.city }}
            copyLabel={isCustomer ? "Kopiera från besöksadressen" : "Kopiera från adressen"}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// Creates a delivery address, or edits one when `address` is passed.
// visitingAddress = partnerns besöksadress/adress, copyable into the form
// fields; copyLabel matches whichever wording Allmänt uses for that field
// (Besöksadress for a customer, Adress for a supplier).
function DeliveryAddressForm({
  addressesBase,
  address,
  showCountry,
  visitingAddress,
  copyLabel,
  onSuccess,
}: {
  addressesBase: string;
  address?: PartnerDeliveryAddress;
  // Only customer_delivery_addresses carries a country column — supplier
  // delivery addresses don't, so the field is hidden for those.
  showCountry: boolean;
  visitingAddress: { address: string | null; postalCode: string | null; city: string | null };
  copyLabel: string;
  onSuccess: () => void;
}) {
  const [label, setLabel] = useState(address?.label ?? "");
  const [street, setStreet] = useState(address?.address ?? "");
  const [postalCode, setPostalCode] = useState(address?.postalCode ?? "");
  const [city, setCity] = useState(address?.city ?? "");
  const [country, setCountry] = useState(address && "country" in address ? address.country : "SE");
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (address) {
        await apiFetch(`${addressesBase}/${address.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            label,
            address: street,
            postalCode: orNull(postalCode),
            city: orNull(city),
            ...(showCountry ? { country: country.trim().toUpperCase() || "SE" } : {}),
            isDefault,
          }),
        });
      } else {
        await apiFetch(addressesBase, {
          method: "POST",
          body: JSON.stringify({
            label,
            address: street,
            postalCode: postalCode.trim() || undefined,
            city: city.trim() || undefined,
            ...(showCountry ? { country: country.trim().toUpperCase() || undefined } : {}),
            isDefault,
          }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara leveransadressen");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Benämning" htmlFor="deliveryAddressLabel">
        <Input
          id="deliveryAddressLabel"
          required
          placeholder="t.ex. Huvudlager"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>

      {visitingAddress.address && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              setStreet(visitingAddress.address ?? "");
              setPostalCode(visitingAddress.postalCode ?? "");
              setCity(visitingAddress.city ?? "");
            }}
          >
            {copyLabel}
          </Button>
        </div>
      )}

      <Field label="Adress" htmlFor="deliveryAddressStreet">
        <Textarea id="deliveryAddressStreet" rows={2} required value={street} onChange={(e) => setStreet(e.target.value)} />
      </Field>

      <FormRow columns={showCountry ? "postal" : 2}>
        <Field label="Postnummer" htmlFor="deliveryAddressPostalCode">
          <Input
            id="deliveryAddressPostalCode"
            size="sm"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
          />
        </Field>
        <Field label="Postort" htmlFor="deliveryAddressCity">
          <Input id="deliveryAddressCity" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        {showCountry && (
          <Field label="Land" htmlFor="deliveryAddressCountry">
            <Input
              id="deliveryAddressCountry"
              size="xs"
              maxLength={2}
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </Field>
        )}
      </FormRow>

      <Field label="Förvald" htmlFor="deliveryAddressDefault">
        <Toggle id="deliveryAddressDefault" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : address ? "Spara adress" : "Skapa adress"}
        </Button>
      </FormActions>
    </Form>
  );
}

// The momskod a supplier without one of its own gets: the API's own answer
// (defaultVatCode.derived) while the country is unchanged, else derived here
// from the saved country (supplierDefaultVatCode) against the company's codes.
function derivedSupplierVatCodeName(supplier: Supplier, codes: { code: string; name: string }[]): string {
  if (supplier.defaultVatCode?.derived) return supplier.defaultVatCode.name;
  const derived = supplierDefaultVatCode(supplier.country);
  return codes.find((code) => code.code === derived)?.name ?? derived;
}

// Momsbehandling (spec 4.6): how this customer's invoice rows are taxed,
// worked out from country, VAT-nummer, Privatperson and the construction
// flag — customerVatTreatment, the rules the rows' momskod follows. Reads the
// fields as they stand in the form (VAT-nummer, Privatperson, the construction
// flag), so it is a preview until the card is saved — except the country,
// which is the SAVED one (it is edited on Allmänt).
function CustomerVatTreatmentRow({
  customer,
}: {
  customer: { country: string; vatNumber: string; privatePerson: boolean; reverseChargeConstruction: boolean };
}) {
  const treatment = customerVatTreatment(customer);
  // The VAT-nummer of an EU company customer against the customer's country
  // (customerVatNumberWarning) — a warning, never a refusal on the card.
  const numberWarning = customerVatNumberWarning(customer);
  // Omvänd betalningsskyldighet för byggtjänster only applies to a Swedish
  // company customer (a private person always gets svensk moms).
  const constructionApplies =
    customer.reverseChargeConstruction && !customer.privatePerson && customer.country.trim().toUpperCase() === "SE";
  return (
    <>
      <Field label="Momsbehandling">
        <div style={{ fontWeight: 600 }}>
          {CUSTOMER_VAT_TREATMENT_LABELS[treatment]}
          {constructionApplies && " · tjänster utan moms (byggtjänster)"}
        </div>
      </Field>
      {treatment === "domestic_no_vat_number" && (
        <FormNotice>
          Kunden saknar momsregistreringsnummer — svensk moms debiteras. Ange VAT-numret med landskod (till exempel
          DE123456789) för att kunna fakturera utan moms inom EU.
        </FormNotice>
      )}
      {treatment === "private_eu" && (
        <FormNotice>
          Privatperson i annat EU-land — svensk moms debiteras. Distansförsäljning till privatpersoner i andra
          EU-länder (OSS) ingår inte i Nav.
        </FormNotice>
      )}
      {treatment === "private_export" && (
        <FormNotice>
          Privatperson utanför EU — varor faktureras som export utan moms, tjänster får svensk moms. Spara tull- eller
          utförselbevis som underlag för momsfriheten.
        </FormNotice>
      )}
      {numberWarning && <FormNotice>{buyerVatNumberWarningText(numberWarning)}</FormNotice>}
    </>
  );
}

function RegisterSelect({
  id,
  value,
  onChange,
  entries,
  emptyLabel = "— Inget —",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  entries: RegisterEntry[];
  emptyLabel?: string;
}) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {entries.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.name}
        </option>
      ))}
    </Select>
  );
}

function VillkorTab({
  partner,
  endpointBase,
  registers,
  isCustomer,
  priceLists,
  deliveryDayDefaults,
}: {
  partner: Customer | Supplier;
  endpointBase: string;
  registers: PartnerRegisters;
  isCustomer: boolean;
  priceLists?: PriceList[];
  deliveryDayDefaults: DeliveryDayDefaults | null;
}) {
  const router = useRouter();
  const s = partner as Supplier;
  const [paymentSaved, setPaymentSaved] = useState(false);
  const [orgNumber, setOrgNumber] = useState(partner.orgNumber ?? "");
  const [vatNumber, setVatNumber] = useState(partner.vatNumber ?? "");
  const [privatePerson, setPrivatePerson] = useState(isCustomer ? (partner as Customer).privatePerson : false);
  // Omvänd betalningsskyldighet för byggtjänster (momskoder).
  const [reverseChargeConstruction, setReverseChargeConstruction] = useState(
    isCustomer ? (partner as Customer).reverseChargeConstruction : false
  );
  // Supplier: its own Momskod (förval); "" = derived from the country.
  const [defaultVatCodeId, setDefaultVatCodeId] = useState(!isCustomer ? ((partner as Supplier).defaultVatCodeId ?? "") : "");
  const { codes: vatCodes } = useVatCodes({ enabled: !isCustomer });
  const dims = useDimensions();
  const [defaultCostCenterId, setDefaultCostCenterId] = useState(
    !isCustomer ? ((partner as Supplier).defaultCostCenterId ?? "") : ""
  );
  const [collectiveInvoicing, setCollectiveInvoicing] = useState(
    isCustomer ? (partner as Customer).collectiveInvoicing : false
  );
  const [invoiceDelivery, setInvoiceDelivery] = useState<"email" | "peppol">(
    isCustomer ? (partner as Customer).invoiceDelivery : "email"
  );
  const [peppolId, setPeppolId] = useState(isCustomer ? ((partner as Customer).peppolId ?? "") : "");
  const [deliveryTermId, setDeliveryTermId] = useState(partner.deliveryTermId ?? "");
  const [paymentTermId, setPaymentTermId] = useState(partner.paymentTermId ?? "");
  const [carrierId, setCarrierId] = useState(partner.carrierId ?? "");
  const [carrierCustomerNumber, setCarrierCustomerNumber] = useState(partner.carrierCustomerNumber ?? "");
  const [deliveryDays, setDeliveryDays] = useState<DeliveryDaysValue>({
    weekdays: partner.deliveryWeekdays,
    mode: partner.deliveryDayMode,
    transitDays: partner.transitDays === null ? "" : String(partner.transitDays),
  });
  const [priceListId, setPriceListId] = useState(isCustomer ? ((partner as Customer).priceListId ?? "") : "");
  const selectedPriceList = priceLists?.find((list) => list.id === priceListId) ?? null;
  // Kundrabatt (%) — blanket discount, price chain's last fallback. Stored as
  // a decimal string; edited as plain text like the other percentage inputs.
  const [discountPercent, setDiscountPercent] = useState(
    isCustomer ? String(Number((partner as Customer).discountPercent)) : "0"
  );
  // Frakt etapp 2: default freight product (customers only, and only when
  // the freight integration is enabled — otherwise no field, nothing sent).
  const [freightProducts, setFreightProducts] = useState<FreightProduct[] | null>(null);
  const [defaultFreightProductId, setDefaultFreightProductId] = useState(
    isCustomer ? ((partner as Customer).defaultFreightProductId ?? "") : ""
  );
  useEffect(() => {
    if (!isCustomer) return;
    let cancelled = false;
    apiFetch<{ enabled: boolean }>("/api/v1/freight-settings/status")
      .then((status) => (status.enabled ? apiFetch<FreightProduct[]>("/api/v1/freight-products") : null))
      .then((products) => {
        if (!cancelled) setFreightProducts(products);
      })
      .catch(() => {
        if (!cancelled) setFreightProducts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isCustomer]);
  const { error, setError, saved, setSaved, pending, setPending } = useSaveState();

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    // Empty = null (the system default); the server validates 0-60 too.
    const transitText = deliveryDays.transitDays.trim();
    const transitDays = transitText === "" ? null : Number(transitText);
    if (transitDays !== null && (!Number.isInteger(transitDays) || transitDays < 0 || transitDays > 60)) {
      setError("Transportdagar måste vara ett heltal 0–60 eller tomt för systemets förval");
      return;
    }
    setPending(true);
    try {
      await apiFetch(`${endpointBase}/${partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          orgNumber: orNull(orgNumber),
          vatNumber: orNull(vatNumber),
          deliveryTermId: deliveryTermId || null,
          paymentTermId: paymentTermId || null,
          carrierId: carrierId || null,
          carrierCustomerNumber: orNull(carrierCustomerNumber),
          deliveryWeekdays: deliveryDays.weekdays,
          deliveryDayMode: deliveryDays.mode,
          transitDays,
          ...(isCustomer ? { priceListId: priceListId || null } : {}),
          // blankSafe on the API side rejects "" outright — an emptied field
          // means "no discount", sent as 0, never as a blank string.
          ...(isCustomer
            ? { discountPercent: discountPercent.trim() === "" ? 0 : Number(discountPercent) }
            : {}),
          ...(isCustomer ? { privatePerson, collectiveInvoicing, reverseChargeConstruction } : {}),
          ...(!isCustomer ? { defaultVatCodeId: defaultVatCodeId || null, defaultCostCenterId: defaultCostCenterId || null } : {}),
          // E-faktura: a private person never gets Peppol invoices, so the
          // fields are hidden — and what is sent stays as it was saved.
          ...(isCustomer && !privatePerson ? { invoiceDelivery, peppolId: peppolId.trim() } : {}),
          ...(isCustomer && freightProducts ? { defaultFreightProductId: defaultFreightProductId || null } : {}),
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
    <Card>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>

        {isCustomer && (
          <FormRow>
            <Field label="Privatperson" htmlFor="privatePerson">
              <Toggle
                id="privatePerson"
                checked={privatePerson}
                onChange={(e) => setPrivatePerson(e.target.checked)}
              />
            </Field>
            <Field label="Samlingsfaktura" htmlFor="collectiveInvoicing">
              <Toggle
                id="collectiveInvoicing"
                checked={collectiveInvoicing}
                onChange={(e) => setCollectiveInvoicing(e.target.checked)}
              />
            </Field>
          </FormRow>
        )}
        {isCustomer && collectiveInvoicing && (
          <FormHint attached>
            Faktureras via Försäljning → Samlingsfakturering. &quot;Ny faktura&quot; är spärrad för kunden.
          </FormHint>
        )}
        {isCustomer && (
          <>
            <Field label="Omvänd betalningsskyldighet för byggtjänster" htmlFor="reverseChargeConstruction">
              <Toggle
                id="reverseChargeConstruction"
                checked={reverseChargeConstruction}
                onChange={(e) => setReverseChargeConstruction(e.target.checked)}
              />
            </Field>
            <FormHint attached>
              Tjänsterader till en svensk kund som själv är byggföretag får momskoden Omvänd betalningsskyldighet,
              Sverige — fakturan skrivs ut utan moms och kräver kundens VAT-nummer på formen SE + tio siffror + 01.
              Varor påverkas inte.
            </FormHint>
          </>
        )}

        <FormRow>
          <Field label={isCustomer && privatePerson ? "Personnummer" : "Organisationsnummer"} htmlFor="orgNumber">
            <Input id="orgNumber" size="md" value={orgNumber} onChange={(e) => setOrgNumber(e.target.value)} />
          </Field>
          <Field label="VAT-nummer" htmlFor="vatNumber">
            <Input id="vatNumber" size="md" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
          </Field>
        </FormRow>

        {isCustomer && (
          <CustomerVatTreatmentRow
            customer={{
              country: (partner as Customer).country,
              vatNumber,
              privatePerson,
              reverseChargeConstruction,
            }}
          />
        )}

        {!isCustomer && (
          <>
            <Field label="Momskod (förval)" htmlFor="defaultVatCodeId">
              <Select id="defaultVatCodeId" value={defaultVatCodeId} onChange={(e) => setDefaultVatCodeId(e.target.value)}>
                <option value="">Härleds ur landet</option>
                {vatCodesFor(vatCodes, "purchase", defaultVatCodeId).map((code) => (
                  <option key={code.id} value={code.id}>
                    {vatCodeOptionLabel(code)}
                  </option>
                ))}
                {/* The list could not be read — keep the saved code visible. */}
                {defaultVatCodeId !== "" && !vatCodes.some((code) => code.id === defaultVatCodeId) && (
                  <option value={defaultVatCodeId}>{s.defaultVatCode?.name ?? "Vald momskod"}</option>
                )}
              </Select>
            </Field>
            <FormHint attached>
              Förvald momskod på nya leverantörsfakturor.{" "}
              {defaultVatCodeId === "" ? (
                <>
                  Tomt = härleds ur landet ({s.country}):{" "}
                  <strong>{derivedSupplierVatCodeName(s, vatCodes)}</strong>. Sverige ger svensk moms 25 %, ett annat
                  EU-land omvänd moms på EU-varor och övriga länder varor utanför EU (importmomsen bokförs separat).
                </>
              ) : (
                <>Raderna på fakturan kan ändå få en egen momskod.</>
              )}
            </FormHint>
            {(dims.allCostCenters.length > 0 || defaultCostCenterId !== "") && (
              <>
                <Field label="Kostnadsställe (förval)" htmlFor="defaultCostCenterId">
                  <CostCenterSelect id="defaultCostCenterId" all={dims.allCostCenters} value={defaultCostCenterId} onChange={setDefaultCostCenterId} />
                </Field>
                <FormHint attached>
                  Förvalt kostnadsställe på nya leverantörsfakturor; saknas det används artikelgruppens.
                </FormHint>
              </>
            )}
          </>
        )}

        {isCustomer && !privatePerson && (
          <PeppolFields
            customerId={partner.id}
            invoiceDelivery={invoiceDelivery}
            onInvoiceDeliveryChange={setInvoiceDelivery}
            peppolId={peppolId}
            onPeppolIdChange={setPeppolId}
          />
        )}

        <FormRow>
          <Field label="Leveransvillkor" htmlFor="deliveryTermId">
            <RegisterSelect
              id="deliveryTermId"
              value={deliveryTermId}
              onChange={setDeliveryTermId}
              entries={registers.deliveryTerms}
            />
          </Field>
          <Field label="Betalningsvillkor" htmlFor="paymentTermId">
            <RegisterSelect
              id="paymentTermId"
              value={paymentTermId}
              onChange={setPaymentTermId}
              entries={registers.paymentTerms}
            />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Speditör" htmlFor="carrierId">
            <RegisterSelect id="carrierId" value={carrierId} onChange={setCarrierId} entries={registers.carriers} />
          </Field>
          <Field label="Kundnummer hos speditör" htmlFor="carrierCustomerNumber">
            <Input
              id="carrierCustomerNumber"
              size="md"
              value={carrierCustomerNumber}
              onChange={(e) => setCarrierCustomerNumber(e.target.value)}
            />
          </Field>
        </FormRow>

        <DeliveryDaysFields
          kind={isCustomer ? "customer" : "supplier"}
          value={deliveryDays}
          onChange={setDeliveryDays}
          defaults={deliveryDayDefaults}
        />

        {/* On its own line, not in a two-column FormRow: "Transportör – Produkt"
            is long and gets truncated in half a row (same full-width pattern
            as Fraktartikel on System → Frakt). */}
        {isCustomer && freightProducts && (
          <Field label="Förvald fraktprodukt" htmlFor="defaultFreightProductId">
            <Select
              id="defaultFreightProductId"
              value={defaultFreightProductId}
              onChange={(e) => setDefaultFreightProductId(e.target.value)}
            >
              <option value="">Ingen</option>
              {[...freightProducts]
                .sort((a, b) =>
                  `${a.carrierName} – ${a.productName}`.localeCompare(`${b.carrierName} – ${b.productName}`, "sv")
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.carrierName} – {p.productName}
                  </option>
                ))}
            </Select>
          </Field>
        )}

        {isCustomer && (
          <FormRow>
            {priceLists && (
              <Field label="Prislista" htmlFor="priceListId">
                <RegisterSelect
                  id="priceListId"
                  value={priceListId}
                  onChange={setPriceListId}
                  // Valuta: a list in another currency than SEK says which.
                  entries={priceLists.map((list) => ({
                    ...list,
                    name: list.currency === "SEK" ? list.name : `${list.name} (${list.currency})`,
                  }))}
                  emptyLabel="Ingen prislista"
                />
              </Field>
            )}
            <Field label="Kundrabatt (%)" htmlFor="discountPercent">
              <Input
                id="discountPercent"
                type="number"
                min="0"
                max="100"
                step="0.01"
                size="xs"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
            </Field>
          </FormRow>
        )}

        {/* Valuta: the price chain only uses a list in the order's own
            currency — a list in another currency than the customer's is
            skipped on the customer's ordinary orders. */}
        {isCustomer && selectedPriceList && selectedPriceList.currency !== (partner as Customer).currency && (
          <FormNotice>
            Prislistan är i {selectedPriceList.currency} men kundens valuta är {(partner as Customer).currency}. Listan
            används bara på ordrar i {selectedPriceList.currency}; kundens vanliga ordrar prissätts utan den.
          </FormNotice>
        )}

        <FormHint>
          Leveransvillkor, betalningsvillkor och speditörer underhålls under Grunddata.
          {isCustomer &&
            " Kundrabatten läggs på prislistepriset eller, saknas det, artikelns försäljningspris — men bara när ingen kundspecifik prisregel för artikeln eller artikelgruppen (fliken Priser) matchar. Se Kundpriser i hjälpen."}
        </FormHint>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
    {!isCustomer && (
      <SupplierPaymentDetailsSection
        // Remount on every saved change (the server normalizes the numbers).
        key={[
          s.paymentMethod,
          s.bankgiro,
          s.plusgiro,
          s.bankClearing,
          s.bankAccountNumber,
          s.iban,
          s.bic,
          s.foreignAccountNumber,
          s.clearingSystem,
          s.clearingMemberId,
          s.bankName,
          s.chargeBearer,
          s.paymentReportingCode,
        ].join("|")}
        supplier={s}
        saved={paymentSaved}
        onSavedChange={setPaymentSaved}
      />
    )}
    </>
  );
}

function KontakterTab({ contacts, contactsBase }: { contacts: PartnerContact[]; contactsBase: string }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PartnerContact | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function removeContact(contact: PartnerContact) {
    if (!(await confirmDelete(`Ta bort kontakten ${contact.name}?`))) return;
    setError(null);
    try {
      await apiFetch(`${contactsBase}/${contact.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort kontakten");
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
          + Ny kontakt
        </Button>
      </div>

      <Table<PartnerContact>
        columns={[
          { key: "name", label: "Namn", width: "1.2fr" },
          { key: "phone", label: "Telefon", width: "130px" },
          { key: "mobile", label: "Mobil", width: "130px" },
          { key: "email", label: "E-post", width: "1fr" },
          { key: "comment", label: "Kommentar", width: "1fr" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={contacts}
        emptyText="Inga kontakter registrerade"
        renderCell={(contact, key) => {
          switch (key) {
            case "name":
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <strong>{contact.name}</strong>
                  {contact.isPrimary && <StatusPill status="running" label="Huvudkontakt" compact />}
                </span>
              );
            case "phone":
              return contact.phone ?? "–";
            case "mobile":
              return contact.mobile ?? "–";
            case "email":
              return contact.email ?? "–";
            case "comment":
              return contact.comment ?? "–";
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button type="button" size="small" variant="ghost" onClick={() => setEditing(contact)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removeContact(contact)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny kontakt">
        <ContactForm
          contactsBase={contactsBase}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <ContactForm
            contactsBase={contactsBase}
            contact={editing}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// Creates a contact, or edits one when `contact` is passed.
function ContactForm({
  contactsBase,
  contact,
  onSuccess,
}: {
  contactsBase: string;
  contact?: PartnerContact;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [mobile, setMobile] = useState(contact?.mobile ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [comment, setComment] = useState(contact?.comment ?? "");
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (contact) {
        await apiFetch(`${contactsBase}/${contact.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            phone: orNull(phone),
            mobile: orNull(mobile),
            email: orNull(email),
            comment: orNull(comment),
            isPrimary,
          }),
        });
      } else {
        await apiFetch(contactsBase, {
          method: "POST",
          body: JSON.stringify({
            name,
            phone: phone.trim() || undefined,
            mobile: mobile.trim() || undefined,
            email: email.trim() || undefined,
            comment: comment.trim() || undefined,
            isPrimary,
          }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara kontakten");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Namn" htmlFor="contactFormName">
        <Input id="contactFormName" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <FormRow>
        <Field label="Telefon" htmlFor="contactFormPhone">
          <Input id="contactFormPhone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Mobil" htmlFor="contactFormMobile">
          <Input id="contactFormMobile" value={mobile} onChange={(e) => setMobile(e.target.value)} />
        </Field>
      </FormRow>

      <Field label="E-post" htmlFor="contactFormEmail">
        <Input id="contactFormEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>

      <Field label="Kommentar" htmlFor="contactFormComment">
        <Input id="contactFormComment" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>

      <Field label="Huvudkontakt" htmlFor="contactFormPrimary">
        <Toggle id="contactFormPrimary" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : contact ? "Spara kontakt" : "Skapa kontakt"}
        </Button>
      </FormActions>
    </Form>
  );
}
