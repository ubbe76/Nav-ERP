import { eq, like } from "drizzle-orm";
import { companyInfo, systemSettings, type Db, type Tx } from "@navet/db";

// Bank settings are bank_* keys in system_settings (key–value, no migration
// per setting — the freight_* pattern); the company's own account numbers
// stay in company_info and are read live, never copied.
export function createBankSettingsRepository(db: Db) {
  return {
    async readSettings(executor: Db | Tx = db): Promise<Map<string, string>> {
      const rows = await executor.select().from(systemSettings).where(like(systemSettings.key, "bank_%"));
      return new Map(rows.map((row) => [row.key, row.value]));
    },
    async setSetting(key: string, value: string | null) {
      if (value === null) {
        await db.delete(systemSettings).where(eq(systemSettings.key, key));
        return;
      }
      await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    },
    async readCompany(executor: Db | Tx = db) {
      const [row] = await executor
        .select({
          name: companyInfo.name,
          orgNumber: companyInfo.orgNumber,
          postalCode: companyInfo.postalCode,
          city: companyInfo.city,
          iban: companyInfo.iban,
          bic: companyInfo.bic,
          bankgiro: companyInfo.bankgiro,
          plusgiro: companyInfo.plusgiro,
        })
        .from(companyInfo)
        .limit(1);
      return row ?? { name: "", orgNumber: null, postalCode: null, city: null, iban: null, bic: null, bankgiro: null, plusgiro: null };
    },
  };
}

export type BankSettingsRepository = ReturnType<typeof createBankSettingsRepository>;
