import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

// Global error-handler tests via inject — buildApp constructs services but the
// handler paths exercised here never touch Postgres.

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("global error handler", () => {
  it("maps an empty JSON body to 400 with a code instead of 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-request-body");
  });

  it("maps malformed JSON to 400 as well", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{nöt json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-request-body");
  });

  it("keeps zod validation at 400 and adds a code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
  });
});
