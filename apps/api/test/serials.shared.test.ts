import { describe, expect, it } from "vitest";
import { compressSerialNumbers, serialNumberRuns, sortSerialNumbers } from "@navet/shared";

describe("compressSerialNumbers", () => {
  it("writes an unbroken run of three or more as a range", () => {
    const numbers = Array.from({ length: 10 }, (_, i) => `SN-00${1001 + i}`);
    expect(compressSerialNumbers([...numbers, "SN-001015"])).toBe("SN-001001–SN-001010, SN-001015");
  });

  it("writes two in a row one by one", () => {
    expect(compressSerialNumbers(["SN-2", "SN-1", "SN-5"])).toBe("SN-1, SN-2, SN-5");
  });

  it("sorts naturally whatever order the numbers come in, and drops repeats", () => {
    expect(compressSerialNumbers(["SN-10", "SN-9", "SN-2", "SN-9"])).toBe("SN-2, SN-9, SN-10");
    expect(sortSerialNumbers(["b2", "a10", "a9"])).toEqual(["a9", "a10", "b2"]);
  });

  it("never joins numbers of different digit width or prefix", () => {
    // 9 → 10 changes the width: not the same series of labels.
    expect(compressSerialNumbers(["A8", "A9", "A10", "A11", "A12"])).toBe("A8, A9, A10–A12");
    expect(compressSerialNumbers(["A-1", "A-2", "B-3", "B-4", "B-5"])).toBe("A-1, A-2, B-3–B-5");
    expect(compressSerialNumbers(["A-1", "a-2", "A-3"])).toBe("A-1, a-2, A-3");
  });

  it("handles numbers without digits, pure digits and very long ones", () => {
    expect(compressSerialNumbers(["XYZ", "ABC"])).toBe("ABC, XYZ");
    expect(compressSerialNumbers(["7", "5", "6"])).toBe("5–7");
    expect(compressSerialNumbers(["12345678901234567890", "12345678901234567891", "12345678901234567892"])).toBe(
      "12345678901234567890–12345678901234567892"
    );
    expect(compressSerialNumbers([])).toBe("");
  });

  it("gives the runs behind the text", () => {
    expect(serialNumberRuns(["SN-3", "SN-1", "SN-2", "X"])).toEqual([
      { first: "SN-1", last: "SN-3", count: 3 },
      { first: "X", last: "X", count: 1 },
    ]);
  });
});
