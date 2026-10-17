import {
  DeliveryTimeChangedError,
  NothingToReserveError,
  OperationNotFoundError,
  OperationNotPlannableError,
  SalesOrderNotOpenError,
} from "../src/modules/planning/service/planning.service.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@navet/shared";
import { errorBody } from "../src/modules/system/service/error-body.js";
import {
  ConfiguratorCodeLockedError,
  ConfiguratorCodeTakenError,
  ConfiguratorInvalidConfigurationError,
  ConfiguratorNotPublishedError,
  ConfiguratorNotToOrderModeError,
  ConfiguratorNotVariantModeError,
  ConfiguratorTemplateHasVariantsError,
  ConfiguratorTooManyCombinationsError,
  ConfiguratorVariantNotFoundError,
  ConfiguratorVariantNotTemplateError,
  ConfiguratorVariantNumberRaceError,
  ConfiguratorVariantNumberTakenError,
  ConfiguratorVariantTooLongError,
  ConfiguratorVariantNotDerivableError,
  InvalidConfiguratorVariantSetError,
  ConfiguratorGroupNotFoundError,
  ConfiguratorLineNotFoundError,
  ConfiguratorModeNotAllowedError,
  ConfiguratorOperationNotFoundError,
  ConfiguratorReferenceInUseError,
  ConfiguratorRuleNotFoundError,
  ConfiguratorSequenceTakenError,
  ConfiguratorTemplateExistsError,
  ConfiguratorTemplateNotFoundError,
  ConfiguratorValueNotFoundError,
  InvalidConfiguratorFormulaError,
  InvalidConfiguratorGroupError,
  InvalidConfiguratorLineError,
  InvalidConfiguratorOperationError,
  InvalidConfiguratorRuleError,
} from "../src/modules/configurator/service/configurator.errors.js";

import {
  AlreadyAttestedError,
  AttestationNotFoundError,
  DuplicateAbsenceError,
  DuplicatePayrollCodeError,
  InvalidObWindowError,
  PeriodNotEndedError,
  PeriodNotLockedError,
  UnattestedEmployeesError,
  UnfinishedAttendanceError,
} from "../src/modules/payroll/service/payroll.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";
import {
  AlreadyPresentError,
  AttendanceOpenFromEarlierDayError,
  InvalidAttendanceIntervalError,
  InvalidStopTimeError,
  StampSessionAlreadyStoppedError,
  StopTimeNotAllowedError,
} from "../src/modules/timereport/service/timereport.service.js";

import {
  AccountNotFoundError,
  AlreadyReversedError,
  DuplicateAccountNumberError,
  DuplicatePostingRuleError,
  InactiveAccountError,
  InvalidVerificationStateError,
  NoAccountingPeriodError,
  FiscalYearBeforeClosedYearError,
  NoFiscalYearForDateError,
  OverlappingFiscalYearError,
  PostingRuleNoAccountsError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationSeriesNotFoundError,
  YearEndClosingVerificationError,
} from "../src/modules/economy/service/economy.service.js";
import {
  ClosingDateLockedError,
  InvalidClosingDateError,
  InventoryAccountConflictError,
  InvalidAccrualAccountError,
  NextFiscalYearClosedError,
  NextFiscalYearMissingError,
  InvalidAgmDateError,
  NothingToDisposeError,
  ProfitDispositionActiveError,
  ProfitDispositionExistsError,
  ProfitDispositionNotFoundError,
  YearEndBlockedError,
  YearEndClosingClosedError,
  YearEndClosingExistsError,
  YearEndClosingNotClosedError,
  YearEndClosingNotFoundError,
  YearEndStepOrderError,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { AccountingPeriodLockedError, FiscalYearClosedError } from "../src/modules/economy/service/accounting-period-lock.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  ZeroAmountPostingError,
} from "../src/modules/economy/service/verification-poster.js";
import {
  VatAccountsNotDistinctError,
  VatPeriodAlreadySettledError,
  VatPeriodNotCoveredError,
} from "../src/modules/economy/service/vat-report.service.js";

import { OverDeliveryError, SalesOrderRowNotFoundError } from "../src/modules/sales/service/sales.service.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  DuplicatePriceListRowError,
  FreightAlreadyInvoicedError,
  PriceListInUseError,
  RowConfigurationLockedError,
  RowConfigurationChangedError,
  RowVariantExistsError,
} from "../src/modules/sales/service/sales.errors.js";
import { ShipmentOnDraftInvoiceError } from "../src/modules/shipping/service/shipping.errors.js";
import { InvalidOcrError, PaymentExceedsOpenAmountError, VerificationAlreadyReversedError } from "../src/modules/sales/service/payment.service.js";
import {
  CollectiveInvoicingCustomerError,
  InvalidShipmentInvoiceRowError,
  ShipmentAlreadyInvoicedError,
} from "../src/modules/sales/service/invoice.service.js";
import { InvalidReplacementError, RegisterEntryInUseError } from "../src/modules/register/service/register.errors.js";

import {
  BankEntryAlreadyBookedError,
  BankEntryAmountDiffersError,
  BankEntryAmountMismatchError,
  BankEntryDirectionError,
  BankEntryNotFoundError,
  BankEntryNotMatchedError,
  BankFileNotFoundError,
  BankFileParseError,
  BankReturnBeforePaymentError,
  BankSettingsIncompleteError,
  InvalidBankSettingError,
  InvalidPaymentBatchItemError,
  InvalidPaymentDateError,
  PaymentBatchItemNotConfirmableError,
  PaymentBatchItemNotFoundError,
  PaymentBatchNotFoundError,
  PaymentFileInvalidError,
  SupplierInvoicesNotPayableError,
  UnsupportedBankMessageError,
} from "../src/modules/banking/service/banking.errors.js";
import {
  InvalidSupplierPaymentDetailsError,
  OverReceiptError,
  PurchaseReceiptAlreadyUndoneError,
  PurchaseReceiptManufacturingOrderLockedError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptStockMissingError,
  RowHasReceiptsError,
} from "../src/modules/purchase/service/purchase.service.js";
import {
  SupplierInvoiceReservedError,
  SupplierPaymentAlreadyCancelledError,
} from "../src/modules/purchase/service/supplier-payment.service.js";
import { SupplierInvoiceInPaymentBatchError } from "../src/modules/purchase/service/supplier-invoice.service.js";

import { SeriesExhaustedError } from "../src/modules/system/service/number-series.js";
import {
  InvalidOperationFileTypeError,
  NotSubcontractOperationError,
  OperationFileNotFoundError,
  OperationHasLinkedMaterialError,
  WorkCenterNotFoundError,
  WorkCenterSupplierNotFoundError,
  ManufacturingOrderHasReportsError,
  ManufacturingOrderStampedInError,
  MoReportAlreadyUndoneError,
  MoReportFromPurchaseReceiptError,
  MoReportNotFoundError,
  MoReportStockMissingError,
  MoReportTimeLockedError,
  MaterialShortageError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { DuplicateInquiryRowError, MoOperationNotFoundError } from "../src/modules/purchase/service/purchase.service.js";
import {
  BaseUnitLockedError,
  CostingOnlyOperationLinkError,
  DuplicateBomComponentError,
  InvalidReferenceError,
  InvalidUnitError,
  ArticleNotFoundError,
  ArticleCopyPartNotAllowedError,
  ArticleIsTemplateError,
} from "../src/modules/article/service/article.service.js";
import {
  InvalidCredentialsError,
  InvalidSetupCodeError,
  RegistrationClosedError,
  SelfDeleteError,
} from "../src/modules/auth/service/auth.service.js";
import { LoginThrottledError } from "../src/modules/auth/service/login-throttle.js";
import { ClientCustomerMismatchError, ClientPriceNotAllowedError, ClientScopeMissingError } from "../src/modules/auth/middleware/permission.middleware.js";
import { ApiClientCustomerNotFoundError } from "../src/modules/oauth/service/oauth.service.js";
import { DemoDataNotAvailableError } from "../src/modules/demo/service/demo-data.service.js";
import {
  DuplicatePermissionGroupCodeError,
  PermissionGroupInUseError,
} from "../src/modules/auth/service/permission-group.service.js";

// Table-driven stability test — pins the codeFromName() derivation for every
// error class the web's Swedish message dictionary maps by code
// (apps/web/lib/errorMessages.ts). If a class is ever renamed, this test
// fails loudly instead of the web silently falling back to the raw English
// message. See error-body.ts's header comment.
import {
  DepreciationMonthInFutureError,
  DepreciationRunNotFoundError,
  DepreciationRunNotLatestError,
  DisposalRunNotUndoableError,
  RunPrecedesDisposalError,
  DuplicateFixedAssetCategoryNameError,
  FixedAssetBasAccountMissingError,
  FixedAssetCategoryAccountsLockedError,
  FixedAssetCategoryAccountsNotDistinctError,
  FixedAssetCategoryInUseError,
  FixedAssetCategoryNotFoundError,
  FixedAssetFieldLockedError,
  FixedAssetHasDepreciationError,
  FixedAssetLifeTooShortError,
  FixedAssetNotActiveError,
  FixedAssetNotFoundError,
  FixedAssetPlanYearNotFoundError,
  InvalidDisposalDateError,
  InvalidFixedAssetValuesError,
  InvalidOpeningDepreciationError,
  NothingToDepreciateError,
  SupplierInvoiceNotFoundError,
} from "../src/modules/economy/service/fixed-asset.service.js";
import { FixedAssetVerificationError } from "../src/modules/economy/service/economy.service.js";

const cases: Array<[Error, string]> = [
  // payroll / timereport
  [new UnfinishedAttendanceError("emp-1"), ERROR_CODES.UNFINISHED_ATTENDANCE],
  [new AlreadyAttestedError(), ERROR_CODES.ALREADY_ATTESTED],
  [new AttestationNotFoundError("emp-1"), ERROR_CODES.ATTESTATION_NOT_FOUND],
  [new PayrollPeriodLockedError("2026-01-15"), ERROR_CODES.PAYROLL_PERIOD_LOCKED],
  [new PeriodNotEndedError(2026, 1), ERROR_CODES.PERIOD_NOT_ENDED],
  [new UnattestedEmployeesError(["Ada"]), ERROR_CODES.UNATTESTED_EMPLOYEES],
  [new PeriodNotLockedError(2026, 1), ERROR_CODES.PERIOD_NOT_LOCKED],
  [new InvalidAttendanceIntervalError(), ERROR_CODES.INVALID_ATTENDANCE_INTERVAL],
  [new AlreadyPresentError(), ERROR_CODES.ALREADY_PRESENT],
  [new AttendanceOpenFromEarlierDayError("x", new Date()), ERROR_CODES.ATTENDANCE_OPEN_FROM_EARLIER_DAY],
  [new InvalidStopTimeError(), ERROR_CODES.INVALID_STOP_TIME],
  [new StampSessionAlreadyStoppedError(), ERROR_CODES.STAMP_SESSION_ALREADY_STOPPED],
  [new StopTimeNotAllowedError(), ERROR_CODES.STOP_TIME_NOT_ALLOWED],
  [new DuplicateAbsenceError(), ERROR_CODES.DUPLICATE_ABSENCE],
  [new DuplicatePayrollCodeError("code", "X"), ERROR_CODES.DUPLICATE_PAYROLL_CODE],
  [new InvalidObWindowError("bad window"), ERROR_CODES.INVALID_OB_WINDOW],
  // economy
  [new OverlappingFiscalYearError("2026"), ERROR_CODES.OVERLAPPING_FISCAL_YEAR],
  [new FiscalYearBeforeClosedYearError("2025", "2026"), ERROR_CODES.FISCAL_YEAR_BEFORE_CLOSED_YEAR],
  [new VatPeriodNotCoveredError("2026-01-01", "2026-01-31"), ERROR_CODES.VAT_PERIOD_NOT_COVERED],
  [new VatPeriodAlreadySettledError("M-2026-1"), ERROR_CODES.VAT_PERIOD_ALREADY_SETTLED],
  [new VatAccountsNotDistinctError("2610"), ERROR_CODES.VAT_ACCOUNTS_NOT_DISTINCT],
  [new AccountingPeriodLockedError("2026-01-15"), ERROR_CODES.ACCOUNTING_PERIOD_LOCKED],
  [new ZeroAmountPostingError(), ERROR_CODES.ZERO_AMOUNT_POSTING],
  [new NoAccountingPeriodError("2026-01-15"), ERROR_CODES.NO_ACCOUNTING_PERIOD],
  [new NoAccountingPeriodForPostingError("2026-01-15"), ERROR_CODES.NO_ACCOUNTING_PERIOD_FOR_POSTING],
  [new MissingPostingAccountError("2610", "outgoing VAT 25 %"), ERROR_CODES.MISSING_POSTING_ACCOUNT],
  [new AccountNotFoundError("acc-1"), ERROR_CODES.ACCOUNT_NOT_FOUND],
  [new DuplicateAccountNumberError("2610"), ERROR_CODES.DUPLICATE_ACCOUNT_NUMBER],
  [new NoFiscalYearForDateError("2026-01-15"), ERROR_CODES.NO_FISCAL_YEAR_FOR_DATE],
  [new VerificationSeriesNotFoundError("ser-1"), ERROR_CODES.VERIFICATION_SERIES_NOT_FOUND],
  [new UnbalancedVerificationError(100, 90), ERROR_CODES.UNBALANCED_VERIFICATION],
  [new TooFewVerificationRowsError("ver-1"), ERROR_CODES.TOO_FEW_VERIFICATION_ROWS],
  [new InactiveAccountError("acc-1"), ERROR_CODES.INACTIVE_ACCOUNT],
  [new AlreadyReversedError("ver-1"), ERROR_CODES.ALREADY_REVERSED],
  [new InvalidVerificationStateError("bad state"), ERROR_CODES.INVALID_VERIFICATION_STATE],
  [new DuplicatePostingRuleError("grp-1", 25), ERROR_CODES.DUPLICATE_POSTING_RULE],
  [new PostingRuleNoAccountsError("rule-1"), ERROR_CODES.POSTING_RULE_NO_ACCOUNTS],
  [new FiscalYearClosedError("2024"), ERROR_CODES.FISCAL_YEAR_CLOSED],
  [new YearEndClosingNotFoundError("c-1"), ERROR_CODES.YEAR_END_CLOSING_NOT_FOUND],
  [new YearEndClosingExistsError("2024"), ERROR_CODES.YEAR_END_CLOSING_EXISTS],
  [new InvalidClosingDateError("2024-11-30", "2024-12-01", "2024-12-31"), ERROR_CODES.INVALID_CLOSING_DATE],
  [new ClosingDateLockedError(), ERROR_CODES.CLOSING_DATE_LOCKED],
  [new YearEndClosingClosedError("2024"), ERROR_CODES.YEAR_END_CLOSING_CLOSED],
  [new YearEndClosingVerificationError("v-1"), ERROR_CODES.YEAR_END_CLOSING_VERIFICATION],
  [new YearEndBlockedError(["x"]), ERROR_CODES.YEAR_END_BLOCKED],
  [new InventoryAccountConflictError("1460"), ERROR_CODES.INVENTORY_ACCOUNT_CONFLICT],
  [new InvalidAccrualAccountError("1930", "prepaid_expense"), ERROR_CODES.INVALID_ACCRUAL_ACCOUNT],
  [new NextFiscalYearMissingError("2024"), ERROR_CODES.NEXT_FISCAL_YEAR_MISSING],
  [new YearEndStepOrderError("Lagerförändring"), ERROR_CODES.YEAR_END_STEP_ORDER],
  [new YearEndClosingNotClosedError("2024"), ERROR_CODES.YEAR_END_CLOSING_NOT_CLOSED],
  [new NextFiscalYearClosedError("2025"), ERROR_CODES.NEXT_FISCAL_YEAR_CLOSED],
  [new ProfitDispositionActiveError("2024"), ERROR_CODES.PROFIT_DISPOSITION_ACTIVE],
  [new InvalidAgmDateError("2024-12-31", "2024-12-31"), ERROR_CODES.INVALID_AGM_DATE],
  [new ProfitDispositionExistsError("2024"), ERROR_CODES.PROFIT_DISPOSITION_EXISTS],
  [new NothingToDisposeError("2024"), ERROR_CODES.NOTHING_TO_DISPOSE],
  [new ProfitDispositionNotFoundError("2024"), ERROR_CODES.PROFIT_DISPOSITION_NOT_FOUND],
  // anläggningsregister
  [new FixedAssetNotFoundError("a-1"), ERROR_CODES.FIXED_ASSET_NOT_FOUND],
  [new FixedAssetCategoryNotFoundError("cat-1"), ERROR_CODES.FIXED_ASSET_CATEGORY_NOT_FOUND],
  [new SupplierInvoiceNotFoundError("lf-1"), ERROR_CODES.SUPPLIER_INVOICE_NOT_FOUND],
  [new DepreciationRunNotFoundError("run-1"), ERROR_CODES.DEPRECIATION_RUN_NOT_FOUND],
  [new DuplicateFixedAssetCategoryNameError("X"), ERROR_CODES.DUPLICATE_FIXED_ASSET_CATEGORY_NAME],
  [new FixedAssetCategoryInUseError("cat-1"), ERROR_CODES.FIXED_ASSET_CATEGORY_IN_USE],
  [new FixedAssetCategoryAccountsNotDistinctError(), ERROR_CODES.FIXED_ASSET_CATEGORY_ACCOUNTS_NOT_DISTINCT],
  [new FixedAssetCategoryAccountsLockedError("assetAccountId"), ERROR_CODES.FIXED_ASSET_CATEGORY_ACCOUNTS_LOCKED],
  [new FixedAssetBasAccountMissingError("1240"), ERROR_CODES.FIXED_ASSET_BAS_ACCOUNT_MISSING],
  [new FixedAssetFieldLockedError("acquisitionCost"), ERROR_CODES.FIXED_ASSET_FIELD_LOCKED],
  [new FixedAssetNotActiveError("AN-1"), ERROR_CODES.FIXED_ASSET_NOT_ACTIVE],
  [new FixedAssetHasDepreciationError("AN-1"), ERROR_CODES.FIXED_ASSET_HAS_DEPRECIATION],
  [new FixedAssetLifeTooShortError("2026-05"), ERROR_CODES.FIXED_ASSET_LIFE_TOO_SHORT],
  [new InvalidFixedAssetValuesError("bad"), ERROR_CODES.INVALID_FIXED_ASSET_VALUES],
  [new InvalidOpeningDepreciationError("bad"), ERROR_CODES.INVALID_OPENING_DEPRECIATION],
  [new DepreciationMonthInFutureError("2099-01"), ERROR_CODES.DEPRECIATION_MONTH_IN_FUTURE],
  [new NothingToDepreciateError("2026-06"), ERROR_CODES.NOTHING_TO_DEPRECIATE],
  [new DepreciationRunNotLatestError("run-1"), ERROR_CODES.DEPRECIATION_RUN_NOT_LATEST],
  [new DisposalRunNotUndoableError("run-1"), ERROR_CODES.DISPOSAL_RUN_NOT_UNDOABLE],
  [new RunPrecedesDisposalError("run-1"), ERROR_CODES.RUN_PRECEDES_DISPOSAL],
  [new InvalidDisposalDateError("bad"), ERROR_CODES.INVALID_DISPOSAL_DATE],
  [new FixedAssetVerificationError("ver-1"), ERROR_CODES.FIXED_ASSET_VERIFICATION],
  [new FixedAssetPlanYearNotFoundError("fy"), ERROR_CODES.FIXED_ASSET_PLAN_YEAR_NOT_FOUND],
  // sales / purchase
  [new SalesOrderRowNotFoundError("row-1"), ERROR_CODES.SALES_ORDER_ROW_NOT_FOUND],
  [new OverDeliveryError(), ERROR_CODES.OVER_DELIVERY],
  [new RowHasReceiptsError(), ERROR_CODES.ROW_HAS_RECEIPTS],
  [new OverReceiptError(), ERROR_CODES.OVER_RECEIPT],
  [new PurchaseReceiptNotFoundError("x"), ERROR_CODES.PURCHASE_RECEIPT_NOT_FOUND],
  [new PurchaseReceiptAlreadyUndoneError(), ERROR_CODES.PURCHASE_RECEIPT_ALREADY_UNDONE],
  [new PurchaseReceiptStockMissingError(1, 5), ERROR_CODES.PURCHASE_RECEIPT_STOCK_MISSING],
  [new PurchaseReceiptManufacturingOrderLockedError(), ERROR_CODES.PURCHASE_RECEIPT_MANUFACTURING_ORDER_LOCKED],
  [new PriceListInUseError("PL1"), ERROR_CODES.PRICE_LIST_IN_USE],
  [new DuplicatePriceListRowError(10), ERROR_CODES.DUPLICATE_PRICE_LIST_ROW],
  [new InvalidOcrError("123"), ERROR_CODES.INVALID_OCR],
  [new PaymentExceedsOpenAmountError("F-1", 100, 150), ERROR_CODES.PAYMENT_EXCEEDS_OPEN_AMOUNT],
  [new VerificationAlreadyReversedError(), ERROR_CODES.VERIFICATION_ALREADY_REVERSED],
  [new SupplierPaymentAlreadyCancelledError("pay-1"), ERROR_CODES.SUPPLIER_PAYMENT_ALREADY_CANCELLED],
  [new CollectiveInvoicingCustomerError("x"), ERROR_CODES.COLLECTIVE_INVOICING_CUSTOMER],
  [new InvalidShipmentInvoiceRowError("x"), ERROR_CODES.INVALID_SHIPMENT_INVOICE_ROW],
  [new ShipmentAlreadyInvoicedError("FR-1"), ERROR_CODES.SHIPMENT_ALREADY_INVOICED],
  [new FreightAlreadyInvoicedError("FR-1"), ERROR_CODES.FREIGHT_ALREADY_INVOICED],
  [new ShipmentOnDraftInvoiceError(), ERROR_CODES.SHIPMENT_ON_DRAFT_INVOICE],
  // register (grunddata)
  [new RegisterEntryInUseError("30", { total: 1, references: [] }), ERROR_CODES.REGISTER_ENTRY_IN_USE],
  [new InvalidReplacementError("same"), ERROR_CODES.INVALID_REPLACEMENT],
  // system
  [new OperationHasLinkedMaterialError(), ERROR_CODES.OPERATION_HAS_LINKED_MATERIAL],
  [new NotSubcontractOperationError(), ERROR_CODES.NOT_SUBCONTRACT_OPERATION],
  [new WorkCenterSupplierNotFoundError("x"), ERROR_CODES.WORK_CENTER_SUPPLIER_NOT_FOUND],
  [new OperationFileNotFoundError("x"), ERROR_CODES.OPERATION_FILE_NOT_FOUND],
  [new InvalidOperationFileTypeError("text/plain"), ERROR_CODES.INVALID_OPERATION_FILE_TYPE],
  [new MoOperationNotFoundError("x"), ERROR_CODES.MO_OPERATION_NOT_FOUND],
  [new DuplicateInquiryRowError(), ERROR_CODES.DUPLICATE_INQUIRY_ROW],
  [new CostingOnlyOperationLinkError(), ERROR_CODES.COSTING_ONLY_OPERATION_LINK],
  [new DuplicateBomComponentError(), ERROR_CODES.DUPLICATE_BOM_COMPONENT],
  [new SeriesExhaustedError("customer"), ERROR_CODES.SERIES_EXHAUSTED],
  [new DemoDataNotAvailableError(["customers"]), ERROR_CODES.DEMO_DATA_NOT_AVAILABLE],
  // auth
  [new InvalidCredentialsError(), ERROR_CODES.INVALID_CREDENTIALS],
  [new ClientScopeMissingError("prices:read"), ERROR_CODES.CLIENT_SCOPE_MISSING],
  [new ClientCustomerMismatchError(), ERROR_CODES.CLIENT_CUSTOMER_MISMATCH],
  [new ClientPriceNotAllowedError(), ERROR_CODES.CLIENT_PRICE_NOT_ALLOWED],
  [new ApiClientCustomerNotFoundError("x"), ERROR_CODES.API_CLIENT_CUSTOMER_NOT_FOUND],
  [new LoginThrottledError(900), ERROR_CODES.LOGIN_THROTTLED],
  [new InvalidSetupCodeError(), ERROR_CODES.INVALID_SETUP_CODE],
  [new RegistrationClosedError(), ERROR_CODES.REGISTRATION_CLOSED],
  [new SelfDeleteError(), ERROR_CODES.SELF_DELETE],
  [new PermissionGroupInUseError(1), ERROR_CODES.PERMISSION_GROUP_IN_USE],
  [new DuplicatePermissionGroupCodeError("x"), ERROR_CODES.DUPLICATE_PERMISSION_GROUP_CODE],
  // bankfiler
  [new InvalidSupplierPaymentDetailsError({ bankgiro: "Bankgiro saknas" }), ERROR_CODES.INVALID_SUPPLIER_PAYMENT_DETAILS],
  [new SupplierInvoiceReservedError("LF-1"), ERROR_CODES.SUPPLIER_INVOICE_RESERVED],
  [new SupplierInvoiceInPaymentBatchError("BO-1"), ERROR_CODES.SUPPLIER_INVOICE_IN_PAYMENT_BATCH],
  [new BankFileParseError("x"), ERROR_CODES.BANK_FILE_PARSE],
  [new UnsupportedBankMessageError(null), ERROR_CODES.UNSUPPORTED_BANK_MESSAGE],
  [new BankSettingsIncompleteError(["Bank är inte vald"]), ERROR_CODES.BANK_SETTINGS_INCOMPLETE],
  [new InvalidBankSettingError("x"), ERROR_CODES.INVALID_BANK_SETTING],
  [new PaymentBatchNotFoundError("x"), ERROR_CODES.PAYMENT_BATCH_NOT_FOUND],
  [new PaymentBatchItemNotFoundError("x"), ERROR_CODES.PAYMENT_BATCH_ITEM_NOT_FOUND],
  [new SupplierInvoicesNotPayableError([]), ERROR_CODES.SUPPLIER_INVOICES_NOT_PAYABLE],
  [new InvalidPaymentBatchItemError("x"), ERROR_CODES.INVALID_PAYMENT_BATCH_ITEM],
  [new PaymentBatchItemNotConfirmableError("BO-1-1", "rejected"), ERROR_CODES.PAYMENT_BATCH_ITEM_NOT_CONFIRMABLE],
  [new InvalidPaymentDateError("x"), ERROR_CODES.INVALID_PAYMENT_DATE],
  [new PaymentFileInvalidError([]), ERROR_CODES.PAYMENT_FILE_INVALID],
  [new BankFileNotFoundError("x"), ERROR_CODES.BANK_FILE_NOT_FOUND],
  [new BankEntryNotFoundError("x"), ERROR_CODES.BANK_ENTRY_NOT_FOUND],
  [new BankEntryAlreadyBookedError(), ERROR_CODES.BANK_ENTRY_ALREADY_BOOKED],
  [new BankEntryAmountMismatchError(10, 5), ERROR_CODES.BANK_ENTRY_AMOUNT_MISMATCH],
  [new BankEntryDirectionError("x"), ERROR_CODES.BANK_ENTRY_DIRECTION],
  [new BankEntryNotMatchedError(), ERROR_CODES.BANK_ENTRY_NOT_MATCHED],
  [new BankEntryAmountDiffersError("BO-1-1", 10, 9), ERROR_CODES.BANK_ENTRY_AMOUNT_DIFFERS],
  [new BankReturnBeforePaymentError("BO-1-1", "2024-10-15", "2024-10-14"), ERROR_CODES.BANK_RETURN_BEFORE_PAYMENT],
  // configurator
  [new ConfiguratorTemplateNotFoundError(), ERROR_CODES.CONFIGURATOR_TEMPLATE_NOT_FOUND],
  [new ConfiguratorTemplateExistsError(), ERROR_CODES.CONFIGURATOR_TEMPLATE_EXISTS],
  [new ConfiguratorGroupNotFoundError(), ERROR_CODES.CONFIGURATOR_GROUP_NOT_FOUND],
  [new ConfiguratorValueNotFoundError(), ERROR_CODES.CONFIGURATOR_VALUE_NOT_FOUND],
  [new ConfiguratorRuleNotFoundError(), ERROR_CODES.CONFIGURATOR_RULE_NOT_FOUND],
  [new ConfiguratorCodeTakenError("LOCK"), ERROR_CODES.CONFIGURATOR_CODE_TAKEN],
  [new ConfiguratorReferenceInUseError(["Regel: Elpolerad finns inte med lock C", "Strukturrad 3"]), ERROR_CODES.CONFIGURATOR_REFERENCE_IN_USE],
  [new InvalidConfiguratorRuleError("x"), ERROR_CODES.INVALID_CONFIGURATOR_RULE],
  [new InvalidConfiguratorGroupError("x"), ERROR_CODES.INVALID_CONFIGURATOR_GROUP],
  [new ConfiguratorModeNotAllowedError("x"), ERROR_CODES.CONFIGURATOR_MODE_NOT_ALLOWED],
  [new BaseUnitLockedError(), ERROR_CODES.BASE_UNIT_LOCKED],
  [new InvalidReferenceError("x"), ERROR_CODES.INVALID_REFERENCE],
  [new InvalidUnitError(), ERROR_CODES.INVALID_UNIT],
  [new ArticleNotFoundError("a"), ERROR_CODES.ARTICLE_NOT_FOUND],
  [new ArticleCopyPartNotAllowedError("beredning", "purchased"), ERROR_CODES.ARTICLE_COPY_PART_NOT_ALLOWED],
  [new ArticleIsTemplateError("63000"), ERROR_CODES.ARTICLE_IS_TEMPLATE],
  [new InvalidConfiguratorFormulaError("Antal", "Okänd kod LANGD (tecken 1)"), ERROR_CODES.INVALID_CONFIGURATOR_FORMULA],
  [new InvalidConfiguratorLineError("x"), ERROR_CODES.INVALID_CONFIGURATOR_LINE],
  [new InvalidConfiguratorOperationError("x"), ERROR_CODES.INVALID_CONFIGURATOR_OPERATION],
  [new ConfiguratorSequenceTakenError(40), ERROR_CODES.CONFIGURATOR_SEQUENCE_TAKEN],
  [new ConfiguratorLineNotFoundError(), ERROR_CODES.CONFIGURATOR_LINE_NOT_FOUND],
  [new ConfiguratorOperationNotFoundError(), ERROR_CODES.CONFIGURATOR_OPERATION_NOT_FOUND],
  [new ConfiguratorTooManyCombinationsError(210, 200), ERROR_CODES.CONFIGURATOR_TOO_MANY_COMBINATIONS],
  [new InvalidConfiguratorVariantSetError("x"), ERROR_CODES.INVALID_CONFIGURATOR_VARIANT_SET],
  [new ConfiguratorNotVariantModeError(), ERROR_CODES.CONFIGURATOR_NOT_VARIANT_MODE],
  [new ConfiguratorTemplateHasVariantsError(), ERROR_CODES.CONFIGURATOR_TEMPLATE_HAS_VARIANTS],
  [new ConfiguratorVariantNotTemplateError(), ERROR_CODES.CONFIGURATOR_VARIANT_NOT_TEMPLATE],
  [new ConfiguratorCodeLockedError("LOCK"), ERROR_CODES.CONFIGURATOR_CODE_LOCKED],
  [new ConfiguratorVariantNumberRaceError(), ERROR_CODES.CONFIGURATOR_VARIANT_NUMBER_RACE],
  [new ConfiguratorVariantNotFoundError(), ERROR_CODES.CONFIGURATOR_VARIANT_NOT_FOUND],
  [new ConfiguratorInvalidConfigurationError(["x"]), ERROR_CODES.CONFIGURATOR_INVALID_CONFIGURATION],
  [new ConfiguratorVariantNumberTakenError("63000-A"), ERROR_CODES.CONFIGURATOR_VARIANT_NUMBER_TAKEN],
  [new ConfiguratorVariantTooLongError("x"), ERROR_CODES.CONFIGURATOR_VARIANT_TOO_LONG],
  [new ConfiguratorVariantNotDerivableError(), ERROR_CODES.CONFIGURATOR_VARIANT_NOT_DERIVABLE],
  [new ConfiguratorNotToOrderModeError(), ERROR_CODES.CONFIGURATOR_NOT_TO_ORDER_MODE],
  [new ConfiguratorNotPublishedError("63000"), ERROR_CODES.CONFIGURATOR_NOT_PUBLISHED],
  [new ConfigurationRequiredError("63000"), ERROR_CODES.CONFIGURATION_REQUIRED],
  [new ConfigurationNotAllowedError("63000"), ERROR_CODES.CONFIGURATION_NOT_ALLOWED],
  [new SalesOrderNotOpenError("cancelled"), ERROR_CODES.SALES_ORDER_NOT_OPEN],
  [new RowConfigurationLockedError("x"), ERROR_CODES.ROW_CONFIGURATION_LOCKED],
  [new RowConfigurationChangedError(), ERROR_CODES.ROW_CONFIGURATION_CHANGED],
  [new RowVariantExistsError("63000-B"), ERROR_CODES.ROW_VARIANT_EXISTS],
  [new WorkCenterNotFoundError("x"), ERROR_CODES.WORK_CENTER_NOT_FOUND],
  [new MoReportNotFoundError("x"), ERROR_CODES.MO_REPORT_NOT_FOUND],
  [new MoReportAlreadyUndoneError(), ERROR_CODES.MO_REPORT_ALREADY_UNDONE],
  [new MoReportFromPurchaseReceiptError(), ERROR_CODES.MO_REPORT_FROM_PURCHASE_RECEIPT],
  [new MoReportStockMissingError(1, 5), ERROR_CODES.MO_REPORT_STOCK_MISSING],
  [new MaterialShortageError([], true), ERROR_CODES.MATERIAL_SHORTAGE],
  [new MoReportTimeLockedError("2026-09-30"), ERROR_CODES.MO_REPORT_TIME_LOCKED],
  [new ManufacturingOrderHasReportsError(), ERROR_CODES.MANUFACTURING_ORDER_HAS_REPORTS],
  [new ManufacturingOrderStampedInError(), ERROR_CODES.MANUFACTURING_ORDER_STAMPED_IN],
  [new OperationNotFoundError("x"), ERROR_CODES.OPERATION_NOT_FOUND],
  [new OperationNotPlannableError("done"), ERROR_CODES.OPERATION_NOT_PLANNABLE],
  [
    new DeliveryTimeChangedError("2030-03-20", { shipDate: null, deliveryDate: null, rows: [], notes: [], batches: [] }),
    ERROR_CODES.DELIVERY_TIME_CHANGED,
  ],
  [new NothingToReserveError(), ERROR_CODES.NOTHING_TO_RESERVE],
];

describe("error class name -> ERROR_CODES derivation", () => {
  it.each(cases)("derives %#: %s", (instance, expectedCode) => {
    expect(errorBody(instance).code).toBe(expectedCode);
  });

  it("covers every code in ERROR_CODES exactly once", () => {
    const covered = cases.map(([, code]) => code).sort();
    const expected = Object.values(ERROR_CODES).sort();
    expect(covered).toEqual(expected);
  });

  // The other half of the chain: the API derives the code, the web turns it
  // into Swedish. The web can't import @navet/shared (Turbopack chokes on the
  // package's .js-suffixed imports), so its dictionary repeats the code
  // strings as plain literals — nothing but this test stops a typo there from
  // silently falling back to the raw English message. Read as text rather
  // than imported: the file is TSX-adjacent web code, and only its keys
  // matter here.
  it("has a Swedish message in the web dictionary for every code", () => {
    const dictionary = readFileSync(
      new URL("../../web/lib/errorMessages.ts", import.meta.url),
      "utf8"
    );
    const missing = Object.values(ERROR_CODES).filter((code) => !dictionary.includes(`"${code}":`));
    expect(missing).toEqual([]);
  });
});
