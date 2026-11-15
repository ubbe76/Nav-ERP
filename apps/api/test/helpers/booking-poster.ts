import type { createVerificationPoster } from "../../src/modules/economy/service/verification-poster.js";

type Poster = ReturnType<typeof createVerificationPoster>;

// The poster as the suites that expect a customer invoice to BOOK use it:
// postCustomerInvoice answers null for a 0-kronorsfaktura (nothing to book),
// so here null fails the case instead of a non-null assertion at every call.
// The 0 kr cases call the plain poster.
export function bookingPoster(poster: Poster) {
  return {
    ...poster,
    async postCustomerInvoice(...args: Parameters<Poster["postCustomerInvoice"]>) {
      const posted = await poster.postCustomerInvoice(...args);
      if (posted === null) throw new Error("expected the customer invoice to book a verification");
      return posted;
    },
  };
}
