import { randomInt, timingSafeEqual } from "node:crypto";

// One-time setup code for the bootstrap registration (/auth/register).
//
// Without it, whoever reaches /register first on a fresh installation becomes
// administrator — and on a VPS the port is open from the first
// `docker compose up`. The code proves the person registering can read the
// server's logs (`docker compose logs api`) or its .env.
//
// SETUP_CODE in the environment fixes the code (scripted installs, tests);
// otherwise a random one is drawn per process, so a restart logs a new one.
// 12 characters from a 31-letter alphabet without look-alikes (0/O, 1/I/L)
// is ~59 bits — far beyond online guessing.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface SetupCode {
  /** The code in display form, e.g. "K7QM-2XRA-P9TD". */
  readonly code: string;
  /** True when the code came from SETUP_CODE (then it is not logged). */
  readonly fromEnvironment: boolean;
  matches(input: string | undefined): boolean;
}

// Case, spaces and dashes are presentation only.
function normalize(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

function generate(): string {
  let raw = "";
  for (let i = 0; i < 12; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function createSetupCode(fixed: string | undefined = process.env.SETUP_CODE): SetupCode {
  const fromEnvironment = Boolean(fixed?.trim());
  const code = fromEnvironment ? fixed!.trim() : generate();
  const expected = Buffer.from(normalize(code));
  return {
    code,
    fromEnvironment,
    matches(input) {
      if (!input) return false;
      const given = Buffer.from(normalize(input));
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}

// app.ts decorates the Fastify instance so server.ts can print the code at
// start, next to the question whether any user exists yet.
declare module "fastify" {
  interface FastifyInstance {
    setup: { code: SetupCode; needsSetup: () => Promise<boolean> };
  }
}
