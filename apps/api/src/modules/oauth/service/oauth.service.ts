import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { API_CLIENT_SCOPES, type ApiClientScope, type CreateApiClientInput, type UpdateApiClientInput } from "@navet/shared";
import type { OAuthRepository } from "../repository/oauth.repository.js";

const CLIENT_TOKEN_EXPIRES_IN = "1h";
const CLIENT_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;
const SALT_ROUNDS = 12;

export class ApiClientCustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer ${id} not found`);
    this.name = "ApiClientCustomerNotFoundError";
  }
}

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
  // Behörigheter per klient (4.9) — read on every request via verifyClientToken.
  scopes: ApiClientScope[];
  customerId: string | null;
  customer: { id: string; customerNumber: string; name: string } | null;
}

type ApiClientRow = {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  scopes: string[];
  customerId: string | null;
};

const KNOWN_SCOPES: readonly string[] = API_CLIENT_SCOPES;

function toPublicApiClient(
  row: ApiClientRow,
  customer: PublicApiClient["customer"] = null
): PublicApiClient {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: row.createdAt,
    // An unknown key (a since-removed scope) grants nothing.
    scopes: row.scopes.filter((s): s is ApiClientScope => KNOWN_SCOPES.includes(s)),
    customerId: row.customerId,
    customer,
  };
}

export function createOAuthService(repo: OAuthRepository, jwtSecret: string) {
  return {
    // Returns the plaintext secret ONCE — only the bcrypt hash is stored.
    async createApiClient(input: CreateApiClientInput, createdBy: string) {
      const customerId = input.customerId ?? null;
      const customer = customerId ? await repo.customerSummary(customerId) : null;
      if (customerId && !customer) throw new ApiClientCustomerNotFoundError(customerId);
      const clientSecret = crypto.randomBytes(32).toString("hex");
      const clientSecretHash = await bcrypt.hash(clientSecret, SALT_ROUNDS);
      const row = await repo.createApiClient({ name: input.name, clientSecretHash, scopes: input.scopes, customerId }, createdBy);
      return { client: toPublicApiClient(row, customer), clientSecret };
    },

    async updateApiClient(id: string, input: UpdateApiClientInput, userId: string | null) {
      if (input.customerId && !(await repo.customerSummary(input.customerId))) {
        throw new ApiClientCustomerNotFoundError(input.customerId);
      }
      const row = await repo.updateApiClient(
        id,
        {
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        },
        userId
      );
      if (!row) throw new ApiClientNotFoundError(id);
      return toPublicApiClient(row, row.customerId ? await repo.customerSummary(row.customerId) : null);
    },

    async listApiClients() {
      const rows = await repo.listApiClientsWithCustomer();
      return rows.map((r) =>
        toPublicApiClient(
          r.client,
          r.client.customerId && r.customerNumber && r.customerName
            ? { id: r.client.customerId, customerNumber: r.customerNumber, name: r.customerName }
            : null
        )
      );
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
