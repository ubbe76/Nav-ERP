import { API_CLIENT_SCOPES } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService, InvalidClientCredentialsError } from "../src/modules/oauth/service/oauth.service.js";

const authRepo = createAuthRepository(db);
const oauthService = createOAuthService(createOAuthRepository(db), "test-secret");

beforeEach(async () => {
  await db.execute(sql`TRUNCATE api_clients, users CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE api_clients, users CASCADE`);
});

async function makeUser() {
  return authRepo.create({
    email: `oauth-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Admin",
    role: "admin",
  });
}

describe("oauth service — client creation", () => {
  it("creates an API client and returns the plaintext secret once", async () => {
    const user = await makeUser();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Diskbänkskonfigurator", scopes: [...API_CLIENT_SCOPES] }, user.id);

    expect(client.name).toBe("Diskbänkskonfigurator");
    expect(clientSecret.length).toBeGreaterThan(20);
  });
});

describe("oauth service — token issuance", () => {
  it("issues a bearer token for valid client credentials", async () => {
    const user = await makeUser();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Konfigurator", scopes: [...API_CLIENT_SCOPES] }, user.id);

    const token = await oauthService.issueToken(client.id, clientSecret);

    expect(token.tokenType).toBe("Bearer");
    expect(typeof token.accessToken).toBe("string");
    expect(token.expiresIn).toBe(3600);
  });

  it("rejects an incorrect client secret", async () => {
    const user = await makeUser();
    const { client } = await oauthService.createApiClient({ name: "Konfigurator", scopes: [...API_CLIENT_SCOPES] }, user.id);

    await expect(oauthService.issueToken(client.id, "wrong-secret")).rejects.toThrow(InvalidClientCredentialsError);
  });

  it("rejects an unknown client id", async () => {
    await expect(
      oauthService.issueToken("00000000-0000-0000-0000-000000000000", "whatever")
    ).rejects.toThrow(InvalidClientCredentialsError);
  });
});

describe("oauth service — token verification", () => {
  it("resolves a valid token back to the client", async () => {
    const user = await makeUser();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Konfigurator", scopes: [...API_CLIENT_SCOPES] }, user.id);
    const { accessToken } = await oauthService.issueToken(client.id, clientSecret);

    const resolved = await oauthService.verifyClientToken(accessToken);
    expect(resolved?.id).toBe(client.id);
  });

  it("rejects a malformed or tampered token", async () => {
    const resolved = await oauthService.verifyClientToken("not-a-real-token");
    expect(resolved).toBeNull();
  });
});
