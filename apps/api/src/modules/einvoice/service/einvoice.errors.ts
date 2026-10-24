import type { EinvoiceBlockedReason } from "@navet/shared";
import { EInvoiceProviderError } from "./einvoice-provider.js";

// E-faktura domain errors. Messages are Swedish on purpose: the web shows
// them verbatim where the code has no dictionary text of its own (the
// einvoice-not-allowed sentence in particular). Class names derive the
// error codes pinned in error-codes.test.ts ("EinvoiceNotAllowedError" →
// "einvoice-not-allowed"), hence the lower-case i.

export type EinvoiceNotConfiguredReason = "disabled" | "no-key" | "no-account";

const NOT_CONFIGURED_MESSAGES: Record<EinvoiceNotConfiguredReason, string> = {
  disabled: "E-faktura är inte aktiverad — slå på den under System → E-faktura",
  "no-key": "Ingen API-nyckel för e-faktura är sparad — lägg in den under System → E-faktura",
  "no-account": "Inget B2Brouter-konto är valt — kör Testa anslutning under System → E-faktura",
};

export class EinvoiceNotConfiguredError extends Error {
  constructor(readonly reason: EinvoiceNotConfiguredReason) {
    super(NOT_CONFIGURED_MESSAGES[reason]);
    this.name = "EinvoiceNotConfiguredError";
  }
}

export const BLOCKED_MESSAGES: Record<EinvoiceBlockedReason, string> = {
  "invoice-not-issued": "Bara en utfärdad faktura kan skickas som e-faktura",
  "private-person": "Privatpersoner kan inte få e-faktura — fakturan skickas med e-post",
  "foreign-customer": "E-faktura kan bara skickas till svenska kunder i den här versionen",
  currency: "E-faktura kan bara skickas för fakturor i SEK i den här versionen",
  "missing-company-data":
    "Företagets organisationsnummer och momsregistreringsnummer måste vara ifyllda under System → Företagsuppgifter",
  "missing-recipient-id": "Kunden saknar Peppol-id och organisationsnummer — fyll i ett av dem på kundkortet",
  "vat-code-unsupported":
    "E-faktura kan bara skickas för rader med svensk moms, momsfri försäljning eller omvänd betalningsskyldighet i Sverige i den här versionen",
};

export class EinvoiceNotAllowedError extends Error {
  constructor(readonly reason: EinvoiceBlockedReason) {
    super(BLOCKED_MESSAGES[reason]);
    this.name = "EinvoiceNotAllowedError";
  }
}

export class EinvoiceAlreadySentError extends Error {
  constructor(invoiceNumber: string) {
    super(`${invoiceNumber} har redan en pågående eller godkänd e-fakturasändning`);
    this.name = "EinvoiceAlreadySentError";
  }
}

// ubl-check found a structural problem before anything left Nav.
export class EinvoiceDocumentInvalidError extends Error {
  constructor(readonly problems: string[]) {
    super(`E-fakturan klarade inte kontrollen: ${problems.join("; ")}`);
    this.name = "EinvoiceDocumentInvalidError";
  }
}

export class EinvoiceTransmissionNotFoundError extends Error {
  constructor(id: string) {
    super(`Sändningen hittades inte (${id})`);
    this.name = "EinvoiceTransmissionNotFoundError";
  }
}

// The provider seam's error, split by kind into three domain errors so each
// gets its own code and status (400 / 409 / 502) in the envelope.
export class EinvoiceProviderRejectedError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: string[] = [],
    readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "EinvoiceProviderRejectedError";
  }
}

export class EinvoiceProviderUnauthorizedError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "EinvoiceProviderUnauthorizedError";
  }
}

export class EinvoiceProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "EinvoiceProviderUnavailableError";
  }
}

// not-found (the document is gone at the access point) only arises on a
// status read, which the status service handles itself; reaching a route it
// is as good as unavailable.
export function fromProviderError(err: EInvoiceProviderError): Error {
  if (err.kind === "validation") return new EinvoiceProviderRejectedError(err.message, err.fieldErrors, err.requestId);
  if (err.kind === "unauthorized") return new EinvoiceProviderUnauthorizedError(err.message, err.requestId);
  return new EinvoiceProviderUnavailableError(err.message, err.requestId);
}

export function isProviderError(err: unknown): err is EInvoiceProviderError {
  return err instanceof EInvoiceProviderError;
}
