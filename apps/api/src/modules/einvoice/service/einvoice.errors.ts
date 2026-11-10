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
  "missing-company-data":
    "Företagets organisationsnummer och momsregistreringsnummer måste vara ifyllda under System → Företagsuppgifter",
  "missing-recipient-id":
    "Kunden saknar Peppol-id — fyll i Peppol-id på kundkortet (för kunder i Sverige, Norge, Danmark och Belgien räcker organisationsnumret)",
  "vat-code-unsupported": "Fakturan har rader utanför momsens tillämpningsområde (räntefaktura) och kan inte skickas som e-faktura",
  "vat-code-mixed": "Export av tjänster (momskod EXT) kan inte stå på samma e-faktura som andra momskoder — fakturera tjänsterna för sig",
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

const ENVIRONMENT_NAMES = { sandbox: "Sandbox", production: "Produktion" } as const;

// A row from the environment that is not selected: the saved key belongs to
// the other one, so nothing about the row can be asked or acknowledged at
// the access point with it (review 2026-11-10).
export class EinvoiceOtherEnvironmentError extends Error {
  constructor(readonly environment: "sandbox" | "production") {
    super(`Raden hör till miljön ${ENVIRONMENT_NAMES[environment]} — välj den miljön under System → E-faktura för att hantera den`);
    this.name = "EinvoiceOtherEnvironmentError";
  }
}

// The API key does not belong to the selected Miljö: B2Brouter routes by the
// key ("test_" = sandbox, "prod_" or no prefix = production, "stag_" = their
// staging host, never Nav's), so a production key under Sandbox would send
// real invoices labelled as tests (review 2026-11-10).
export class EinvoiceKeyEnvironmentMismatchError extends Error {
  constructor(
    readonly keyEnvironment: "sandbox" | "production" | "staging",
    readonly selected: "sandbox" | "production"
  ) {
    super(
      keyEnvironment === "staging"
        ? "Nyckeln börjar på stag_ och hör till B2Brouters staging-miljö, som Nav inte använder — skapa en nyckel för Sandbox (test_) eller Produktion (prod_)"
        : `Nyckeln hör till ${ENVIRONMENT_NAMES[keyEnvironment]} men Miljö är ${ENVIRONMENT_NAMES[selected]} — välj samma miljö som nyckeln`
    );
    this.name = "EinvoiceKeyEnvironmentMismatchError";
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

// Ta emot e-faktura: the access point answered 409 — the organisation
// number is published by another access point (a migration code is needed)
// or, in the sandbox, migration codes are unavailable. The message is the
// Swedish text the settings page shows.
export class EinvoiceReceptionRegisteredElsewhereError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "EinvoiceReceptionRegisteredElsewhereError";
  }
}

export class EinvoiceReceptionNotFoundError extends Error {
  constructor(id: string) {
    super(`Mottagningen hittades inte (${id})`);
    this.name = "EinvoiceReceptionNotFoundError";
  }
}

// Hämta nu while a reception run holds the lease. 409.
export class EinvoiceReceiveBusyError extends Error {
  constructor() {
    super("En hämtning av e-fakturor pågår redan");
    this.name = "EinvoiceReceiveBusyError";
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
  if (err.kind === "conflict") return new EinvoiceReceptionRegisteredElsewhereError(err.message, err.requestId);
  return new EinvoiceProviderUnavailableError(err.message, err.requestId);
}

export function isProviderError(err: unknown): err is EInvoiceProviderError {
  return err instanceof EInvoiceProviderError;
}
