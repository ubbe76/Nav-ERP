import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { satisfiesRule, type Permission, type UserRole } from "@navet/shared";
import type { TerminalPinRepository } from "../repository/terminal-pin.repository.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { BCRYPT_ROUNDS } from "../../auth/service/bcrypt-rounds.js";
import { EmployeeNotFoundError, InactiveEmployeeError } from "./timereport.service.js";

// Terminalkod — Kräv kod i stämpelterminalen (migration 0233, timereport.md).
// The employee chooses a four-digit code at the terminal; a right code (or a
// newly chosen one) gives a short-lived bevistoken for that employee and that
// account, and a terminal account's calls for an employee are refused
// without it while the setting is on.

// Five wrong codes in a row lock the employee for fifteen minutes.
export const TERMINAL_PIN_MAX_ATTEMPTS = 5;
export const TERMINAL_PIN_LOCK_MINUTES = 15;
// The bevistoken: long enough for one visit to the terminal — choosing
// operations in a long list, reporting quantities, writing a reply — and the
// terminal throws it away on every return to the keypad (after 60 s without
// a touch at the latest).
export const TERMINAL_PIN_PROOF_SECONDS = 15 * 60;
const PROOF_AUDIENCE = "terminal-pin";

// The terminal sent no (or a stale) proof for the employee it acts for.
export class TerminalPinRequiredError extends Error {
  constructor() {
    super("Ange din kod igen — knappa in anställningsnumret och koden.");
    this.name = "TerminalPinRequiredError";
  }
}

export class TerminalPinWrongError extends Error {
  constructor(readonly attemptsLeft: number) {
    super(attemptsLeft === 1 ? "Fel kod. 1 försök kvar." : `Fel kod. ${attemptsLeft} försök kvar.`);
    this.name = "TerminalPinWrongError";
  }
}

export class TerminalPinLockedError extends Error {
  constructor(readonly lockedUntil: Date) {
    super(
      `För många felaktiga försök — koden är spärrad till kl. ${lockedUntil.toLocaleTimeString("sv-SE", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Stockholm",
      })}. Försök igen då, eller be en administratör nollställa koden.`
    );
    this.name = "TerminalPinLockedError";
  }
}

// Välj en kod when one exists: only an administrator's Nollställ
// terminalkoden opens for a new one.
export class TerminalPinAlreadySetError extends Error {
  constructor() {
    super("En kod är redan vald. Har du glömt den kan en administratör nollställa den.");
    this.name = "TerminalPinAlreadySetError";
  }
}

export class TerminalPinNotSetError extends Error {
  constructor() {
    super("Ingen kod är vald — välj en kod först.");
    this.name = "TerminalPinNotSetError";
  }
}

type Account = { id: string; role: UserRole; permissions?: readonly Permission[] };

interface ProofPayload {
  sub: string; // the employee
  uid: string; // the account that showed the code
  pv: number; // the code's set_at — a reset or a new code ends the token
}

export interface TerminalPinStatus {
  pinSet: boolean;
  lockedUntil: string | null;
}

export interface TerminalPinProof {
  token: string;
  expiresAt: string;
}

// The ways a guarded route names its employee (config.terminalPinEmployee).
export type TerminalPinSubject = "params.id" | "params.employeeId" | "body.employeeId" | "stampSession" | "attendanceSession";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTerminalPinService(
  repo: TerminalPinRepository,
  deps: {
    jwtSecret: string;
    // Kräv kod i stämpelterminalen, read at every guarded call.
    required: () => Promise<boolean>;
    audit: AuditWriter;
    now?: () => Date;
  }
) {
  const clock = deps.now ?? (() => new Date());
  // A key of its own, derived from the session secret: a bevistoken can never
  // be mistaken for a session token or the other way round.
  const secret = `${deps.jwtSecret}:terminal-pin`;

  function issue(employeeId: string, account: Account, setAt: Date): TerminalPinProof {
    const payload: ProofPayload = { sub: employeeId, uid: account.id, pv: setAt.getTime() };
    const token = jwt.sign(payload, secret, { audience: PROOF_AUDIENCE, expiresIn: TERMINAL_PIN_PROOF_SECONDS });
    return { token, expiresAt: new Date(Date.now() + TERMINAL_PIN_PROOF_SECONDS * 1000).toISOString() };
  }

  // The employee a code is chosen or shown for: known, active, not anonymized.
  async function activeEmployee(employeeId: string) {
    const employee = await repo.findEmployee(repo.db, employeeId);
    if (!employee || employee.anonymizedAt) throw new EmployeeNotFoundError(employeeId);
    if (!employee.active) throw new InactiveEmployeeError();
    return employee;
  }

  return {
    // Whom the guard is for: the workshop profile — an account without any
    // menu (a terminal account). Office users reach the same routes through
    // their ordinary permissions (Pågående arbete, the personnel card) and
    // are never asked for a proof.
    guards(account: Account): boolean {
      return !satisfiesRule(account, ["office"]);
    },

    required: deps.required,

    // What the terminal needs to show the right step after the number:
    // whether a code is chosen and whether it is locked. Nothing else.
    async status(employeeId: string): Promise<TerminalPinStatus> {
      const employee = await repo.findEmployee(repo.db, employeeId);
      if (!employee) throw new EmployeeNotFoundError(employeeId);
      const pin = await repo.findPin(employeeId);
      const locked = pin?.lockedUntil && pin.lockedUntil > clock() ? pin.lockedUntil : null;
      return { pinSet: pin !== null, lockedUntil: locked ? locked.toISOString() : null };
    },

    // Välj en kod — the first time, and after Nollställ terminalkoden.
    async choose(employeeId: string, pin: string, account: Account): Promise<TerminalPinProof> {
      const employee = await activeEmployee(employeeId);
      if (await repo.findPin(employeeId)) throw new TerminalPinAlreadySetError();
      const created = await repo.insertPin(employeeId, await bcrypt.hash(pin, BCRYPT_ROUNDS));
      if (!created) throw new TerminalPinAlreadySetError();
      await deps.audit.log({
        entityType: "employee",
        entityId: employeeId,
        action: "terminal_pin_set",
        detail: { employeeNumber: employee.employeeNumber },
        userId: account.id,
      });
      return issue(employeeId, account, created.setAt);
    },

    // The code after the anställningsnummer. Counted under the pin row's
    // lock; the count is committed before the error is thrown.
    async verify(employeeId: string, pin: string, account: Account): Promise<TerminalPinProof> {
      const employee = await activeEmployee(employeeId);
      const outcome = await repo.transaction(async (tx) => {
        const row = await repo.lockPin(tx, employeeId);
        if (!row) return { kind: "not-set" as const };
        const now = clock();
        if (row.lockedUntil && row.lockedUntil > now) return { kind: "locked" as const, lockedUntil: row.lockedUntil, fresh: false };
        if (await bcrypt.compare(pin, row.pinHash)) {
          if (row.failedAttempts !== 0 || row.lockedUntil) await repo.recordSuccess(tx, employeeId);
          return { kind: "ok" as const, setAt: row.setAt };
        }
        const failed = row.failedAttempts + 1;
        if (failed >= TERMINAL_PIN_MAX_ATTEMPTS) {
          // The counter starts over: when the spärr has run out the employee
          // has five new attempts.
          const lockedUntil = new Date(now.getTime() + TERMINAL_PIN_LOCK_MINUTES * 60_000);
          await repo.recordFailure(tx, employeeId, 0, lockedUntil);
          return { kind: "locked" as const, lockedUntil, fresh: true };
        }
        await repo.recordFailure(tx, employeeId, failed, null);
        return { kind: "wrong" as const, attemptsLeft: TERMINAL_PIN_MAX_ATTEMPTS - failed };
      });
      if (outcome.kind === "ok") return issue(employeeId, account, outcome.setAt);
      if (outcome.kind === "not-set") throw new TerminalPinNotSetError();
      if (outcome.kind === "wrong") throw new TerminalPinWrongError(outcome.attemptsLeft);
      if (outcome.fresh) {
        await deps.audit.log({
          entityType: "employee",
          entityId: employeeId,
          action: "terminal_pin_locked",
          detail: { employeeNumber: employee.employeeNumber, lockedUntil: outcome.lockedUntil.toISOString() },
          userId: account.id,
        });
      }
      throw new TerminalPinLockedError(outcome.lockedUntil);
    },

    // Nollställ terminalkoden (the personnel card): the code, the counter and
    // the spärr go; the employee chooses a new code at the next number.
    async reset(employeeId: string, userId: string): Promise<TerminalPinStatus> {
      const employee = await repo.findEmployee(repo.db, employeeId);
      if (!employee) throw new EmployeeNotFoundError(employeeId);
      if (await repo.deletePin(employeeId)) {
        await deps.audit.log({
          entityType: "employee",
          entityId: employeeId,
          action: "terminal_pin_reset",
          detail: { employeeNumber: employee.employeeNumber },
          userId,
        });
      }
      return { pinSet: false, lockedUntil: null };
    },

    // The employee a guarded request acts for; null when it names none that
    // can be looked up (the guard then refuses — fail closed).
    async subjectOf(subject: TerminalPinSubject, req: { params: unknown; body: unknown }): Promise<string | null> {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uuid = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : null);
      if (subject === "params.id") return uuid(params.id);
      if (subject === "params.employeeId") return uuid(params.employeeId);
      if (subject === "body.employeeId") return uuid(body.employeeId);
      const sessionId = uuid(params.id);
      if (!sessionId) return null;
      return subject === "stampSession" ? repo.employeeOfStampSession(sessionId) : repo.employeeOfAttendanceSession(sessionId);
    },

    // True when the token proves that this account showed this employee's
    // CURRENT code within the validity time.
    async proves(token: string | undefined, account: Account, employeeId: string): Promise<boolean> {
      if (!token) return false;
      let payload: ProofPayload;
      try {
        payload = jwt.verify(token, secret, { audience: PROOF_AUDIENCE }) as unknown as ProofPayload;
      } catch {
        return false;
      }
      if (payload.sub !== employeeId || payload.uid !== account.id) return false;
      const pin = await repo.findPin(employeeId);
      return pin !== null && pin.setAt.getTime() === payload.pv;
    },
  };
}

export type TerminalPinService = ReturnType<typeof createTerminalPinService>;
