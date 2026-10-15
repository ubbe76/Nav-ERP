import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { CreateApiClientInput } from "@navet/shared";
import type { OAuthRepository } from "../repository/oauth.repository.js";

const CLIENT_TOKEN_EXPIRES_IN = "1h";
const CLIENT_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;
const SALT_ROUNDS = 12;

export class InvalidClientCredentialsError extends Error {
  constructor() {
    super("Invalid client credentials");
    this.name = "InvalidClientCredentialsError";
  }
}

export class ApiClientNotFoundError extends Error {
  constructor(id: string) {
    super(`API client ${id} not found`);
    this.name = "ApiClientNotFoundError";
  }
}

export interface ClientTokenPayload {
  sub: string;
  type: "client";
}

export interface PublicApiClient {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
}

function toPublicApiClient(row: { id: string; name: string; active: boolean; createdAt: Date }): PublicApiClient {
  return { id: row.id, name: row.name, active: row.active, createdAt: row.createdAt };
}

export function createOAuthService(repo: OAuthRepository, jwtSecret: string) {
  return {
    // Returns the plaintext secret ONCE — only the bcrypt hash is stored.
    async createApiClient(input: CreateApiClientInput, createdBy: string) {
      const clientSecret = crypto.randomBytes(32).toString("hex");
      const clientSecretHash = await bcrypt.hash(clientSecret, SALT_ROUNDS);
      const row = await repo.createApiClient({ name: input.name, clientSecretHash }, createdBy);
      return { client: toPublicApiClient(row), clientSecret };
    },

    async listApiClients() {
      const rows = await repo.listApiClients();
      return rows.map(toPublicApiClient);
    },

    async revokeApiClient(id: string) {
      const row = await repo.revokeApiClient(id);
      if (!row) throw new ApiClientNotFoundError(id);
      return toPublicApiClient(row);
    },

    async issueToken(clientId: string, clientSecret: string) {
      const client = await repo.findApiClientById(clientId);
      if (!client || !client.active) throw new InvalidClientCredentialsError();

      const valid = await bcrypt.compare(clientSecret, client.clientSecretHash);
      if (!valid) throw new InvalidClientCredentialsError();

      const payload: ClientTokenPayload = { sub: client.id, type: "client" };
      const accessToken = jwt.sign(payload, jwtSecret, { expiresIn: CLIENT_TOKEN_EXPIRES_IN });
      return { accessToken, tokenType: "Bearer" as const, expiresIn: CLIENT_TOKEN_EXPIRES_IN_SECONDS };
    },

    async verifyClientToken(token: string): Promise<PublicApiClient | null> {
      let payload: ClientTokenPayload;
      try {
        payload = jwt.verify(token, jwtSecret) as ClientTokenPayload;
      } catch {
        return null;
      }
      if (payload.type !== "client") return null;

      const client = await repo.findApiClientById(payload.sub);
      if (!client || !client.active) return null;
      return toPublicApiClient(client);
    },
  };
}

export type OAuthService = ReturnType<typeof createOAuthService>;
