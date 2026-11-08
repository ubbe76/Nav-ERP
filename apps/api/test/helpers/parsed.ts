import type { z } from "zod";

// Services take a schema's OUTPUT type (defaults filled in), because a route
// parses the body with the schema before it calls the service. A test that
// calls the service directly gets the same defaults the route would apply,
// and its own input is still type-checked against the schema's INPUT type:
//
//   await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB" }));
//
// Never cast a test input to the output type instead — a default the schema
// adds and the service relies on would then silently be missing.
export function parsed<S extends z.ZodTypeAny>(schema: S, input: z.input<S>): z.output<S> {
  return schema.parse(input);
}
