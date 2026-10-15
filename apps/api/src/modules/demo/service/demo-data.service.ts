import { sql } from "drizzle-orm";
import type { Db } from "@navet/db";
import { findDemoBlockers, writeDemoData, type DemoBlocker } from "../repository/demo-data.repository.js";
import { DEMO_DATA } from "./demo-data.js";

export class DemoDataNotAvailableError extends Error {
  constructor(readonly blockers: DemoBlocker[]) {
    super(`Demo data needs empty registers — not empty: ${blockers.join(", ")}`);
    this.name = "DemoDataNotAvailableError";
  }
}

// System → Exempeldata: creates the made-up company of demo-data.ts on an
// installation whose article, customer, supplier and work-center registers
// are all empty. One transaction; the advisory lock queues a double click.
export function createDemoDataService(db: Db) {
  return {
    async status() {
      const blockers = await findDemoBlockers(db);
      return { available: blockers.length === 0, blockers };
    },

    async create(userId: string | null) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('demo_data'))`);
        const blockers = await findDemoBlockers(tx);
        if (blockers.length > 0) throw new DemoDataNotAvailableError(blockers);
        return writeDemoData(tx, DEMO_DATA, userId);
      });
    },
  };
}

export type DemoDataService = ReturnType<typeof createDemoDataService>;
