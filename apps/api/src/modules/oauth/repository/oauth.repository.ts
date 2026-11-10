import { eq } from "drizzle-orm";
import { apiClients, auditLog, customers, type Db } from "@navet/db";

export function createOAuthRepository(db: Db) {
  return {
    async createApiClient(
      input: { name: string; clientSecretHash: string; scopes: string[]; customerId: string | null },
      createdBy: string
    ) {
      // Logged with the client in one transaction (granskningen 2026-11-10:
      // only PATCH was) — a new client is new access to the API.
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(apiClients)
          .values({
            name: input.name,
            clientSecretHash: input.clientSecretHash,
            scopes: input.scopes,
            customerId: input.customerId,
            createdBy,
          })
          .returning();
        await tx.insert(auditLog).values({
          entityType: "api_client",
          entityId: row!.id,
          action: "created",
          detail: { name: row!.name, scopes: row!.scopes, customerId: row!.customerId },
          userId: createdBy,
        });
        return row!;
      });
    },

    async findApiClientById(id: string) {
      const [row] = await db.select().from(apiClients).where(eq(apiClients.id, id));
      return row ?? null;
    },

    // The bound customer as the admin page shows it; null = no such customer.
    async customerSummary(id: string) {
      const [row] = await db
        .select({ id: customers.id, customerNumber: customers.customerNumber, name: customers.name })
        .from(customers)
        .where(eq(customers.id, id));
      return row ?? null;
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
          entityId: before.id,
          action: "updated",
          detail: {
            name: before.name,
            before: { scopes: before.scopes, customerId: before.customerId },
            after: { scopes: after!.scopes, customerId: after!.customerId },
          },
          userId,
        });
        return after!;
      });
    },

    // Logged only when the client actually goes from active to revoked — a
    // repeated Återkalla answers with the row and writes nothing.
    async revokeApiClient(id: string, userId: string | null) {
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(apiClients).where(eq(apiClients.id, id)).for("update");
        if (!before) return null;
        if (!before.active) return before;
        const [row] = await tx.update(apiClients).set({ active: false }).where(eq(apiClients.id, id)).returning();
        await tx.insert(auditLog).values({
          entityType: "api_client",
          entityId: before.id,
          action: "revoked",
          detail: { name: before.name },
          userId,
        });
        return row!;
      });
    },
  };
}

export type OAuthRepository = ReturnType<typeof createOAuthRepository>;
