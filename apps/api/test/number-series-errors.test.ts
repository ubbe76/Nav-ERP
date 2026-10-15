import { describe, expect, it } from "vitest";
import {
  getNextOrderNumber,
  insertWithSeriesNumber,
  NumberSeriesNotConfiguredError,
  SeriesExhaustedError,
} from "../src/modules/system/service/number-series.js";

// DB-free unit tests for the two previously untested throw branches — the db
// argument is stubbed with just the fluent surface getNextOrderNumber uses.

function stubDb(rows: unknown[]) {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => rows,
        }),
      }),
    }),
  } as never;
}

// Postgres unique-violation shape as isUniqueViolation sees it.
const uniqueViolation = () => Object.assign(new Error("duplicate key value"), { code: "23505" });

describe("number series error branches", () => {
  it("throws a named error when the series is not configured", async () => {
    await expect(getNextOrderNumber(stubDb([]), "saknas")).rejects.toBeInstanceOf(NumberSeriesNotConfiguredError);
  });

  it("retries past taken numbers and returns the first free one", async () => {
    let calls = 0;
    const result = await insertWithSeriesNumber(
      stubDb([{ nextNumber: 1002, digits: 0, prefix: "" }]),
      "customer",
      async (issued) => {
        calls += 1;
        if (calls < 3) throw uniqueViolation();
        return issued;
      }
    );
    expect(calls).toBe(3);
    expect(result).toBe("1001");
  });

  it("throws SeriesExhaustedError naming the series after exhausting the retries", async () => {
    await expect(
      insertWithSeriesNumber(stubDb([{ nextNumber: 1, digits: 0, prefix: "" }]), "customer", async () => {
        throw uniqueViolation();
      })
    ).rejects.toBeInstanceOf(SeriesExhaustedError);
    await expect(
      insertWithSeriesNumber(stubDb([{ nextNumber: 1, digits: 0, prefix: "" }]), "customer", async () => {
        throw uniqueViolation();
      })
    ).rejects.toThrow(/customer/);
  });

  it("rethrows non-unique-violation errors immediately without retrying", async () => {
    let calls = 0;
    await expect(
      insertWithSeriesNumber(stubDb([{ nextNumber: 1, digits: 0, prefix: "" }]), "customer", async () => {
        calls += 1;
        throw new Error("something else");
      })
    ).rejects.toThrow("something else");
    expect(calls).toBe(1);
  });
});
