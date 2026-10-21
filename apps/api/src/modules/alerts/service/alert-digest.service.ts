import { effectivePermissions, type AlertGroup, type AlertKind, type AlertsResponse } from "@navet/shared";
import { decodeAlertDigestKinds } from "../../auth/service/user-settings.service.js";
import { MailSendError, type OutgoingMail } from "../../mail/service/mail.service.js";
import { stockholmNow } from "../../shipping/service/pickup.js";
import { isWorkingDay } from "../../system/service/delivery-days.js";
import type { AlertDigestRepository, DigestRecipient } from "../repository/alert-digest.repository.js";
import { sortKinds, visibleKinds } from "./alert-kinds.js";
import { digestItemCount, renderAlertDigestMail } from "./alert-digest-mail.js";

// Den dagliga sammanställningen — the job. Registered in server.ts's
// scheduler list (never in buildApp) and run at every tick: nothing while
// SMTP is unconfigured; otherwise, once the Stockholm clock has passed
// Skicka sammanställningen klockan on a working day, every opted-in user
// without a run row for the day gets one mail. The alerts are computed ONCE
// per run as the union of the recipients' kinds and filtered per recipient;
// a recipient is reserved (claimRun) before anything is sent, so two
// processes or two ticks can never send twice. A failed send is not retried
// that day, and earlier days are never caught up — the run is "today or
// nothing".

export type DigestSkipReason = "smtp" | "before-time" | "not-working-day";

export interface DigestRunResult {
  date: string;
  skipped: DigestSkipReason | null;
  // Per recipient this run handled (claimed by this process).
  outcomes: { userId: string; status: "sent" | "empty" | "failed"; alertCount: number }[];
}

export interface DigestSettingsReader {
  // null while no SMTP host is configured (SystemService.getSmtpConfig).
  smtpConfigured(): Promise<boolean>;
  // Skicka sammanställningen klockan ("HH:MM") and Navs adress ("" = none).
  digestSettings(): Promise<{ digestTime: string; publicBaseUrl: string }>;
}

export interface DigestMailSender {
  sendMail(mail: OutgoingMail): Promise<{ id: string }>;
}

export function createAlertDigestService(deps: {
  repo: AlertDigestRepository;
  alerts: { computeAlerts(kinds: readonly AlertKind[]): Promise<AlertsResponse> };
  mail: DigestMailSender;
  settings: DigestSettingsReader;
  // The current instant; the tests pin it.
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, alerts, mail, settings } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  // visibleKinds(user) ∩ alertDigestKinds (null = all visible). A stored
  // kind the user may no longer see is dropped, never refused.
  function kindsFor(recipient: DigestRecipient): AlertKind[] {
    const visible = visibleKinds({ role: recipient.role, permissions: effectivePermissions(recipient.role, recipient.groupPermissions) });
    const chosen = decodeAlertDigestKinds(recipient.alertDigestKindsRaw);
    return chosen === null ? visible : visible.filter((k) => chosen.includes(k));
  }

  async function sendOne(recipient: DigestRecipient, runId: string, date: string, groups: AlertGroup[], baseUrl: string) {
    const alertCount = digestItemCount(groups);
    if (alertCount === 0) {
      // Nothing to attend to: an empty run, no mail. Error groups are
      // logged for the operator — they are not things to attend to.
      for (const g of groups) if (g.error) log(`Alert digest: ${g.kind} could not be computed`, { message: g.message });
      await repo.finishRun(runId, { status: "empty", alertCount: 0, emailLogId: null });
      return { userId: recipient.userId, status: "empty" as const, alertCount };
    }
    const rendered = renderAlertDigestMail({ date, groups, baseUrl });
    try {
      const logged = await mail.sendMail({
        documentType: "alert_digest",
        documentId: null,
        to: recipient.email,
        subject: rendered.subject,
        message: rendered.text,
        html: rendered.html,
      });
      await repo.finishRun(runId, { status: "sent", alertCount, emailLogId: logged.id });
      return { userId: recipient.userId, status: "sent" as const, alertCount };
    } catch (err) {
      // The failed attempt is in email_log (MailSendError carries the row);
      // anything else — SMTP unconfigured mid-run, a logging failure — is a
      // failed run without a log row. Either way: no retry today.
      const emailLogId = err instanceof MailSendError ? err.emailLogId : null;
      log(`Alert digest to ${recipient.email} failed`, { error: err instanceof Error ? err.message : String(err) });
      await repo.finishRun(runId, { status: "failed", alertCount, emailLogId });
      return { userId: recipient.userId, status: "failed" as const, alertCount };
    }
  }

  async function runDigestIfDue(): Promise<DigestRunResult> {
    const { date, time } = stockholmNow(now());
    if (!(await settings.smtpConfigured())) return { date, skipped: "smtp", outcomes: [] };
    const { digestTime, publicBaseUrl } = await settings.digestSettings();
    // "HH:MM" strings compare as times.
    if (time < digestTime) return { date, skipped: "before-time", outcomes: [] };
    const offDays = (await repo.isFullDayHoliday(date)) ? new Set([date]) : new Set<string>();
    if (!isWorkingDay(date, offDays)) return { date, skipped: "not-working-day", outcomes: [] };

    const recipients = await repo.recipients(date);
    if (recipients.length === 0) return { date, skipped: null, outcomes: [] };

    // Compute once for the union, then filter per recipient.
    const perRecipient = recipients.map((r) => ({ recipient: r, kinds: kindsFor(r) }));
    const union = sortKinds(perRecipient.flatMap((p) => p.kinds));
    const computed = union.length > 0 ? await alerts.computeAlerts(union) : { computedAt: now().toISOString(), groups: [] };

    const outcomes: DigestRunResult["outcomes"] = [];
    for (const { recipient, kinds } of perRecipient) {
      const runId = await repo.claimRun(recipient.userId, date);
      if (runId === null) continue; // another process or tick has this one
      const groups = computed.groups.filter((g) => kinds.includes(g.kind));
      outcomes.push(await sendOne(recipient, runId, date, groups, publicBaseUrl));
    }
    return { date, skipped: null, outcomes };
  }

  return { runDigestIfDue, kindsFor };
}

export type AlertDigestService = ReturnType<typeof createAlertDigestService>;

declare module "fastify" {
  interface FastifyInstance {
    alertDigest: AlertDigestService;
  }
}
