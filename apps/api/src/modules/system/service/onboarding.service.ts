import type { Db } from "@navet/db";
import { markNumberSeriesReviewed, readOnboardingFacts } from "../repository/onboarding.repository.js";
import { buildOnboarding } from "./onboarding.js";

export function createOnboardingService(db: Db) {
  return {
    async view() {
      return buildOnboarding(await readOnboardingFacts(db));
    },
    async markNumberSeriesReviewed(userId: string | null) {
      await markNumberSeriesReviewed(db, userId);
      return buildOnboarding(await readOnboardingFacts(db));
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
