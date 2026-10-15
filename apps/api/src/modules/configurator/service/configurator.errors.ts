// Produktkonfigurator — domain errors. Codes are derived from the class names
// (errorBody); the HTTP status is chosen by the routes. Messages are Swedish
// because they name the specific rule/code the user has to fix.

// 404: the article has no configurator template (inte konfigurerbar).
export class ConfiguratorTemplateNotFoundError extends Error {
  constructor() {
    super("Artikeln är inte konfigurerbar");
    this.name = "ConfiguratorTemplateNotFoundError";
  }
}

// 409: POST on an article that already is a template.
export class ConfiguratorTemplateExistsError extends Error {
  constructor() {
    super("Artikeln är redan konfigurerbar");
    this.name = "ConfiguratorTemplateExistsError";
  }
}

// 404: the group does not exist in THIS template.
export class ConfiguratorGroupNotFoundError extends Error {
  constructor() {
    super("Valgruppen finns inte i konfiguratorn");
    this.name = "ConfiguratorGroupNotFoundError";
  }
}

// 404: the alternative does not exist in this group.
export class ConfiguratorValueNotFoundError extends Error {
  constructor() {
    super("Alternativet finns inte i valgruppen");
    this.name = "ConfiguratorValueNotFoundError";
  }
}

// 404: the rule does not exist in this template.
export class ConfiguratorRuleNotFoundError extends Error {
  constructor() {
    super("Regeln finns inte i konfiguratorn");
    this.name = "ConfiguratorRuleNotFoundError";
  }
}

// 409: group code unique per template / alternative code unique per group.
export class ConfiguratorCodeTakenError extends Error {
  constructor(public readonly configuratorCode: string) {
    super(`Koden ${configuratorCode} används redan`);
    this.name = "ConfiguratorCodeTakenError";
  }
}

// 409: a group/alternative that a rule, structure line or operation points at
// cannot be deleted, and a code a formula uses cannot change. `references`
// lists where: "Regel: <meddelande>", "Strukturrad <N>", "Operation <nr>".
export class ConfiguratorReferenceInUseError extends Error {
  constructor(public readonly references: string[]) {
    super(`Används av: ${references.join("; ")}`);
    this.name = "ConfiguratorReferenceInUseError";
  }
}

// 404: the structure line does not exist in this template.
export class ConfiguratorLineNotFoundError extends Error {
  constructor() {
    super("Strukturraden finns inte i konfiguratorn");
    this.name = "ConfiguratorLineNotFoundError";
  }
}

// 404: the conditional operation does not exist in this template.
export class ConfiguratorOperationNotFoundError extends Error {
  constructor() {
    super("Operationen finns inte i konfiguratorn");
    this.name = "ConfiguratorOperationNotFoundError";
  }
}

// 409: the operation number is used by the template's ordinary route or by
// another conditional operation (also raised from the unique index).
export class ConfiguratorSequenceTakenError extends Error {
  constructor(public readonly sequenceNo: number) {
    super(`Operationsnummer ${sequenceNo} används redan i rutten eller av en annan operation`);
    this.name = "ConfiguratorSequenceTakenError";
  }
}

// 400: a structure line that does not fit the template (save validation:
// conditions, source, links, merged fields).
export class InvalidConfiguratorLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfiguratorLineError";
  }
}

// 400: a conditional operation that does not fit the template (conditions,
// time fields, inactive resource).
export class InvalidConfiguratorOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfiguratorOperationError";
  }
}

// 400: a formula that does not validate against the template's codes. The
// message is the field name followed by the formula error with its position:
// "Antal: Okänd kod LANGD (tecken 1)".
export class InvalidConfiguratorFormulaError extends Error {
  constructor(field: "Antal" | "Ställtid" | "Stycktid", formulaMessage: string) {
    super(`${field}: ${formulaMessage}`);
    this.name = "InvalidConfiguratorFormulaError";
  }
}

// 400: the rule does not fit the template (save validation).
export class InvalidConfiguratorRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfiguratorRuleError";
  }
}

// 400: a group update that does not fit the group (field of another kind,
// default from another group, empty number range).
export class InvalidConfiguratorGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfiguratorGroupError";
  }
}

// 400: the article's type/phantom flag does not allow the mode (also raised
// by the article module on a type change of a template article).
export class ConfiguratorModeNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfiguratorModeNotAllowedError";
  }
}

// 400 (route answers code "validation-failed"): a reorder whose ids are not
// exactly the current set.
export class ConfiguratorReorderMismatchError extends Error {
  constructor() {
    super("Ordningen ska innehålla exakt de befintliga posterna, var och en en gång");
    this.name = "ConfiguratorReorderMismatchError";
  }
}

// --- lagerförda varianter (delprojekt 3) ---

// 400: the value sets multiply to more combinations than one call may create.
export class ConfiguratorTooManyCombinationsError extends Error {
  constructor(count: number, max: number) {
    super(`Högst ${max} kombinationer — urvalet ger ${count}`);
    this.name = "ConfiguratorTooManyCombinationsError";
  }
}

// 400: a malformed value set (unknown group, alternative not in the group,
// wrong value type, duplicate, empty) — the message names the group.
export class InvalidConfiguratorVariantSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfiguratorVariantSetError";
  }
}

// 409: variants can only be previewed/created on a template in the variants mode.
export class ConfiguratorNotVariantModeError extends Error {
  constructor() {
    super("Mallen är inte i läget Variantartiklar");
    this.name = "ConfiguratorNotVariantModeError";
  }
}

// 409: a template with variants keeps its mode and cannot be deleted.
export class ConfiguratorTemplateHasVariantsError extends Error {
  constructor() {
    super("Mallen har varianter och kan inte byta läge eller tas bort");
    this.name = "ConfiguratorTemplateHasVariantsError";
  }
}

// 409: POST configurator on an article that is itself a variant.
export class ConfiguratorVariantNotTemplateError extends Error {
  constructor() {
    super("En variant kan inte göras till mall");
    this.name = "ConfiguratorVariantNotTemplateError";
  }
}

// 409: a group/alternative code that a variant's key spells may not change
// (the same combination would otherwise be created twice).
export class ConfiguratorCodeLockedError extends Error {
  constructor(public readonly configuratorCode: string) {
    super(`Koden ${configuratorCode} används av varianter och kan inte ändras`);
    this.name = "ConfiguratorCodeLockedError";
  }
}

// 409: a concurrent POST /articles took a variant's number between the
// check and the insert — the whole creation rolled back.
export class ConfiguratorVariantNumberRaceError extends Error {
  constructor() {
    super("Artikelnumret togs under tiden — försök igen");
    this.name = "ConfiguratorVariantNumberRaceError";
  }
}

// 404: GET variant-of on an article that is not a variant.
export class ConfiguratorVariantNotFoundError extends Error {
  constructor() {
    super("Artikeln är ingen variant");
    this.name = "ConfiguratorVariantNotFoundError";
  }
}

// 400: resolveVariant (Konfigurera på orderraden) on a selection the engine
// rejects — the engine's messages ride along as details. A selection the
// engine accepts but the derivation cannot build is
// ConfiguratorVariantNotDerivableError instead.
export class ConfiguratorInvalidConfigurationError extends Error {
  constructor(public readonly details: string[]) {
    super(details.length > 0 ? details.join("; ") : "Konfigurationen är inte giltig");
    this.name = "ConfiguratorInvalidConfigurationError";
  }
}

// 409: resolveVariant on a selection the engine accepts but whose structure or
// route cannot be derived (a line without component, a negative time, a
// formula error). Deliberately WITHOUT details: the derivation's messages name
// structure lines and operations, which an API client must never see (spec:
// never structure, route or costs) — the article card's variant preview shows
// them to Nav users instead.
export class ConfiguratorVariantNotDerivableError extends Error {
  constructor() {
    super("Kombinationen kan inte tillverkas — kontrollera mallens struktur i Nav");
    this.name = "ConfiguratorVariantNotDerivableError";
  }
}

// 409: the variant's number belongs to an article that is not the variant.
export class ConfiguratorVariantNumberTakenError extends Error {
  constructor(public readonly articleNumber: string) {
    super(`Artikelnumret ${articleNumber} finns redan`);
    this.name = "ConfiguratorVariantNumberTakenError";
  }
}

// 400: the variant's number or name would exceed the article limits.
export class ConfiguratorVariantTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfiguratorVariantTooLongError";
  }
}

// --- beställningsvara på orderraden (delprojekt 4b) ---

// 409: a row configuration can only be evaluated on a template in the to_order mode.
export class ConfiguratorNotToOrderModeError extends Error {
  constructor() {
    super("Mallen är inte i läget Beställningsvara");
    this.name = "ConfiguratorNotToOrderModeError";
  }
}

// --- externt API (delprojekt 5) ---

// 409: an OAuth client's POST /quotes row carries a configuration on a
// template that is not published (Visa i API) or whose article is inactive.
// Sessions never get it — the check is the OAuth route's, on req.apiClient.
export class ConfiguratorNotPublishedError extends Error {
  constructor(public readonly articleNumber: string) {
    super(`Mallen ${articleNumber} är inte publicerad för API:t`);
    this.name = "ConfiguratorNotPublishedError";
  }
}
