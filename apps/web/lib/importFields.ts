// Field metadata for the import wizard's mapping step. MIRROR of the API's
// per-entity field lists (apps/api/src/modules/import/service/articles.ts) —
// the web app cannot import @navet/shared (Turbopack vs .js-suffix imports),
// so keep the lists in sync by hand. Customer/supplier lists are added here
// by later import blocks.
export type ImportFieldConfig = { field: string; label: string; required?: boolean };

// Only Artikelnummer is required by the wizard: the API insists on a name
// just for rows that CREATE an article, and Monitor's planning/extra-name
// sub-exports (Nettovikt, Beställningspunkt, Färg …) carry no name column —
// they are pure-update files keyed on the number.
export const ARTICLE_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "articleNumber", label: "Artikelnummer", required: true },
  { field: "name", label: "Benämning" },
  { field: "type", label: "Artikeltyp" },
  { field: "unitCode", label: "Enhet" },
  { field: "groupCode", label: "Varugrupp (kod)" },
  { field: "articleCode", label: "Artikelkod" },
  { field: "standardCost", label: "Standardpris" },
  { field: "weight", label: "Vikt (kg)" },
  { field: "surfaceTreatment", label: "Ytbehandling" },
  { field: "colour", label: "Färg" },
  { field: "extraDescription", label: "Extra benämning" },
  { field: "active", label: "Aktiv" },
  // Monitor's Planering export (Beställningspunkt, Orderkvantitet,
  // Avrundningsantal, Partiformningsregel).
  { field: "reorderPoint", label: "Beställningspunkt" },
  { field: "orderQuantity", label: "Orderkvantitet" },
  { field: "rounding", label: "Avrundning" },
  { field: "lotSizingRule", label: "Partiformningsregel" },
  // Revisioner: the article's active revision and a drawing number with its
  // active revision.
  { field: "articleRevision", label: "Artikelrevision" },
  { field: "drawingNumber", label: "Ritningsnummer" },
  { field: "drawingRevision", label: "Ritningsrevision" },
  // Monitor's Inköp export: Antal/kolli and the primary supplier.
  { field: "quantityPerPackage", label: "Antal per förpackning" },
  { field: "primarySupplierNumber", label: "Leverantörsnr" },
];

// Mirrors ARTICLE_UNIT_IMPORT_FIELDS in
// apps/api/src/modules/import/service/article-units.ts (Monitor's
// "Artikellista, Enheter").
export const ARTICLE_UNIT_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "articleNumber", label: "Artikelnummer", required: true },
  { field: "unitCode", label: "Enhet", required: true },
  { field: "factor", label: "Omräkningsfaktor", required: true },
  { field: "isPurchaseUnit", label: "Inköpsenhet (Inköpsorder)" },
  { field: "isSalesUnit", label: "Försäljningsenhet (Kundorder)" },
];

// Mirrors SUPPLIER_PRICE_IMPORT_FIELDS in
// apps/api/src/modules/import/service/supplier-prices.ts (Monitor's
// "Prislista Inköp", plain and stafflat).
export const SUPPLIER_PRICE_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "articleNumber", label: "Artikelnummer", required: true },
  { field: "supplierNumber", label: "Leverantörsnummer", required: true },
  { field: "supplierArticleNumber", label: "Leverantörens artikelnummer" },
  { field: "price", label: "Pris" },
  { field: "discountPercent", label: "Rabatt (%)" },
  { field: "isPrimary", label: "Huvudleverantör (Förvald)" },
  { field: "breakQuantity", label: "Staffel: från antal (Gränsvärde)" },
  { field: "breakPrice", label: "Staffel: pris" },
];

// Mirrors CUSTOMER_PRICE_IMPORT_FIELDS in
// apps/api/src/modules/import/service/customer-prices.ts (Monitor's
// "Prislista Försäljning" and "Artikellista, Kundkopplingar"). Pris is not
// required: a row may carry only Kundens artikelnummer.
export const CUSTOMER_PRICE_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "articleNumber", label: "Artikelnummer", required: true },
  { field: "customerNumber", label: "Kundnummer", required: true },
  { field: "price", label: "Pris" },
  { field: "discountPercent", label: "Rabatt (%)" },
  { field: "customerArticleNumber", label: "Kundens artikelnummer" },
  { field: "setupPrice", label: "Ställpris" },
];

// Mirrors CUSTOMER_IMPORT_FIELDS in
// apps/api/src/modules/import/service/customers.ts. Only Kundnummer is
// required by the wizard: the API insists on a name just for rows that
// CREATE a customer, and Monitor's Fakturaadress file has no column that
// should map to Namn — a wizard-level requirement would force the short
// "Namn" onto it and overwrite the legal name.
export const CUSTOMER_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "customerNumber", label: "Kundnummer", required: true },
  { field: "name", label: "Namn" },
  { field: "orgNumber", label: "Organisationsnummer" },
  { field: "vatNumber", label: "VAT-nummer" },
  { field: "contactName", label: "Kontaktperson" },
  { field: "email", label: "E-post" },
  { field: "phone", label: "Telefon" },
  { field: "address", label: "Adress" },
  { field: "address2", label: "Adressrad 2" },
  { field: "address3", label: "Adressrad 3" },
  { field: "postalCode", label: "Postnummer" },
  { field: "city", label: "Postort" },
  { field: "country", label: "Land" },
  { field: "paymentTerm", label: "Betalningsvillkor" },
  { field: "deliveryTerm", label: "Leveransvillkor" },
  { field: "carrier", label: "Leveranssätt/speditör" },
  { field: "priceList", label: "Prislista" },
  { field: "discountPercent", label: "Kundrabatt (%)" },
  { field: "invoiceAddressDiffers", label: "Avviker från postadress" },
  { field: "invoiceName", label: "Fakturanamn" },
  { field: "invoiceAddress", label: "Fakturaadress" },
  { field: "invoiceAddress2", label: "Fakturaadressrad 2" },
  { field: "invoiceAddress3", label: "Fakturaadressrad 3" },
  { field: "invoicePostalCode", label: "Fakturapostnummer" },
  { field: "invoiceCity", label: "Fakturapostort" },
  { field: "invoiceCountry", label: "Fakturaland" },
  { field: "invoiceEmail", label: "E-post för faktura" },
  { field: "ourSupplierNumber", label: "Vårt leverantörsnummer" },
  { field: "collectiveInvoicing", label: "Samlingsfaktura" },
  { field: "privatePerson", label: "Privatperson" },
  { field: "website", label: "Webbsida" },
  { field: "currency", label: "Valuta" },
];

// Mirrors SUPPLIER_IMPORT_FIELDS in
// apps/api/src/modules/import/service/suppliers.ts. No country, invoice
// address, price list or discount — suppliers carry none of those. Only
// Leverantörsnummer is required by the wizard: the API insists on a name
// just for rows that CREATE a supplier, and Monitor's Postadress file lists
// a short "Namn" column ahead of the full "Postadress – Namn" one — the
// short column is meant to stay unmapped, so a wizard-level requirement on
// Namn would force the wrong column in.
export const SUPPLIER_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "supplierNumber", label: "Leverantörsnummer", required: true },
  { field: "name", label: "Namn" },
  { field: "orgNumber", label: "Organisationsnummer" },
  { field: "vatNumber", label: "VAT-nummer" },
  { field: "contactName", label: "Kontaktperson" },
  { field: "email", label: "E-post" },
  { field: "phone", label: "Telefon" },
  { field: "address", label: "Adress" },
  { field: "address2", label: "Adressrad 2" },
  { field: "address3", label: "Adressrad 3" },
  { field: "postalCode", label: "Postnummer" },
  { field: "city", label: "Postort" },
  { field: "country", label: "Land" },
  { field: "currency", label: "Valuta" },
  { field: "ourCustomerNumber", label: "Vårt kundnummer" },
  { field: "paymentTerm", label: "Betalningsvillkor" },
  { field: "deliveryTerm", label: "Leveransvillkor" },
  { field: "carrier", label: "Leveranssätt/speditör" },
  { field: "carrierCustomerNumber", label: "Kundnummer hos speditör" },
];

// Mirrors SUPPLIER_CONTACT_IMPORT_FIELDS in
// apps/api/src/modules/import/service/supplier-contacts.ts — the supplier
// twin of CUSTOMER_CONTACT_IMPORT_FIELDS below.
export const SUPPLIER_CONTACT_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "supplierNumber", label: "Leverantörsnummer", required: true },
  { field: "name", label: "Namn", required: true },
  { field: "isPrimary", label: "Förvald" },
  { field: "phone", label: "Telefon" },
  { field: "mobile", label: "Mobiltelefon" },
  { field: "email", label: "E-post" },
  { field: "comment", label: "Anmärkning" },
  { field: "fax", label: "Faxnummer" },
];

// Mirrors SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS in
// apps/api/src/modules/import/service/supplier-delivery-addresses.ts — the
// supplier twin of CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS, minus Land
// (supplier_delivery_addresses has no country column).
export const SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "supplierNumber", label: "Leverantörsnummer", required: true },
  { field: "label", label: "Namn" },
  { field: "address", label: "Adressrad 1" },
  { field: "address2", label: "Adressrad 2" },
  { field: "address3", label: "Adressrad 3" },
  { field: "postalCode", label: "Postnummer" },
  { field: "city", label: "Stad" },
];

// Mirrors BOM_IMPORT_FIELDS in apps/api/src/modules/import/service/bom.ts.
// articleNumber is the PARENT article; the component sits in its own column.
// Create-only unless "Uppdatera befintliga strukturrader" is ticked.
export const BOM_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "articleNumber", label: "Artikelnummer", required: true },
  { field: "componentNumber", label: "Komponentnummer", required: true },
  { field: "quantity", label: "Antal", required: true },
  // The COMPONENT's unit in both roles: the row's display unit for a component
  // that exists, and the base unit for one the import creates.
  { field: "unitCode", label: "Enhet" },
  { field: "operationSequenceNo", label: "Operation" },
  // Monitor's "Pos." — the position on the drawing.
  { field: "position", label: "Pos." },
  // Read only for components missing from the article register, and only with
  // "Skapa saknade artiklar". Labelled "Artikelbenämning" because that is what
  // the column is called in the files people import — the parenthesis says
  // WHOSE name it is, since the parent's name is never stored.
  { field: "componentName", label: "Artikelbenämning (komponenten)" },
  { field: "componentType", label: "Komponentens artikeltyp" },
  { field: "componentStandardCost", label: "Komponentens standardpris" },
];

// Mirrors CUSTOMER_CONTACT_IMPORT_FIELDS in
// apps/api/src/modules/import/service/customer-contacts.ts. Create-only: a
// (customer, name) pair that already exists is always skipped, never
// updated — required only insists on customerNumber + name.
export const CUSTOMER_CONTACT_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "customerNumber", label: "Kundnummer", required: true },
  { field: "name", label: "Namn", required: true },
  { field: "isPrimary", label: "Förvald" },
  { field: "phone", label: "Telefon" },
  { field: "mobile", label: "Mobiltelefon" },
  { field: "email", label: "E-post" },
  { field: "comment", label: "Anmärkning" },
  { field: "fax", label: "Faxnummer" },
];

// Mirrors CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS in
// apps/api/src/modules/import/service/customer-delivery-addresses.ts.
// address2/address3 join into the one stored address column; create-only,
// with a "same as an address already on record" skip rule instead of an
// update.
export const CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "customerNumber", label: "Kundnummer", required: true },
  { field: "label", label: "Namn" },
  { field: "address", label: "Adressrad 1" },
  { field: "address2", label: "Adressrad 2" },
  { field: "address3", label: "Adressrad 3" },
  { field: "postalCode", label: "Postnummer" },
  { field: "city", label: "Stad" },
  { field: "country", label: "Land" },
];

// Mirrors ROUTING_IMPORT_FIELDS in
// apps/api/src/modules/import/service/routing.ts. The times are not required
// columns — Monitor's lego export has none — but a row on an ordinary
// resource without both is a row error (never guessed as 0).
export const ROUTING_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "articleNumber", label: "Artikelnummer", required: true },
  { field: "sequenceNo", label: "Sekvensnr", required: true },
  { field: "workCenterCode", label: "Resurs", required: true },
  // Both times are read in the unit the Tidsenhet column names (Monitor's
  // "Enhet": antal/timme = st/h with the setup time in hours); unmapped, they
  // are minutes.
  { field: "setupTime", label: "Ställtid" },
  { field: "runTimePerUnit", label: "Stycktid / Tid per enhet" },
  { field: "timeUnit", label: "Tidsenhet" },
  { field: "costingOnly", label: "Kalkyl" },
  // Monitor G5 heads this column "Instruktion".
  { field: "comment", label: "Kommentar" },
  // Monitor G5 heads this column "Operationens benämning".
  { field: "description", label: "Beskrivning" },
  { field: "packingInstructions", label: "Packinstruktion" },
  // Lego operations (Monitor's Operationslista, Lego).
  { field: "subcontractSupplierNumber", label: "Legoleverantör" },
  { field: "setupPrice", label: "Ställpris" },
  { field: "unitPrice", label: "Styckpris" },
  // Monitor's "Cykeltid" — the productive time, same unit as Stycktid.
  { field: "cycleTimePerUnit", label: "Cykeltid" },
];

// Mirrors WORK_CENTER_IMPORT_FIELDS in
// apps/api/src/modules/import/service/work-centers.ts. Only Nummer is
// required by the wizard — the API insists on a name just for rows that
// CREATE a resource. productionGroupCode/-Name resolve or create the
// production group (Monitor's Avdelning) the resource belongs to.
export const WORK_CENTER_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "code", label: "Nummer", required: true },
  { field: "name", label: "Namn" },
  { field: "type", label: "Typ" },
  { field: "productionGroupCode", label: "Avdelning (produktionsgrupp)" },
  { field: "productionGroupName", label: "Avdelningens namn" },
  { field: "hourlyRate", label: "Timkostnad" },
  { field: "calcRate1", label: "Kalkylpris 1" },
  { field: "calcRate2", label: "Kalkylpris 2" },
  { field: "rateAppliesToSetup", label: "Gäller ställ" },
  { field: "rateAppliesToRun", label: "Gäller styck" },
  { field: "defaultSetupTime", label: "Förvald ställtid" },
  { field: "defaultOperationName", label: "Förvald operationsbenämning" },
  { field: "costRowName", label: "Kostnadsrad" },
];

// Mirrors LEGO_WORK_CENTER_IMPORT_FIELDS in
// apps/api/src/modules/import/service/lego-work-centers.ts. Only Nummer is
// required by the wizard; supplierNumber links the legoresurs to an
// existing supplier and the row errors if that supplier isn't found.
export const LEGO_WORK_CENTER_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "code", label: "Nummer", required: true },
  { field: "name", label: "Namn" },
  { field: "supplierNumber", label: "Leverantörsnummer" },
  { field: "leadTimeDays", label: "Ledtid (dagar)" },
  { field: "queueTimeDays", label: "Kötid (dagar)" },
  { field: "orderLeadTimeDays", label: "Ledtid beställning (dagar)" },
];

// Mirrors PRODUCTION_GROUP_IMPORT_FIELDS in
// apps/api/src/modules/import/service/production-groups.ts. Only Kod is
// required by the wizard.
export const PRODUCTION_GROUP_IMPORT_FIELDS: ImportFieldConfig[] = [
  { field: "code", label: "Kod", required: true },
  { field: "name", label: "Namn" },
  { field: "description", label: "Beskrivning" },
];
