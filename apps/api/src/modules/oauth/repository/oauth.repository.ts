import { eq } from "drizzle-orm";
import { apiClients, auditLog, customers, type Db } from "@navet/db";

export function createOAuthRepository(db: Db) {
  return {
    async createApiClient(
      input: { name: string; clientSecretHash: string; scopes: string[]; customerId: string | null },
      createdBy: string
    ) {
      const [row] = await db
        .insert(apiClients)
        .values({
          name: input.name,
          clientSecretHash: input.clientSecretHash,
          scopes: input.scopes,
          customerId: input.customerId,
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

    async customerExists(id: string) {
      const [row] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, id));
      return Boolean(row);
    },

    // List/lookup with the bound customer's number and name for the admin page.
    async listApiClientsWithCustomer() {
      return db
        .select({ client: apiClients, customerNumber: customers.customerNumber, customerName: customers.name })
        .from(apiClients)
        .leftJoin(customers, eq(customers.id, apiClients.customerId))
        .orderBy(apiClients.createdAt);
    },

    async updateApiClient(id: string, values: { scopes?: string[]; customerId?: string | null }, userId: string | null) {
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(apiClients).where(eq(apiClients.id, id)).for("update");
        if (!before) return null;
        const [after] = await tx.update(apiClients).set(values).where(eq(apiClients.id, id)).returning();
        await tx.insert(auditLog).values({
          entityType: "api_client",
          entityId: before.name,
          action: "updated",
          detail: {
            before: { scopes: before.scopes, customerId: before.customerId },
            after: { scopes: after!.scopes, customerId: after!.customerId },
          },
          userId,
        });
        return after!;
      });
    },

    async revokeApiClient(id: string) {
      const [row] = await db.update(apiClients).set({ active: false }).where(eq(apiClients.id, id)).returning();
      return row ?? null;
    },
  };
}

export type OAuthRepository = ReturnType<typeof createOAuthRepository>;
