import type { FastifyRequest } from "fastify";
import { errorBody } from "../../system/service/error-body.js";
import type { ConfigurationNotDerivableError } from "../service/configurator.errors.js";

// Konfigurator: the 409 configuration-not-derivable body — a beställningsvara
// row whose structure cannot be derived for the choices. The derivation's
// messages name structure lines and operations: a session gets them as
// `details` so the template can be fixed in Nav, an API client
// (req.apiClient) never — the spec's "never structure, route or costs" (same
// rule as ConfiguratorVariantNotDerivableError). One implementation for the
// sales row routes and the OAuth POST /quotes.
export function notDerivableBody(err: ConfigurationNotDerivableError, req: FastifyRequest) {
  return req.apiClient ? errorBody(err) : { ...errorBody(err), details: err.details };
}
