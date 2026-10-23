// Tillägg. Codes are derived from the class names (error-body.ts):
// plugin-not-found, plugin-manifest-invalid, plugin-manifest-unreachable,
// plugin-key-taken, plugin-same-origin, plugin-delivery-not-found,
// plugin-delivery-not-retryable, plugin-access-denied.

export class PluginNotFoundError extends Error {
  constructor(id: string) {
    super(`Plugin ${id} not found`);
    this.name = "PluginNotFoundError";
  }
}

// validatePluginManifest said no (or the manifest can't change key): the
// body carries the findings.
export class PluginManifestInvalidError extends Error {
  constructor(
    readonly errors: string[],
    readonly warnings: string[] = []
  ) {
    super("Manifestet innehåller fel.");
    this.name = "PluginManifestInvalidError";
  }
}

// The manifest could not be fetched from the plugin's address.
export class PluginManifestUnreachableError extends Error {
  constructor(reason: string) {
    super(`Manifestet kunde inte hämtas: ${reason}`);
    this.name = "PluginManifestUnreachableError";
  }
}

export class PluginKeyTakenError extends Error {
  constructor(key: string) {
    super(`Ett tillägg med nyckeln ${key} är redan installerat.`);
    this.name = "PluginKeyTakenError";
  }
}

// The plugin's origin equals Nav's own: allow-same-origin + allow-scripts in
// the iframe would then be no sandbox at all.
export class PluginSameOriginError extends Error {
  constructor() {
    super("Tillägget måste ha en annan adress (ursprung) än Nav.");
    this.name = "PluginSameOriginError";
  }
}

// An http(s) address without credentials, query or fragment is required.
export class PluginInvalidAddressError extends Error {
  constructor() {
    super("Adressen måste vara en http- eller https-adress utan användarnamn, frågedel eller fragment.");
    this.name = "PluginInvalidAddressError";
  }
}

export class PluginDeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`Delivery ${id} not found`);
    this.name = "PluginDeliveryNotFoundError";
  }
}

export class PluginDeliveryNotRetryableError extends Error {
  constructor() {
    super("Bara misslyckade leveranser kan skickas igen.");
    this.name = "PluginDeliveryNotRetryableError";
  }
}

// The signed-in user (or the plugin) may not see this page or tab.
export class PluginAccessDeniedError extends Error {
  constructor() {
    super("Du har inte behörighet till den här delen av tillägget.");
    this.name = "PluginAccessDeniedError";
  }
}
