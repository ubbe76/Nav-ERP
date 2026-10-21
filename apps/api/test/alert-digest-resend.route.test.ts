import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, emailLog } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Skicka om on an alert_digest row through the real app: 409 with the
// Swedish text — the digest is that morning's snapshot and the next working
// day brings a fresh one. Also: the CSV export labels the type.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE email_log, alert_digest_runs, user_settings, users, audit_log CASCADE`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
});

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

describe("alert digest in the e-mail log", () => {
  it("Skicka om is refused with 409 and the next-working-day text", async () => {
    const cookie = await adminCookie();
    const [entry] = await db
      .insert(emailLog)
      .values({ documentType: "alert_digest", documentId: null, recipient: "a@example.com", subject: "Nav: 1 sak att bevaka — måndag 4 mars", status: "failed", error: "Connection refused" })
      .returning();
    const res = await app.inject({ method: "POST", url: `/api/v1/email-log/${entry!.id}/resend`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Sammanställningen skickas igen nästa arbetsdag", code: "alert-digest-resend" });
    // Nothing was sent, nothing was logged.
    expect(await db.select().from(emailLog)).toHaveLength(1);
  });

  it("the list and the CSV carry the type", async () => {
    const cookie = await adminCookie();
    await db.insert(emailLog).values({ documentType: "alert_digest", documentId: null, recipient: "a@example.com", subject: "Nav: 2 saker att bevaka — måndag 4 mars", status: "sent" });
    const list = await app.inject({ method: "GET", url: "/api/v1/email-log?documentType=alert_digest", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toHaveLength(1);
    expect(list.json().rows[0]).toMatchObject({ documentType: "alert_digest", linkKind: "alert_digest" });
    const csv = await app.inject({ method: "GET", url: "/api/v1/email-log/csv", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("Aviseringar");
  });
});
