// Machine-readable error codes shared by the API envelope and the web's
// Swedish message dictionary (uppföljningssvepet, Package 1).
//
// The API DERIVES codes from error class names at runtime (see
// apps/api/src/modules/system/service/error-body.ts) — this file lists only
// the codes the web maps to Swedish text, as constants, so both sides key off
// the same strings. apps/api/test/error-codes.test.ts instantiates the real
// classes and pins each derivation against these constants: renaming an error
// class fails that test instead of silently breaking the UI translation.
export const ERROR_CODES = {
  // article register (inline editing)
  BASE_UNIT_LOCKED: "base-unit-locked",
  INVALID_REFERENCE: "invalid-reference",
  INVALID_UNIT: "invalid-unit",
  ARTICLE_NOT_FOUND: "article-not-found",
  // Skanning (#4): Streckkod (EAN) is unique
  DUPLICATE_ARTICLE_BARCODE: "duplicate-article-barcode",
  // Kopiera från befintlig artikel
  ARTICLE_COPY_PART_NOT_ALLOWED: "article-copy-part-not-allowed",
  // Produktkonfigurator: a template in mode variants on a new order row
  ARTICLE_IS_TEMPLATE: "article-is-template",

  // payroll / timereport
  UNFINISHED_ATTENDANCE: "unfinished-attendance",
  // GDPR (#2): Radera/Anonymisera a personalkort
  EMPLOYEE_ERASURE_BLOCKED: "employee-erasure-blocked",
  EMPLOYEE_HAS_HISTORY: "employee-has-history",
  EMPLOYEE_ANONYMIZED: "employee-anonymized",
  ALREADY_ATTESTED: "already-attested",
  ATTESTATION_NOT_FOUND: "attestation-not-found",
  PAYROLL_PERIOD_LOCKED: "payroll-period-locked",
  PERIOD_NOT_ENDED: "period-not-ended",
  UNATTESTED_EMPLOYEES: "unattested-employees",
  PERIOD_NOT_LOCKED: "period-not-locked",
  INVALID_ATTENDANCE_INTERVAL: "invalid-attendance-interval",
  ALREADY_PRESENT: "already-present",
  ATTENDANCE_OPEN_FROM_EARLIER_DAY: "attendance-open-from-earlier-day",
  // Närvaroavvikelser: the terminal must ask for a reason / an overtime choice
  ATTENDANCE_INPUT_REQUIRED: "attendance-input-required",
  ATTENDANCE_REASON_INVALID: "attendance-reason-invalid",
  ATF_TRANSACTION_MISMATCH: "atf-transaction-mismatch",
  // Utjämning saved on a week schedule while the system setting is off
  SCHEDULE_BALANCING_OFF: "schedule-balancing-off",
  // A supervisor's correction raced a stamp that changed the session
  ATTENDANCE_SESSION_CHANGED: "attendance-session-changed",
  INVALID_STOP_TIME: "invalid-stop-time",
  STAMP_SESSION_ALREADY_STOPPED: "stamp-session-already-stopped",
  STOP_TIME_NOT_ALLOWED: "stop-time-not-allowed",
  DUPLICATE_ABSENCE: "duplicate-absence",
  DUPLICATE_PAYROLL_CODE: "duplicate-payroll-code",
  INVALID_OB_WINDOW: "invalid-ob-window",
  // economy
  OVERLAPPING_FISCAL_YEAR: "overlapping-fiscal-year",
  FISCAL_YEAR_BEFORE_CLOSED_YEAR: "fiscal-year-before-closed-year",
  VAT_PERIOD_NOT_COVERED: "vat-period-not-covered",
  VAT_PERIOD_ALREADY_SETTLED: "vat-period-already-settled",
  VAT_ACCOUNTS_NOT_DISTINCT: "vat-accounts-not-distinct",
  ACCOUNTING_PERIOD_LOCKED: "accounting-period-locked",
  ZERO_AMOUNT_POSTING: "zero-amount-posting",
  NO_ACCOUNTING_PERIOD: "no-accounting-period",
  NO_ACCOUNTING_PERIOD_FOR_POSTING: "no-accounting-period-for-posting",
  MISSING_POSTING_ACCOUNT: "missing-posting-account",
  ACCOUNT_NOT_FOUND: "account-not-found",
  DUPLICATE_ACCOUNT_NUMBER: "duplicate-account-number",
  NO_FISCAL_YEAR_FOR_DATE: "no-fiscal-year-for-date",
  VERIFICATION_SERIES_NOT_FOUND: "verification-series-not-found",
  UNBALANCED_VERIFICATION: "unbalanced-verification",
  TOO_FEW_VERIFICATION_ROWS: "too-few-verification-rows",
  INACTIVE_ACCOUNT: "inactive-account",
  ALREADY_REVERSED: "already-reversed",
  INVALID_VERIFICATION_STATE: "invalid-verification-state",
  DUPLICATE_POSTING_RULE: "duplicate-posting-rule",
  POSTING_RULE_NO_ACCOUNTS: "posting-rule-no-accounts",
  // Momskoder (bokföringsgranskningen etapp 1)
  VAT_CODE_NOT_FOUND: "vat-code-not-found",
  VAT_CODE_SLOT_NOT_USED: "vat-code-slot-not-used",
  VAT_CODE_ACCOUNT_INVALID: "vat-code-account-invalid",
  VAT_CODE_ACCOUNT_CONFLICT: "vat-code-account-conflict",
  VAT_CODE_AMOUNT_MISMATCH: "vat-code-amount-mismatch",
  VAT_CODE_NOT_APPLICABLE: "vat-code-not-applicable",
  // PATCH /vat-codes/:id { active: false } on MP25/MP12/MP6/MF (400)
  VAT_CODE_REQUIRED: "vat-code-required",
  POSTING_RULE_VAT_CODE: "posting-rule-vat-code",
  IMPORT_VAT_CODE: "import-vat-code",
  VAT_FILE_ORG_NUMBER_MISSING: "vat-file-org-number-missing",
  SUPPLIER_INVOICE_VAT_CODE: "supplier-invoice-vat-code",
  // Valuta (bokföringsgranskningen etapp 2)
  // No rate for the currency and day (409, body.currency/body.date)
  EXCHANGE_RATE_UNAVAILABLE: "exchange-rate-unavailable",
  // Hämta från Riksbanken failed (502, or 409 for a refused API key; body.reason
  // unavailable|rate_limited|unauthorized|unexpected)
  RIKSBANK_UNAVAILABLE: "riksbank-unavailable",
  // A SEK supplier invoice with another rate than 1 (400)
  SUPPLIER_INVOICE_EXCHANGE_RATE: "supplier-invoice-exchange-rate",
  // Attest of a foreign invoice that has no rate (409)
  SUPPLIER_INVOICE_EXCHANGE_RATE_MISSING: "supplier-invoice-exchange-rate-missing",
  // One payment, invoices in two currencies (400, body.currencies)
  PAYMENT_MIXED_CURRENCIES: "payment-mixed-currencies",
  // amountSek/bankFeeSek do not fit the payment (400, body.reason
  // required|sign|fee|kvittning|sek, body.currency)
  SUPPLIER_PAYMENT_AMOUNT_SEK: "supplier-payment-amount-sek",
  // Valuta steg 3 (försäljning i valuta)
  // A new currency on an order that has rows (409)
  SALES_ORDER_CURRENCY_LOCKED: "sales-order-currency-locked",
  // A new row priced in the order's old currency after a concurrent
  // currency change (409, body.pricedIn/body.currency)
  SALES_ORDER_CURRENCY_CHANGED: "sales-order-currency-changed",
  // A rate other than 1 on a SEK order/quote/price question (400)
  SALES_ORDER_EXCHANGE_RATE: "sales-order-exchange-rate",
  // A new currency on a price list that has rows (409)
  PRICE_LIST_CURRENCY_LOCKED: "price-list-currency-locked",
  // An order row/shipment in another currency than the invoice's (400,
  // body.rowCurrency/body.invoiceCurrency)
  INVOICE_ROW_CURRENCY_MISMATCH: "invoice-row-currency-mismatch",
  // A rate that does not fit the invoice (400, body.reason sek|credit)
  INVOICE_EXCHANGE_RATE: "invoice-exchange-rate",
  // Påminnelseavgift on an invoice in another currency than SEK (409,
  // body.currency)
  REMINDER_FEE_CURRENCY: "reminder-fee-currency",
  // amountSek/bankFeeSek do not fit a customer payment (400, body.reason
  // required|sign|fee|kvittning|sek, body.currency)
  CUSTOMER_PAYMENT_AMOUNT_SEK: "customer-payment-amount-sek",
  // a document's chosen code is unknown, inactive or of the wrong direction
  // (400, body.reason unknown|inactive|not_applicable)
  INVALID_VAT_CODE: "invalid-vat-code",
  // Utfärda: EU sale / omvänd betalningsskyldighet without (a well-formed)
  // buyer momsregistreringsnummer (409, body.reason missing|eu_format|ob_format)
  VAT_NUMBER_REQUIRED: "vat-number-required",
  // Periodisk sammanställning: not one calendar month/quarter (400), no EU
  // sales to submit (409), the reporter's details missing (409, body.missing)
  // and an amount over 12 characters (400)
  PERIODIC_SUMMARY_PERIOD_INVALID: "periodic-summary-period-invalid",
  PERIODIC_SUMMARY_EMPTY: "periodic-summary-empty",
  // the file: EU sales in the period, but none with a valid buyer VAT number (409)
  PERIODIC_SUMMARY_NO_VALID_ROWS: "periodic-summary-no-valid-rows",
  // PATCH /settings/vat-reporting: a contact name/phone the file cannot carry
  // (400, body.field contactName|contactPhone; the message says which rule)
  VAT_REPORTING_CONTACT_INVALID: "vat-reporting-contact-invalid",
  PERIODIC_SUMMARY_REPORTER_INCOMPLETE: "periodic-summary-reporter-incomplete",
  PERIODIC_SUMMARY_AMOUNT_TOO_LARGE: "periodic-summary-amount-too-large",
  // Snabbare manuell bokföring (bokföringsgranskningen etapp 3)
  VERIFICATION_TEMPLATE_NOT_FOUND: "verification-template-not-found",
  // POST/PATCH /verification-templates with a name another template has (409)
  VERIFICATION_TEMPLATE_NAME_TAKEN: "verification-template-name-taken",
  // A template/fördelning row names an account the chart lacks (400, body.accounts)
  VERIFICATION_TEMPLATE_ACCOUNT_MISSING: "verification-template-account-missing",
  // DELETE on a template a recurring post uses (409)
  VERIFICATION_TEMPLATE_IN_USE: "verification-template-in-use",
  RECURRING_VERIFICATION_NOT_FOUND: "recurring-verification-not-found",
  // POST /recurring-verifications on a template without amounts on every row
  // or that does not balance (400, the message says which)
  RECURRING_TEMPLATE_INCOMPLETE: "recurring-template-incomplete",
  // SIE verification import: the same file again (409, body.importedAt/importedBy)
  SIE_FILE_ALREADY_IMPORTED: "sie-file-already-imported",
  // ...or something that stops the whole file (409, body.blockers)
  SIE_VERIFICATION_IMPORT_BLOCKED: "sie-verification-import-blocked",
  // SIE opening-balance import: an #IB account the chart lacks that is not
  // four digits and so cannot be created (400, body.accounts)
  SIE_INVALID_ACCOUNT_NUMBER: "sie-invalid-account-number",
  // Kostnadsställen och projekt (bokföringsgranskningen etapp 5 del A).
  // POST/PATCH /cost-centers|/projects with a code another entry has (409)
  COST_CENTER_CODE_TAKEN: "cost-center-code-taken",
  PROJECT_CODE_TAKEN: "project-code-taken",
  // A closed project picked on a NEW row (400)
  PROJECT_CLOSED: "project-closed",
  // An inactive cost center picked on a NEW row (400)
  COST_CENTER_INACTIVE: "cost-center-inactive",
  // An unknown cost center / project id on a row, header or register route (404)
  COST_CENTER_NOT_FOUND: "cost-center-not-found",
  PROJECT_NOT_FOUND: "project-not-found",
  // POST/PATCH /projects with a customerId that does not exist (404)
  PROJECT_CUSTOMER_NOT_FOUND: "project-customer-not-found",
  // PATCH /projects that would put the end date before the start date (400)
  PROJECT_DATES: "project-dates",
  // DELETE of a cost center / project carried by booked verification rows (409)
  DIMENSION_BOOKED: "dimension-booked",
  // Bokför of a manual verification with a row on an account that has Kräver
  // kostnadsställe but no cost center (409, body.accounts = the numbers)
  COST_CENTER_REQUIRED: "cost-center-required",
  // Budget (bokföringsgranskningen etapp 5 del B).
  // An unknown budget id (404)
  BUDGET_NOT_FOUND: "budget-not-found",
  // POST/PATCH/copy with a name another budget of the year has (409)
  BUDGET_NAME_TAKEN: "budget-name-taken",
  // A line on an account the chart lacks or outside class 3–8 / 8990–8999
  // (400, body.accounts = the numbers)
  BUDGET_ACCOUNT_INVALID: "budget-account-invalid",
  // `amounts` with another length than the year's period count (400)
  BUDGET_MONTH_INVALID: "budget-month-invalid",
  // The same account twice in one PUT (400)
  BUDGET_DUPLICATE_ACCOUNT: "budget-duplicate-account",
  // Kopiera utfall without a source year when the budget's year has no
  // predecessor (400)
  BUDGET_NO_PREVIOUS_YEAR: "budget-no-previous-year",
  // Resultaträkningen: budgetId together with projectId or groupBy (400)
  BUDGET_NOT_COMBINABLE: "budget-not-combinable",
  // Resultaträkningen: from/to outside the budget's fiscal year (400)
  BUDGET_RANGE_OUTSIDE_YEAR: "budget-range-outside-year",
  // årsbokslut
  FISCAL_YEAR_CLOSED: "fiscal-year-closed",
  YEAR_END_CLOSING_NOT_FOUND: "year-end-closing-not-found",
  YEAR_END_CLOSING_EXISTS: "year-end-closing-exists",
  INVALID_CLOSING_DATE: "invalid-closing-date",
  CLOSING_DATE_LOCKED: "closing-date-locked",
  YEAR_END_CLOSING_CLOSED: "year-end-closing-closed",
  YEAR_END_CLOSING_VERIFICATION: "year-end-closing-verification",
  YEAR_END_BLOCKED: "year-end-blocked",
  INVENTORY_ACCOUNT_CONFLICT: "inventory-account-conflict",
  INVALID_ACCRUAL_ACCOUNT: "invalid-accrual-account",
  NEXT_FISCAL_YEAR_MISSING: "next-fiscal-year-missing",
  YEAR_END_STEP_ORDER: "year-end-step-order",
  YEAR_END_CLOSING_NOT_CLOSED: "year-end-closing-not-closed",
  NEXT_FISCAL_YEAR_CLOSED: "next-fiscal-year-closed",
  PROFIT_DISPOSITION_ACTIVE: "profit-disposition-active",
  INVALID_AGM_DATE: "invalid-agm-date",
  PROFIT_DISPOSITION_EXISTS: "profit-disposition-exists",
  NOTHING_TO_DISPOSE: "nothing-to-dispose",
  PROFIT_DISPOSITION_NOT_FOUND: "profit-disposition-not-found",
  // Valutaomvärdering: no rate for a currency the open items need (409,
  // body.currencies/body.date) — type the rate in the step
  FX_REVALUATION_RATE_MISSING: "fx-revaluation-rate-missing",
  // anläggningsregister
  FIXED_ASSET_NOT_FOUND: "fixed-asset-not-found",
  FIXED_ASSET_CATEGORY_NOT_FOUND: "fixed-asset-category-not-found",
  SUPPLIER_INVOICE_NOT_FOUND: "supplier-invoice-not-found",
  DEPRECIATION_RUN_NOT_FOUND: "depreciation-run-not-found",
  DUPLICATE_FIXED_ASSET_CATEGORY_NAME: "duplicate-fixed-asset-category-name",
  FIXED_ASSET_CATEGORY_IN_USE: "fixed-asset-category-in-use",
  FIXED_ASSET_CATEGORY_ACCOUNTS_NOT_DISTINCT: "fixed-asset-category-accounts-not-distinct",
  FIXED_ASSET_CATEGORY_ACCOUNTS_LOCKED: "fixed-asset-category-accounts-locked",
  FIXED_ASSET_BAS_ACCOUNT_MISSING: "fixed-asset-bas-account-missing",
  FIXED_ASSET_FIELD_LOCKED: "fixed-asset-field-locked",
  FIXED_ASSET_NOT_ACTIVE: "fixed-asset-not-active",
  FIXED_ASSET_HAS_DEPRECIATION: "fixed-asset-has-depreciation",
  FIXED_ASSET_LIFE_TOO_SHORT: "fixed-asset-life-too-short",
  INVALID_FIXED_ASSET_VALUES: "invalid-fixed-asset-values",
  INVALID_OPENING_DEPRECIATION: "invalid-opening-depreciation",
  DEPRECIATION_MONTH_IN_FUTURE: "depreciation-month-in-future",
  NOTHING_TO_DEPRECIATE: "nothing-to-depreciate",
  DEPRECIATION_RUN_NOT_LATEST: "depreciation-run-not-latest",
  DISPOSAL_RUN_NOT_UNDOABLE: "disposal-run-not-undoable",
  RUN_PRECEDES_DISPOSAL: "run-precedes-disposal",
  INVALID_DISPOSAL_DATE: "invalid-disposal-date",
  FIXED_ASSET_VERIFICATION: "fixed-asset-verification",
  FIXED_ASSET_PLAN_YEAR_NOT_FOUND: "fixed-asset-plan-year-not-found",
  // sales / purchase
  SALES_ORDER_ROW_NOT_FOUND: "sales-order-row-not-found",
  OVER_DELIVERY: "over-delivery",
  DELIVERY_NOT_FOUND: "delivery-not-found",
  DELIVERY_ROW_NOT_FOUND: "delivery-row-not-found",
  DELIVERY_ROW_ALREADY_UNDONE: "delivery-row-already-undone",
  DELIVERY_ROW_NOT_UNDOABLE: "delivery-row-not-undoable",
  DELIVERY_ON_SHIPMENT: "delivery-on-shipment",
  DELIVERY_ROW_INVOICED: "delivery-row-invoiced",
  DELIVERY_UNDONE: "delivery-undone",
  SHIPMENT_DELIVERY_UNDONE: "shipment-delivery-undone",
  ROW_HAS_RECEIPTS: "row-has-receipts",
  OVER_RECEIPT: "over-receipt",
  PURCHASE_RECEIPT_NOT_FOUND: "purchase-receipt-not-found",
  PURCHASE_RECEIPT_ALREADY_UNDONE: "purchase-receipt-already-undone",
  PURCHASE_RECEIPT_STOCK_MISSING: "purchase-receipt-stock-missing",
  PURCHASE_RECEIPT_MANUFACTURING_ORDER_LOCKED: "purchase-receipt-manufacturing-order-locked",
  PRICE_LIST_IN_USE: "price-list-in-use",
  DUPLICATE_PRICE_LIST_ROW: "duplicate-price-list-row",
  DUPLICATE_CUSTOMER_ARTICLE_NUMBER: "duplicate-customer-article-number",
  CUSTOMER_ARTICLE_NUMBER_NOT_FOUND: "customer-article-number-not-found",
  SETUP_CHARGE_ARTICLE_NOT_FOUND: "setup-charge-article-not-found",
  INVALID_OCR: "invalid-ocr",
  COLLECTIVE_INVOICING_CUSTOMER: "collective-invoicing-customer",
  INVALID_SHIPMENT_INVOICE_ROW: "invalid-shipment-invoice-row",
  SHIPMENT_ALREADY_INVOICED: "shipment-already-invoiced",
  FREIGHT_ALREADY_INVOICED: "freight-already-invoiced",
  // E-faktura (Peppol via B2Brouter)
  EINVOICE_NOT_CONFIGURED: "einvoice-not-configured",
  EINVOICE_NOT_ALLOWED: "einvoice-not-allowed",
  EINVOICE_ALREADY_SENT: "einvoice-already-sent",
  EINVOICE_DOCUMENT_INVALID: "einvoice-document-invalid",
  EINVOICE_PROVIDER_REJECTED: "einvoice-provider-rejected",
  EINVOICE_PROVIDER_UNAUTHORIZED: "einvoice-provider-unauthorized",
  EINVOICE_PROVIDER_UNAVAILABLE: "einvoice-provider-unavailable",
  EINVOICE_TRANSMISSION_NOT_FOUND: "einvoice-transmission-not-found",
  SHIPMENT_ON_DRAFT_INVOICE: "shipment-on-draft-invoice",
  // register (grunddata)
  REGISTER_ENTRY_IN_USE: "register-entry-in-use",
  INVALID_REPLACEMENT: "invalid-replacement",
  PAYMENT_EXCEEDS_OPEN_AMOUNT: "payment-exceeds-open-amount",
  VERIFICATION_ALREADY_REVERSED: "verification-already-reversed",
  SUPPLIER_PAYMENT_ALREADY_CANCELLED: "supplier-payment-already-cancelled",
  // article / manufacturing
  DUPLICATE_BOM_COMPONENT: "duplicate-bom-component",
  OPERATION_HAS_LINKED_MATERIAL: "operation-has-linked-material",
  COSTING_ONLY_OPERATION_LINK: "costing-only-operation-link",
  // lego (Etapp G)
  NOT_SUBCONTRACT_OPERATION: "not-subcontract-operation",
  WORK_CENTER_SUPPLIER_NOT_FOUND: "work-center-supplier-not-found",
  OPERATION_FILE_NOT_FOUND: "operation-file-not-found",
  INVALID_OPERATION_FILE_TYPE: "invalid-operation-file-type",
  MO_OPERATION_NOT_FOUND: "mo-operation-not-found",
  DUPLICATE_INQUIRY_ROW: "duplicate-inquiry-row",
  // system
  SERIES_EXHAUSTED: "series-exhausted",
  DUPLICATE_NUMBER_SERIES_NAME: "duplicate-number-series-name",
  BUILT_IN_NUMBER_SERIES: "built-in-number-series",
  ORDER_REGISTER_TOO_LARGE: "order-register-too-large",
  QUOTE_FOLLOWUP_TOO_LARGE: "quote-followup-too-large",
  QUOTE_LOSS_REASON_INVALID: "quote-loss-reason-invalid",
  DEMO_DATA_NOT_AVAILABLE: "demo-data-not-available",
  // Egna teman
  UNKNOWN_THEME: "unknown-theme",
  THEME_INVALID: "theme-invalid",
  THEME_NAME_TAKEN: "theme-name-taken",
  THEME_IS_DEFAULT: "theme-is-default",
  THEME_LIMIT: "theme-limit",
  // Tillägg
  PLUGIN_NOT_FOUND: "plugin-not-found",
  PLUGIN_MANIFEST_INVALID: "plugin-manifest-invalid",
  PLUGIN_MANIFEST_UNREACHABLE: "plugin-manifest-unreachable",
  PLUGIN_KEY_TAKEN: "plugin-key-taken",
  PLUGIN_SAME_HOST: "plugin-same-host",
  PLUGIN_INVALID_ADDRESS: "plugin-invalid-address",
  PLUGIN_DELIVERY_NOT_FOUND: "plugin-delivery-not-found",
  PLUGIN_DELIVERY_NOT_RETRYABLE: "plugin-delivery-not-retryable",
  PLUGIN_ACCESS_DENIED: "plugin-access-denied",
  PLUGIN_ROUTE_FORBIDDEN: "plugin-route-forbidden",
  PLUGIN_KEY_WITH_SESSION: "plugin-key-with-session",
  PLUGIN_USER_MANAGED: "plugin-user-managed",
  PERMISSION_GROUP_OWNED_BY_PLUGIN: "permission-group-owned-by-plugin",
  // auth
  INVALID_CREDENTIALS: "invalid-credentials",
  CROSS_SITE_REQUEST: "cross-site-request",
  CLIENT_SCOPE_MISSING: "client-scope-missing",
  CLIENT_CUSTOMER_MISMATCH: "client-customer-mismatch",
  CLIENT_PRICE_NOT_ALLOWED: "client-price-not-allowed",
  API_CLIENT_CUSTOMER_NOT_FOUND: "api-client-customer-not-found",
  LOGIN_THROTTLED: "login-throttled",
  INVALID_SETUP_CODE: "invalid-setup-code",
  REGISTRATION_CLOSED: "registration-closed",
  SELF_DELETE: "self-delete",
  PERMISSION_GROUP_IN_USE: "permission-group-in-use",
  DUPLICATE_PERMISSION_GROUP_CODE: "duplicate-permission-group-code",
  // Endast läsning: every write from a read-only account, and the refused
  // combination read-only + administrator.
  READ_ONLY_ACCOUNT: "read-only-account",
  READ_ONLY_ADMIN: "read-only-admin",
  // bankfiler
  INVALID_SUPPLIER_PAYMENT_DETAILS: "invalid-supplier-payment-details",
  SUPPLIER_INVOICE_RESERVED: "supplier-invoice-reserved",
  SUPPLIER_INVOICE_IN_PAYMENT_BATCH: "supplier-invoice-in-payment-batch",
  BANK_FILE_PARSE: "bank-file-parse",
  UNSUPPORTED_BANK_MESSAGE: "unsupported-bank-message",
  BANK_SETTINGS_INCOMPLETE: "bank-settings-incomplete",
  INVALID_BANK_SETTING: "invalid-bank-setting",
  PAYMENT_BATCH_NOT_FOUND: "payment-batch-not-found",
  PAYMENT_BATCH_ITEM_NOT_FOUND: "payment-batch-item-not-found",
  SUPPLIER_INVOICES_NOT_PAYABLE: "supplier-invoices-not-payable",
  INVALID_PAYMENT_BATCH_ITEM: "invalid-payment-batch-item",
  PAYMENT_BATCH_ITEM_NOT_CONFIRMABLE: "payment-batch-item-not-confirmable",
  INVALID_PAYMENT_DATE: "invalid-payment-date",
  PAYMENT_FILE_INVALID: "payment-file-invalid",
  BANK_FILE_NOT_FOUND: "bank-file-not-found",
  BANK_ENTRY_NOT_FOUND: "bank-entry-not-found",
  BANK_ENTRY_ALREADY_BOOKED: "bank-entry-already-booked",
  BANK_ENTRY_AMOUNT_MISMATCH: "bank-entry-amount-mismatch",
  BANK_ENTRY_DIRECTION: "bank-entry-direction",
  BANK_ENTRY_NOT_MATCHED: "bank-entry-not-matched",
  BANK_ENTRY_AMOUNT_DIFFERS: "bank-entry-amount-differs",
  BANK_RETURN_BEFORE_PAYMENT: "bank-return-before-payment",
  // Valuta steg 2: a returned payment in another currency came back with
  // another SEK amount than it took (409 — cancel and book the difference by hand).
  BANK_RETURN_SEK_DIFFERS: "bank-return-sek-differs",
  // Bankavstämning (etapp 4)
  BANK_ACCOUNT_NOT_FOUND: "bank-account-not-found",
  BANK_ACCOUNT_IDENTIFIER_TAKEN: "bank-account-identifier-taken",
  BANK_ACCOUNT_LEDGER_MISSING: "bank-account-ledger-missing",
  BANK_ACCOUNT_REQUIRED: "bank-account-required",
  BANK_STATEMENT_FORMAT: "bank-statement-format",
  BANK_STATEMENT_CSV_MAPPING: "bank-statement-csv-mapping",
  BANK_STATEMENT_ACCOUNT_UNKNOWN: "bank-statement-account-unknown",
  BANK_STATEMENT_ACCOUNT_MISMATCH: "bank-statement-account-mismatch",
  BANK_STATEMENT_CURRENCY: "bank-statement-currency",
  BANK_STATEMENT_ENTRY_NOT_FOUND: "bank-statement-entry-not-found",
  BANK_MATCH_NOT_FOUND: "bank-match-not-found",
  BANK_MATCH_SUM_MISMATCH: "bank-match-sum-mismatch",
  BANK_MATCH_ALREADY_MATCHED: "bank-match-already-matched",
  BANK_MATCH_WRONG_ACCOUNT: "bank-match-wrong-account",
  BANK_MATCH_ALREADY_UNDONE: "bank-match-already-undone",
  BANK_ENTRY_BOOK_MISMATCH: "bank-entry-book-mismatch",
  BANK_RULE_NOT_FOUND: "bank-rule-not-found",
  BANK_RULE_MISSING: "bank-rule-missing",
  BANK_RULE_AMBIGUOUS: "bank-rule-ambiguous",
  BANK_RULE_ACCOUNT_MISSING: "bank-rule-account-missing",
  BANK_RECONCILIATION_INCOMPLETE: "bank-reconciliation-incomplete",
  // Startpunkt: the typed statement balance ≠ the ledger balance per the day
  // (409, body.statementBalance/ledgerBalance), or an opening is not allowed
  // now (409, body.reason "mark-exists" | "later-mark").
  BANK_OPENING_BALANCE_MISMATCH: "bank-opening-balance-mismatch",
  BANK_OPENING_NOT_ALLOWED: "bank-opening-not-allowed",
  // PATCH /bank-accounts/:id: ledgerAccount/currency are locked once the
  // account has entries or matchings (409, body.field).
  BANK_ACCOUNT_IN_USE: "bank-account-in-use",
  // Import: the chosen account already has entries under another identifier,
  // so the file's identifier cannot be learned onto it (409).
  BANK_ACCOUNT_IDENTIFIER_LOCKED: "bank-account-identifier-locked",
  // configurator
  CONFIGURATOR_TEMPLATE_NOT_FOUND: "configurator-template-not-found",
  CONFIGURATOR_TEMPLATE_EXISTS: "configurator-template-exists",
  CONFIGURATOR_GROUP_NOT_FOUND: "configurator-group-not-found",
  CONFIGURATOR_VALUE_NOT_FOUND: "configurator-value-not-found",
  CONFIGURATOR_RULE_NOT_FOUND: "configurator-rule-not-found",
  CONFIGURATOR_CODE_TAKEN: "configurator-code-taken",
  CONFIGURATOR_REFERENCE_IN_USE: "configurator-reference-in-use",
  INVALID_CONFIGURATOR_RULE: "invalid-configurator-rule",
  INVALID_CONFIGURATOR_GROUP: "invalid-configurator-group",
  CONFIGURATOR_MODE_NOT_ALLOWED: "configurator-mode-not-allowed",
  INVALID_CONFIGURATOR_FORMULA: "invalid-configurator-formula",
  INVALID_CONFIGURATOR_LINE: "invalid-configurator-line",
  INVALID_CONFIGURATOR_OPERATION: "invalid-configurator-operation",
  CONFIGURATOR_SEQUENCE_TAKEN: "configurator-sequence-taken",
  CONFIGURATOR_LINE_NOT_FOUND: "configurator-line-not-found",
  CONFIGURATOR_OPERATION_NOT_FOUND: "configurator-operation-not-found",
  CONFIGURATOR_TOO_MANY_COMBINATIONS: "configurator-too-many-combinations",
  INVALID_CONFIGURATOR_VARIANT_SET: "invalid-configurator-variant-set",
  CONFIGURATOR_NOT_VARIANT_MODE: "configurator-not-variant-mode",
  CONFIGURATOR_TEMPLATE_HAS_VARIANTS: "configurator-template-has-variants",
  CONFIGURATOR_VARIANT_NOT_TEMPLATE: "configurator-variant-not-template",
  CONFIGURATOR_CODE_LOCKED: "configurator-code-locked",
  CONFIGURATOR_VARIANT_NUMBER_RACE: "configurator-variant-number-race",
  CONFIGURATOR_VARIANT_NOT_FOUND: "configurator-variant-not-found",
  CONFIGURATOR_INVALID_CONFIGURATION: "configurator-invalid-configuration",
  CONFIGURATOR_VARIANT_NUMBER_TAKEN: "configurator-variant-number-taken",
  CONFIGURATOR_VARIANT_TOO_LONG: "configurator-variant-too-long",
  // Externt API (konfigurator 5): the engine accepts the selection but the variant's structure cannot be derived.
  CONFIGURATOR_VARIANT_NOT_DERIVABLE: "configurator-variant-not-derivable",
  // Beställningsvara på orderraden (konfigurator 4b).
  CONFIGURATOR_NOT_TO_ORDER_MODE: "configurator-not-to-order-mode",
  // Externt API (konfigurator 5): a client used a template without Visa i API.
  CONFIGURATOR_NOT_PUBLISHED: "configurator-not-published",
  CONFIGURATION_REQUIRED: "configuration-required",
  CONFIGURATION_NOT_ALLOWED: "configuration-not-allowed",
  // Leveranstidskontroll on an order that is no longer open.
  SALES_ORDER_NOT_OPEN: "sales-order-not-open",
  ROW_CONFIGURATION_LOCKED: "row-configuration-locked",
  // Konfigurator 4c: the row was reconfigured while its TO was being created.
  ROW_CONFIGURATION_CHANGED: "row-configuration-changed",
  // A quantity change on a beställningsvara row whose stored choices the
  // template now resolves differently (a förval added since).
  ROW_CONFIGURATION_OUTDATED: "row-configuration-outdated",
  ROW_VARIANT_EXISTS: "row-variant-exists",
  WORK_CENTER_NOT_FOUND: "work-center-not-found",
  // Ångra rapportering / Makulera order (TO)
  MO_REPORT_NOT_FOUND: "mo-report-not-found",
  MO_REPORT_ALREADY_UNDONE: "mo-report-already-undone",
  MO_REPORT_FROM_PURCHASE_RECEIPT: "mo-report-from-purchase-receipt",
  MO_REPORT_STOCK_MISSING: "mo-report-stock-missing",
  // Materialbrist vid rapportering (system setting manufacturing_material_shortage)
  MATERIAL_SHORTAGE: "material-shortage",
  MO_REPORT_TIME_LOCKED: "mo-report-time-locked",
  // Pallkort per rapport: only a live operation report has a card
  REPORT_HAS_NO_PALLET_CARD: "report-has-no-pallet-card",
  MANUFACTURING_ORDER_HAS_REPORTS: "manufacturing-order-has-reports",
  MANUFACTURING_ORDER_STAMPED_IN: "manufacturing-order-stamped-in",
  // Ändra material och operationer på en skapad TO
  MANUFACTURING_ORDER_NOT_EDITABLE: "manufacturing-order-not-editable",
  MO_MATERIAL_CONSUMED: "mo-material-consumed",
  MO_MATERIAL_DUPLICATE: "mo-material-duplicate",
  MO_MATERIAL_OWN_ARTICLE: "mo-material-own-article",
  MO_MATERIAL_PHANTOM: "mo-material-phantom",
  MO_OPERATION_NOT_ON_ORDER: "mo-operation-not-on-order",
  MO_OPERATION_SEQUENCE_TAKEN: "mo-operation-sequence-taken",
  MO_OPERATION_DONE: "mo-operation-done",
  MO_OPERATION_STAMPED: "mo-operation-stamped",
  MO_OPERATION_LINKED_PURCHASE: "mo-operation-linked-purchase",
  MO_OPERATION_REPORTED: "mo-operation-reported",
  LAST_OPERATION_LOCKED: "last-operation-locked",
  // Produktionsplanering: Flytta / Lås upp on an operation
  OPERATION_NOT_FOUND: "operation-not-found",
  OPERATION_NOT_PLANNABLE: "operation-not-plannable",
  PLAN_WEEK_IN_PAST: "plan-week-in-past",
  // Reservationen (POST /delivery-time-check/apply): the check gave another
  // date under the lock / no manufactured shortage to make a TO for.
  DELIVERY_TIME_CHANGED: "delivery-time-changed",
  NOTHING_TO_RESERVE: "nothing-to-reserve",
  // Dröjsmålsränta och förseningsersättning (bokföringsgranskningen etapp 5 C)
  // Räntefakturering while Debitera dröjsmålsränta is off (409)
  LATE_INTEREST_DISABLED: "late-interest-disabled",
  // Skapa räntefakturor: the period/fee the client sent no longer matches
  // (charged meanwhile, or no longer a candidate) — 409, body.invoiceIds
  LATE_INTEREST_ALREADY_CHARGED: "late-interest-already-charged",
  // Räntefakturering with T.o.m. datum after today (400, body.today)
  LATE_INTEREST_FUTURE_DATE: "late-interest-future-date",
  // Påminnelseavgift on an invoice with an active förseningsersättning (409)
  REMINDER_FEE_AFTER_LATE_FEE: "reminder-fee-after-late-fee",
  // DELETE /reference-rates/:id on a Riksbanken row (409)
  REFERENCE_RATE_RIKSBANK: "reference-rate-riksbank",
  // Fakturaskanning: the same file is already in the Fakturainkorg (409,
  // body.existing { id, scanNumber, status }) — uppladdningen reports it in
  // duplicates[] instead, Återställ answers with this
  INVOICE_SCAN_DUPLICATE: "invoice-scan-duplicate",
  // Tolka med AI without a configured AI interpretation (409)
  INVOICE_SCAN_AI_NOT_CONFIGURED: "invoice-scan-ai-not-configured",
  // Tolka med AI while another AI call on the same scan runs (409)
  INVOICE_SCAN_BUSY: "invoice-scan-busy",
  // Testa anslutning (AI) failed — body.message/error is the Swedish reason (409)
  INVOICE_SCAN_AI_TEST_FAILED: "invoice-scan-ai-test-failed",
  // Testa anslutning (e-postlådan) failed — body.message/error is the Swedish reason (409)
  INVOICE_SCAN_MAIL_TEST_FAILED: "invoice-scan-mail-test-failed",
  // Server or användare changed without the password typed again — the
  // saved password never goes to another server/account (400, Swedish message)
  INVOICE_SCAN_MAIL_PASSWORD_REQUIRED: "invoice-scan-mail-password-required",
  // Mapp för inlästa is the folder that is read (400, Swedish message)
  INVOICE_SCAN_MAIL_FOLDERS_EQUAL: "invoice-scan-mail-folders-equal",
  // DELETE of the underlag the Fakturainkorg created the invoice from (409)
  SUPPLIER_INVOICE_FILE_FROM_SCAN: "supplier-invoice-file-from-scan",

  // Reklamationer och avvikelser (Kvalitet)
  DEVIATION_NOT_FOUND: "deviation-not-found",
  // 400 with `field` and a Swedish message naming the problem
  DEVIATION_LINK_MISMATCH: "deviation-link-mismatch",
  // 409, Swedish message: closed/cancelled case, wrong type, other counterparty
  DEVIATION_LINK_NOT_ALLOWED: "deviation-link-not-allowed",
  DEVIATION_REASON_NOT_APPLICABLE: "deviation-reason-not-applicable",
  // 409 with `missing`: ["correctiveAction" | "decision"]
  DEVIATION_CLOSE_REQUIREMENTS: "deviation-close-requirements",
  DEVIATION_NOT_EDITABLE: "deviation-not-editable",
  DEVIATION_COST_NOT_FOUND: "deviation-cost-not-found",
  DEVIATION_LINK_NOT_FOUND: "deviation-link-not-found",
  DEVIATION_FILE_NOT_FOUND: "deviation-file-not-found",
  INVALID_DEVIATION_FILE_TYPE: "invalid-deviation-file-type",
  // 400: the upload is over 20 MB
  DEVIATION_FILE_TOO_LARGE: "deviation-file-too-large",
  // Kassation with the Avvikelseorsaker register (400)
  SCRAP_REASON_REQUIRED: "scrap-reason-required",
  SCRAP_REASON_INVALID: "scrap-reason-invalid",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
