import type { FastifyInstance } from "fastify";
import type { OnboardingService } from "../service/onboarding.service.js";

// System → Kom igång (admin). The checklist is derived on every request.
export async function onboardingRoutes(app: FastifyInstance, opts: { service: OnboardingService }) {
  app.get("/onboarding", async () => opts.service.view());
  app.post("/onboarding/number-series-reviewed", async (req) => opts.service.markNumberSeriesReviewed(req.user!.id));
}
