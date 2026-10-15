import type { FastifyRequest } from "fastify";
import { z } from "zod";

// Every primary key is a uuid: a path parameter named `id` or `…Id` that is
// not one can never match a row, and passing it on surfaced as a Postgres
// cast error (500). Rejected as the same 400 a zod-parsed body gets — what
// shipping.routes' idParams did per route, for every route. Runs after
// authentication, so an anonymous caller still gets 401 first.
const uuid = z.string().uuid();

export function rejectMalformedIds() {
  return async (req: FastifyRequest) => {
    for (const [name, value] of Object.entries((req.params ?? {}) as Record<string, unknown>)) {
      if (name === "id" || name.endsWith("Id")) uuid.parse(value);
    }
  };
}
