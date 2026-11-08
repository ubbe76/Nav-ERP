import { db } from "@navet/db";
import { createPeriodicSummaryService } from "../../src/modules/economy/service/periodic-summary.service.js";
import { createVatCodeService } from "../../src/modules/economy/service/vat-code.service.js";
import { createVerificationPoster } from "../../src/modules/economy/service/verification-poster.js";
import { DEFAULT_POSTING_SETTINGS } from "./services.js";

// economyRoutes wants every economy service. A test of one route group that
// never reaches the others passes these real, inert services (nothing runs
// until a route calls them) instead of a cast stub.
export const unusedVatCodes = createVatCodeService({
  db,
  poster: createVerificationPoster({ read: async () => DEFAULT_POSTING_SETTINGS }),
  audit: { log: async () => {} },
});

export const unusedPeriodicSummary = createPeriodicSummaryService({ db, company: { vatNumber: async () => null } });
