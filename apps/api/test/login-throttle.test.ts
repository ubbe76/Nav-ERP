import { describe, expect, it } from "vitest";
import { createLoginThrottle, LoginThrottledError } from "../src/modules/auth/service/login-throttle.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const MIN = 60_000;

describe("login throttle", () => {
  it("locks a key at maxFailures and refuses every attempt until the lock runs out", () => {
    const c = clock();
    const throttle = createLoginThrottle({ maxFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, now: c.now });
    const key = ["login:a@example.com"];

    throttle.recordFailure(key);
    throttle.recordFailure(key);
    expect(() => throttle.assertAllowed(key)).not.toThrow();
    throttle.recordFailure(key);

    let err: unknown;
    try {
      throttle.assertAllowed(key);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LoginThrottledError);
    expect((err as LoginThrottledError).retryAfterSeconds).toBe(15 * 60);

    c.advance(10 * MIN);
    expect(() => throttle.assertAllowed(key)).toThrow(LoginThrottledError);
    c.advance(5 * MIN);
    expect(() => throttle.assertAllowed(key)).not.toThrow();
    // The lock expiring also resets the count — one more failure does not relock.
    throttle.recordFailure(key);
    expect(() => throttle.assertAllowed(key)).not.toThrow();
  });

  it("forgets failures older than the window", () => {
    const c = clock();
    const throttle = createLoginThrottle({ maxFailures: 3, windowMs: 15 * MIN, now: c.now });
    const key = ["login:a@example.com"];
    throttle.recordFailure(key);
    throttle.recordFailure(key);
    c.advance(15 * MIN);
    throttle.recordFailure(key);
    expect(() => throttle.assertAllowed(key)).not.toThrow();
  });

  it("clears a key on success and keeps keys independent", () => {
    const throttle = createLoginThrottle({ maxFailures: 2 });
    throttle.recordFailure(["login:a@example.com"]);
    throttle.recordSuccess(["login:a@example.com"]);
    throttle.recordFailure(["login:a@example.com"]);
    expect(() => throttle.assertAllowed(["login:a@example.com"])).not.toThrow();

    throttle.recordFailure(["login:b@example.com"]);
    throttle.recordFailure(["login:b@example.com"]);
    expect(() => throttle.assertAllowed(["login:b@example.com"])).toThrow(LoginThrottledError);
    expect(() => throttle.assertAllowed(["login:a@example.com"])).not.toThrow();
  });

  it("stays bounded when an attacker invents keys, evicting the oldest first", () => {
    const throttle = createLoginThrottle({ maxFailures: 1, maxKeys: 3 });
    for (const k of ["k1", "k2", "k3", "k4"]) throttle.recordFailure([k]);
    // k1 was evicted to make room, k4 is locked.
    expect(() => throttle.assertAllowed(["k1"])).not.toThrow();
    expect(() => throttle.assertAllowed(["k4"])).toThrow(LoginThrottledError);
  });
});
