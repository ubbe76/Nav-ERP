import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  accounts,
  articles,
  auditLog,
  companyInfo,
  customers,
  deliveryTerms,
  fiscalYears,
  paymentTerms,
  suppliers,
  systemSettings,
  users,
  workCenters,
  type Db,
} from "@navet/db";
import type { OnboardingFacts } from "../service/onboarding.js";

// The one stored onboarding fact — everything else is read from the data.
export const NUMBER_SERIES_REVIEWED_KEY = "onboarding_number_series_reviewed";
const SMTP_HOST_KEY = "smtp_host";

type IdTable =
  | typeof articles
  | typeof customers
  | typeof suppliers
  | typeof workCenters
  | typeof paymentTerms
  | typeof deliveryTerms
  | typeof fiscalYears
  | typeof accounts;

export async function readOnboardingFacts(db: Db): Promise<OnboardingFacts> {
  const exists = async (table: IdTable) => (await db.select({ id: table.id }).from(table).limit(1)).length > 0;
  const [company] = await db.select({ name: companyInfo.name, orgNumber: companyInfo.orgNumber }).from(companyInfo).limit(1);
  const [userCount] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.active, true), isNull(users.deletedAt)));
  const settings = await db
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, [SMTP_HOST_KEY, NUMBER_SERIES_REVIEWED_KEY]));
  const setting = (key: string) => settings.find((s) => s.key === key)?.value ?? null;

  return {
    companyName: company?.name ?? "",
    companyOrgNumber: company?.orgNumber ?? null,
    activeUsers: Number(userCount?.n ?? 0),
    hasArticles: await exists(articles),
    hasCustomers: await exists(customers),
    hasSuppliers: await exists(suppliers),
    hasWorkCenters: await exists(workCenters),
    hasPaymentTerms: await exists(paymentTerms),
    hasDeliveryTerms: await exists(deliveryTerms),
    numberSeriesReviewed: setting(NUMBER_SERIES_REVIEWED_KEY) === "true",
    hasFiscalYear: await exists(fiscalYears),
    hasAccounts: await exists(accounts),
    smtpHost: setting(SMTP_HOST_KEY),
  };
}

export async function markNumberSeriesReviewed(db: Db, userId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(systemSettings)
      .values({ key: NUMBER_SERIES_REVIEWED_KEY, value: "true" })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: "true" } });
    await tx.insert(auditLog).values({
      entityType: "system_settings",
      entityId: NUMBER_SERIES_REVIEWED_KEY,
      action: "onboarding_number_series_reviewed",
      userId,
    });
  });
}
