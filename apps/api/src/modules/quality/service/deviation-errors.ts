// Avvikelser — the domain errors. A leaf (no imports): the shortcut routes in
// sales/purchase/manufacturing map DeviationLinkNotAllowedError too. The
// codes are derived from the class names (error-body.ts) and pinned in
// error-codes.test.ts; the messages are Swedish because the web shows the
// server's text for the link and reason errors (they name the field).

export class DeviationNotFoundError extends Error {
  constructor(id: string) {
    super(`Avvikelsen ${id} finns inte`);
    this.name = "DeviationNotFoundError";
  }
}

// 400: a link on the case does not belong with the rest (the KO is another
// customer's, the row another order's, the article not the row's …) or with
// the case's type. `field` is the input field the web marks.
export class DeviationLinkMismatchError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = "DeviationLinkMismatchError";
  }
}

// 409: a document cannot be linked to the case — the case is closed or
// cancelled (or missing), the document's type does not fit the case's, or
// the document belongs to another counterparty.
export class DeviationLinkNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviationLinkNotAllowedError";
  }
}

// 400: the chosen Avvikelseorsak does not apply to the case's type (or is
// inactive / missing).
export class DeviationReasonNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviationReasonNotApplicableError";
  }
}

// 409: Avsluta needs Åtgärd and — for customer and supplier cases — Beslut.
export class DeviationCloseRequirementsError extends Error {
  constructor(readonly missing: ("correctiveAction" | "decision")[]) {
    const words = missing.map((m) => (m === "correctiveAction" ? "Åtgärd" : "Beslut"));
    super(`Fyll i ${words.join(" och ")} innan avvikelsen avslutas`);
    this.name = "DeviationCloseRequirementsError";
  }
}

// 409: the status action is not allowed from the case's current status.
export class InvalidStatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatusTransitionError";
  }
}

// 409: fields, costs, links and files change only while the case is open
// (Registrerad/Utreds) — an Avslutad case is opened again first.
export class DeviationNotEditableError extends Error {
  constructor(number: string) {
    super(`${number} är avslutad eller makulerad — öppna den igen för att ändra`);
    this.name = "DeviationNotEditableError";
  }
}

export class DeviationCostNotFoundError extends Error {
  constructor(id: string) {
    super(`Kostnadsraden ${id} finns inte`);
    this.name = "DeviationCostNotFoundError";
  }
}

export class DeviationLinkNotFoundError extends Error {
  constructor(id: string) {
    super(`Kopplingen ${id} finns inte`);
    this.name = "DeviationLinkNotFoundError";
  }
}

export class DeviationFileNotFoundError extends Error {
  constructor(id: string) {
    super(`Filen ${id} finns inte`);
    this.name = "DeviationFileNotFoundError";
  }
}

// 400: only PDF, JPEG and PNG whose first bytes match the type.
export class InvalidDeviationFileTypeError extends Error {
  constructor(contentType: string) {
    super(`Filtypen ${contentType} stöds inte — ladda upp PDF, JPEG eller PNG`);
    this.name = "InvalidDeviationFileTypeError";
  }
}
