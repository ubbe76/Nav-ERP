import { eq } from "drizzle-orm";
import { apiClients, type Db } from "@navet/db";

export function createOAuthRepository(db: Db) {
  return {
    async createApiClient(input: { name: string; clientSecretHash: string }, createdBy: string) {
      const [row] = await db
        .insert(apiClients)
        .values({
          name: input.name,
          clientSecretHash: input.clientSecretHash,
          createdBy,
        })
        .returning();
      return row!;
    },

    async findApiClientById(id: string) {
      const [row] = await db.select().from(apiClients).where(eq(apiClients.id, id));
      return row ?? null;
    },

    async listApiClients() {
      return db.select().from(apiClients);
    },

    async revokeApiClient(id: string) {
      const [row] = await db.update(apiClients).set({ active: false }).where(eq(apiClients.id, id)).returning();
      return row ?? null;
    },
  };
}

export type OAuthRepository = ReturnType<typeof createOAuthRepository>;
