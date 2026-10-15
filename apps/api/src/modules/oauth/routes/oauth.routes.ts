import type { FastifyInstance } from "fastify";
import { issueTokenSchema } from "@navet/shared";
import type { OAuthService } from "../service/oauth.service.js";
import { InvalidClientCredentialsError } from "../service/oauth.service.js";
import { errorBody } from "../../system/service/error-body.js";
import { sendThrottled, type CredentialThrottles } from "../../auth/routes/auth.routes.js";
import { LoginThrottledError } from "../../auth/service/login-throttle.js";

// Public — this route IS the authentication mechanism, no guard applied
// beyond the failed-attempt throttle shared with login.
export async function oauthRoutes(app: FastifyInstance, opts: { service: OAuthService; throttles: CredentialThrottles }) {
  const { service, throttles } = opts;

  app.post("/oauth/token", async (req, reply) => {
    const input = issueTokenSchema.parse(req.body);
    const clientKey = [`oauth:${input.clientId}`];
    const ipKey = [`oauth-ip:${req.ip}`];
    try {
      throttles.account.assertAllowed(clientKey);
      throttles.ip?.assertAllowed(ipKey);
      const token = await service.issueToken(input.clientId, input.clientSecret);
      throttles.account.recordSuccess(clientKey);
      return token;
    } catch (err) {
      if (err instanceof LoginThrottledError) return sendThrottled(reply, err);
      if (err instanceof InvalidClientCredentialsError) {
        throttles.account.recordFailure(clientKey);
        throttles.ip?.recordFailure(ipKey);
        return reply.code(401).send(errorBody(err));
      }
      throw err;
    }
  });
}
