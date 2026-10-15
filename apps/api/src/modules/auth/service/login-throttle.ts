// Failed-attempt throttle for the credential endpoints (login, OAuth2 token).
//
// Counts FAILURES per key (an e-mail address, an OAuth client id, optionally a
// client IP) in a fixed window; once a key reaches `maxFailures` it is locked
// for `lockMs`, and every attempt on it — even with the right password — is
// refused with LoginThrottledError until the lock runs out. A success clears
// the key, so a user who mistypes a few times is never slowed down.
//
// In memory, per process: the api runs as a single container, and a restart
// forgetting the counters is acceptable for an online-guessing guard. The map
// is bounded (`maxKeys`) because an attacker controls the keys — expired
// entries are pruned first, then the oldest are evicted.

export class LoginThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many failed attempts — try again in ${Math.ceil(retryAfterSeconds / 60)} min`);
    this.name = "LoginThrottledError";
  }
}

export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number | null;
}

export interface LoginThrottle {
  /** Throws LoginThrottledError when any of the keys is locked. */
  assertAllowed(keys: string[]): void;
  recordFailure(keys: string[]): void;
  recordSuccess(keys: string[]): void;
}

export function createLoginThrottle(opts: LoginThrottleOptions = {}): LoginThrottle {
  const maxFailures = opts.maxFailures ?? 10;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const lockMs = opts.lockMs ?? 15 * 60_000;
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function expired(e: Entry, t: number): boolean {
    return e.lockedUntil !== null ? e.lockedUntil <= t : e.windowStart + windowMs <= t;
  }

  function live(key: string, t: number): Entry | undefined {
    const e = entries.get(key);
    if (e && expired(e, t)) {
      entries.delete(key);
      return undefined;
    }
    return e;
  }

  function prune(t: number) {
    if (entries.size < maxKeys) return;
    for (const [key, e] of entries) if (expired(e, t)) entries.delete(key);
    // Map iteration is insertion order, so this drops the oldest keys.
    for (const key of entries.keys()) {
      if (entries.size < maxKeys) break;
      entries.delete(key);
    }
  }

  return {
    assertAllowed(keys) {
      const t = now();
      let retryMs = 0;
      for (const key of keys) {
        const e = live(key, t);
        if (e?.lockedUntil != null) retryMs = Math.max(retryMs, e.lockedUntil - t);
      }
      if (retryMs > 0) throw new LoginThrottledError(Math.ceil(retryMs / 1000));
    },
    recordFailure(keys) {
      const t = now();
      prune(t);
      for (const key of keys) {
        const e = live(key, t);
        if (!e) {
          entries.set(key, { failures: 1, windowStart: t, lockedUntil: maxFailures <= 1 ? t + lockMs : null });
          continue;
        }
        e.failures += 1;
        if (e.failures >= maxFailures && e.lockedUntil === null) e.lockedUntil = t + lockMs;
      }
    },
    recordSuccess(keys) {
      for (const key of keys) entries.delete(key);
    },
  };
}
