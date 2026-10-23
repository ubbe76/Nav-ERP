import { and, eq, isNull, ne, notExists, sql } from "drizzle-orm";
import { alertDigestRuns, holidays, permissionGroups, userSettings, users, type Db } from "@navet/db";
import type { UserRole } from "@navet/shared";

// Den dagliga sammanställningen — the database side of the digest job: who
// gets one today, whether today is a full-day holiday, and the run log that
// is the job's reservation (one row per user and day).

// The user_settings keys the auth module writes (user-settings.service.ts).
const ALERT_DIGEST_KEY = "alert_digest";
const ALERT_DIGEST_KINDS_KEY = "alert_digest_kinds";

export type DigestRunStatus = "claimed" | "sent" | "empty" | "failed";

export interface DigestRecipient {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  // The group's raw permission list — expanded with effectivePermissions,
  // exactly as the session user is built.
  groupPermissions: string[] | null;
  // The stored alert_digest_kinds value, undefined when never set.
  alertDigestKindsRaw: string | undefined;
}

export function createAlertDigestRepository(db: Db) {
  const digestSetting = sql`exists (select 1 from ${userSettings} s
    where s.user_id = ${users.id} and s.key = ${ALERT_DIGEST_KEY} and s.value = 'true')`;

  return {
    // Active, not deleted, with an e-mail address, opted in, and without a
    // run row for the day (sent, empty, failed or merely claimed — a row is
    // a row; nothing is retried the same day).
    async recipients(digestDate: string): Promise<DigestRecipient[]> {
      const rows = await db
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          groupPermissions: permissionGroups.permissions,
          alertDigestKindsRaw: sql<string | null>`(select s.value from ${userSettings} s
            where s.user_id = ${users.id} and s.key = ${ALERT_DIGEST_KINDS_KEY})`,
        })
        .from(users)
        .leftJoin(permissionGroups, eq(users.permissionGroupId, permissionGroups.id))
        .where(
          and(
            eq(users.active, true),
            isNull(users.deletedAt),
            // Tillägg: a plugin's technical user never gets the digest.
            eq(users.kind, "person"),
            ne(users.email, ""),
            digestSetting,
            notExists(
              db
                .select({ one: sql`1` })
                .from(alertDigestRuns)
                .where(and(eq(alertDigestRuns.userId, users.id), eq(alertDigestRuns.digestDate, digestDate)))
            )
          )
        )
        .orderBy(users.email);
      return rows.map((r) => ({ ...r, alertDigestKindsRaw: r.alertDigestKindsRaw ?? undefined }));
    },

    // A holiday WITHOUT a day schedule is a full day off (the same rule as
    // loadDeliveryContext); one with a schedule is a short working day.
    async isFullDayHoliday(date: string): Promise<boolean> {
      const [row] = await db
        .select({ id: holidays.id })
        .from(holidays)
        .where(and(eq(holidays.date, date), isNull(holidays.dayScheduleId)))
        .limit(1);
      return row !== undefined;
    },

    // The reservation: the unique (user_id, digest_date) makes the insert
    // the only writer's — a second process or tick gets nothing back and
    // sends nothing.
    async claimRun(userId: string, digestDate: string): Promise<string | null> {
      const [row] = await db
        .insert(alertDigestRuns)
        .values({ userId, digestDate, status: "claimed" })
        .onConflictDoNothing({ target: [alertDigestRuns.userId, alertDigestRuns.digestDate] })
        .returning({ id: alertDigestRuns.id });
      return row?.id ?? null;
    },

    async finishRun(id: string, outcome: { status: Exclude<DigestRunStatus, "claimed">; alertCount: number; emailLogId: string | null }) {
      await db
        .update(alertDigestRuns)
        .set({ status: outcome.status, alertCount: outcome.alertCount, emailLogId: outcome.emailLogId })
        .where(eq(alertDigestRuns.id, id));
    },
  };
}

export type AlertDigestRepository = ReturnType<typeof createAlertDigestRepository>;
