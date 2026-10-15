// apps/api/test/configurator-formula.test.ts
// Pure tests for the configurator formula language (quantities and times derived from a configuration).
import { describe, expect, it } from "vitest";
import {
  evaluateFormula, formulaReferences, parseFormula, validateFormula,
  type FormulaGroupInfo, type FormulaValues,
} from "../src/modules/configurator/service/configurator-formula.js";

const groups: FormulaGroupInfo[] = [
  { code: "BREDD", kind: "number", valueCodes: [] },
  { code: "DJUP", kind: "number", valueCodes: [] },
  { code: "HJUL", kind: "boolean", valueCodes: [] },
  { code: "FARG", kind: "choice", valueCodes: ["EP", "RD"] },
];

function vals(input: {
  BREDD?: number | null; DJUP?: number | null; HJUL?: boolean | null; FARG?: string | null;
} = {}): FormulaValues {
  const m: FormulaValues = new Map();
  m.set("BREDD", { kind: "number", value: input.BREDD === undefined ? 1000 : input.BREDD });
  m.set("DJUP", { kind: "number", value: input.DJUP === undefined ? 600 : input.DJUP });
  m.set("HJUL", { kind: "boolean", value: input.HJUL === undefined ? false : input.HJUL });
  m.set("FARG", { kind: "choice", value: input.FARG === undefined ? "EP" : input.FARG });
  return m;
}

function num(source: string, values: FormulaValues = vals()): number {
  const r = evaluateFormula(source, values);
  if (!r.ok) throw new Error(`expected a value for ${source}, got: ${r.message}`);
  return r.value;
}

function evalError(source: string, values: FormulaValues = vals()): string {
  const r = evaluateFormula(source, values);
  if (r.ok) throw new Error(`expected an error for ${source}, got ${r.value}`);
  return r.message;
}

function validationMessage(source: string): string | null {
  return validateFormula(source, groups)?.message ?? null;
}

describe("evaluateFormula — arithmetic", () => {
  it("follows operator precedence and parentheses", () => {
    expect(num("2 + 3 * 4")).toBe(14);
    expect(num("(2 + 3) * 4")).toBe(20);
    expect(num("-BREDD + 10", vals({ BREDD: 4 }))).toBe(6);
    expect(num("10 / 4")).toBe(2.5);
    expect(num("10 - 4 - 3")).toBe(3);
    expect(num("24 / 4 / 2")).toBe(3);
    expect(num("+5 - -2")).toBe(7);
  });

  it("treats a comma between digits as decimal separator and ';' as argument separator", () => {
    expect(num("max(1,5; 2)")).toBe(2);
    expect(num("min(1;2)")).toBe(1);
    expect(num("avrunda(1,25;1)")).toBe(1.3);
    expect(num("1,5 * 2")).toBe(3);
    expect(num("1.5 * 2")).toBe(3);
    expect(num("avrunda(2,5)")).toBe(3);
    expect(num("avrunda(-2,5)")).toBe(-3);
    expect(num("max(1; 7; 3)")).toBe(7);
    expect(num("min(4; -1; 3)")).toBe(-1);
  });

  it("rounds with avrunda half away from zero, also at decimals", () => {
    expect(num("avrunda(1,005; 2)")).toBe(1.01);
    expect(num("avrunda(-1,25; 1)")).toBe(-1.3);
    expect(num("avrunda(1,23456; 4)")).toBe(1.2346);
    expect(num("avrunda(7,5; 0)")).toBe(8);
  });

  it("rounds up and down to a step", () => {
    expect(num("avrunda_upp(BREDD / 600; 1)", vals({ BREDD: 1300 }))).toBe(3);
    expect(num("avrunda_upp(1,1; 0,25)")).toBe(1.25);
    expect(num("avrunda_ned(1,3; 0,25)")).toBe(1.25);
    expect(num("avrunda_ned(1,5; 0,5)")).toBe(1.5);
    expect(num("avrunda_upp(1,5; 0,5)")).toBe(1.5);
  });

  it("evaluates om with a choice comparison, a measure comparison and a boolean comparison", () => {
    expect(num('om(FARG = "EP"; 12; 8)', vals({ FARG: "EP" }))).toBe(12);
    expect(num('om(FARG = "EP"; 12; 8)', vals({ FARG: "RD" }))).toBe(8);
    expect(num('om(FARG <> "EP"; 12; 8)', vals({ FARG: "RD" }))).toBe(12);
    expect(num("om(BREDD > 2000; 2; 1)", vals({ BREDD: 2400 }))).toBe(2);
    expect(num("om(BREDD > 2000; 2; 1)", vals({ BREDD: 2000 }))).toBe(1);
    expect(num("om(BREDD >= 2000; 2; 1)", vals({ BREDD: 2000 }))).toBe(2);
    expect(num("om(BREDD <= 2000; 2; 1)", vals({ BREDD: 2000 }))).toBe(2);
    expect(num("om(BREDD < 2000; 2; 1)", vals({ BREDD: 2000 }))).toBe(1);
    expect(num("om(BREDD <> 2000; 2; 1)", vals({ BREDD: 2000 }))).toBe(1);
    expect(num("om(HJUL = 1; 4; 0)", vals({ HJUL: true }))).toBe(4);
    expect(num("om(HJUL = 1; 4; 0)", vals({ HJUL: false }))).toBe(0);
  });

  it("never treats a choice without a value as equal", () => {
    expect(num('om(FARG = "EP"; 12; 8)', vals({ FARG: null }))).toBe(8);
    expect(num('om(FARG <> "EP"; 12; 8)', vals({ FARG: null }))).toBe(12);
  });

  it("evaluates only the chosen om branch", () => {
    expect(num("om(BREDD > 0; 5; 1 / 0)")).toBe(5);
  });

  it("gives a boolean 1 or 0 and reads codes case-insensitively", () => {
    expect(num("HJUL * 250", vals({ HJUL: true }))).toBe(250);
    expect(num("HJUL * 250", vals({ HJUL: false }))).toBe(0);
    expect(num("BREDD * DJUP / 1000000", vals({ BREDD: 1200, DJUP: 600 }))).toBe(0.72);
    expect(num("bredd * 2", vals({ BREDD: 1200 }))).toBe(2400);
    expect(num("MAX(Bredd; 3)", vals({ BREDD: 2 }))).toBe(3);
  });

  it("rounds the result to 4 decimals", () => {
    expect(num("1 / 3")).toBe(0.3333);
    expect(num("0,1 + 0,2")).toBe(0.3);
  });
});

describe("evaluateFormula — errors", () => {
  it("rejects scientific notation", () => {
    expect(evaluateFormula("1e308", vals()).ok).toBe(false);
    expect(validateFormula("1e308", groups)).not.toBeNull();
    expect(validateFormula("1.5e3", groups)).not.toBeNull();
  });

  it("rejects a non-finite result", () => {
    const huge = Array.from({ length: 34 }, () => "9999999999").join(" * ");
    expect(evalError(huge)).toBe("Resultatet är inte ett giltigt tal");
  });

  it("rejects division by zero", () => {
    expect(evalError("1 / 0")).toBe("Division med noll");
    expect(evalError("BREDD / (DJUP - 600)")).toBe("Division med noll");
  });

  it("rejects a measure without a value", () => {
    expect(evalError("BREDD", vals({ BREDD: null }))).toBe("BREDD saknar värde");
    expect(evalError("bredd * 2", vals({ BREDD: null }))).toBe("BREDD saknar värde");
  });

  it("rejects a non-positive step", () => {
    expect(evalError("avrunda_upp(1; DJUP - 600)")).toBe("Steget måste vara större än 0");
    expect(evalError("avrunda_ned(1; DJUP - 700)")).toBe("Steget måste vara större än 0");
  });

  it("rejects decimals outside 0–4 at evaluation when not constant", () => {
    expect(evalError("avrunda(1,5; DJUP - 595)")).toBe("Decimalerna i avrunda måste vara ett heltal 0–4");
    expect(evalError("avrunda(1,5; DJUP / 400)")).toBe("Decimalerna i avrunda måste vara ett heltal 0–4");
  });

  it("rejects a choice in arithmetic and an unknown code at evaluation", () => {
    expect(evalError("FARG + 1")).toBe('FARG är ett listval och kan bara jämföras med en alternativkod');
    expect(evalError("LANGD + 1")).toBe("Okänd kod LANGD");
  });

  it("returns syntax errors as evaluation errors", () => {
    expect(evalError("2 +")).toBe("Formeln slutar oväntat");
  });
});

describe("parseFormula — limits", () => {
  it("allows 32 nested parentheses but not 33", () => {
    const nest = (n: number) => "(".repeat(n) + "1" + ")".repeat(n);
    expect(parseFormula(nest(32)).ok).toBe(true);
    const r = parseFormula(nest(33));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ message: "För djup nästling (tecken 33)", position: 33 });
    expect(evalError(nest(33))).toBe("För djup nästling (tecken 33)");
  });

  it("counts unary signs and function calls as nesting", () => {
    expect(parseFormula("-".repeat(32) + "1").ok).toBe(true);
    expect(validationMessage("-".repeat(33) + "1")).toBe("För djup nästling (tecken 33)");
    const calls = (n: number) => "max(".repeat(n) + "1" + "; 1)".repeat(n);
    expect(parseFormula(calls(32)).ok).toBe(true);
    expect(validationMessage(calls(33))).toBe("För djup nästling (tecken 129)");
  });

  it("allows 500 characters but not 501", () => {
    const ok = "1" + " ".repeat(499);
    expect(ok.length).toBe(500);
    expect(parseFormula(ok).ok).toBe(true);
    const tooLong = "1" + " ".repeat(500);
    expect(validationMessage(tooLong)).toBe("Formeln är för lång (högst 500 tecken)");
    expect(evalError(tooLong)).toBe("Formeln är för lång (högst 500 tecken)");
  });

  it("does not overflow on a long flat chain", () => {
    const chain = Array.from({ length: 250 }, () => "1").join("+");
    expect(chain.length).toBeLessThanOrEqual(500);
    expect(num(chain)).toBe(250);
  });
});

describe("validateFormula", () => {
  it("accepts valid formulas", () => {
    for (const f of [
      "BREDD * DJUP / 1000000", 'om(FARG = "EP"; 12; 8)', "om(HJUL = 1; 4; 0)", "avrunda(BREDD / 3; 2)",
      "avrunda_upp(BREDD / 600; 1)", "avrunda_ned(BREDD; 0,25)", "max(BREDD; 800; DJUP)", "hjul * 250",
      'om(farg = "rd"; 1; 2)',
    ]) {
      expect(validateFormula(f, groups), f).toBeNull();
    }
  });

  it("reports syntax errors with the character position", () => {
    expect(validateFormula("2 # 3", groups)).toEqual({ message: 'Oväntat tecken "#" (tecken 3)', position: 3 });
    expect(validationMessage("2 3")).toBe('Oväntat tecken "3" (tecken 3)');
    expect(validationMessage("max(1, 5)")).toBe('Oväntat tecken "," (tecken 6)');
    expect(validationMessage("(1 + 2")).toBe("Formeln slutar oväntat");
    expect(validationMessage("2 +")).toBe("Formeln slutar oväntat");
    expect(validationMessage("")).toBe("Formeln slutar oväntat");
    expect(validationMessage("1 + )")).toBe('Oväntat tecken ")" (tecken 5)');
    expect(validationMessage(".5")).toBe('Oväntat tecken "." (tecken 1)');
  });

  it("reports an unknown code", () => {
    expect(validateFormula("BREDD*LANGD", groups)).toEqual({ message: "Okänd kod LANGD (tecken 7)", position: 7 });
    expect(validationMessage("2 * langd")).toBe("Okänd kod LANGD (tecken 5)");
  });

  it("rejects a choice in arithmetic or without a comparison", () => {
    expect(validationMessage("FARG * 2")).toBe(
      'FARG är ett listval och kan bara jämföras med en alternativkod, t.ex. FARG = "EP" (tecken 1)',
    );
    expect(validationMessage("om(FARG = 1; 2; 3)")).toBe(
      'FARG är ett listval och kan bara jämföras med en alternativkod, t.ex. FARG = "EP" (tecken 4)',
    );
  });

  it("rejects a string compared with a measure or a boolean, or outside a comparison", () => {
    expect(validationMessage('om(BREDD = "EP"; 1; 2)')).toBe('"EP" kan bara jämföras med ett listval (tecken 12)');
    expect(validationMessage('om(HJUL = "EP"; 1; 2)')).toBe('"EP" kan bara jämföras med ett listval (tecken 11)');
    expect(validationMessage('"EP" + 1')).toBe('"EP" kan bara jämföras med ett listval (tecken 1)');
  });

  it("rejects an unknown value code", () => {
    expect(validationMessage('om(FARG = "XX"; 1; 2)')).toBe('"XX" är inget alternativ i FARG (tecken 11)');
  });

  it("rejects an ordering comparison on a choice", () => {
    expect(validationMessage('om(FARG < "EP"; 1; 2)')).toBe("Ett listval kan bara jämföras med = eller <> (tecken 9)");
  });

  it("rejects an unknown function", () => {
    expect(validationMessage("foo(1)")).toBe("Okänd funktion foo (tecken 1)");
    expect(validationMessage("2 + summa(1; 2)")).toBe("Okänd funktion summa (tecken 5)");
  });

  it("rejects a wrong argument count", () => {
    expect(validationMessage("avrunda(1; 2; 3)")).toBe("avrunda tar 1 eller 2 argument (tecken 1)");
    expect(validationMessage("min(1)")).toBe("min tar minst 2 argument (tecken 1)");
    expect(validationMessage("max(1)")).toBe("max tar minst 2 argument (tecken 1)");
    expect(validationMessage("avrunda_upp(1)")).toBe("avrunda_upp tar exakt 2 argument (tecken 1)");
    expect(validationMessage("avrunda_ned(1; 2; 3)")).toBe("avrunda_ned tar exakt 2 argument (tecken 1)");
    expect(validationMessage("om(BREDD > 1; 2)")).toBe("om tar exakt 3 argument (tecken 1)");
  });

  it("rejects a comparison outside om", () => {
    expect(validationMessage("max(BREDD > 1; 2)")).toBe("Jämförelser är bara tillåtna som första argument i om (tecken 11)");
    expect(validationMessage("om(BREDD > 1; BREDD > 2; 1)")).toBe(
      "Jämförelser är bara tillåtna som första argument i om (tecken 21)",
    );
    expect(validationMessage("BREDD > 1")).toBe("Jämförelser är bara tillåtna som första argument i om (tecken 7)");
  });

  it("rejects om without a comparison", () => {
    expect(validationMessage("om(BREDD; 1; 2)")).toBe("om kräver en jämförelse som första argument (tecken 1)");
  });

  it("checks constant avrunda decimals and steps at save", () => {
    expect(validationMessage("avrunda(BREDD; 5)")).toBe("Decimalerna i avrunda måste vara ett heltal 0–4 (tecken 16)");
    expect(validationMessage("avrunda(BREDD; -1)")).toBe("Decimalerna i avrunda måste vara ett heltal 0–4 (tecken 16)");
    expect(validationMessage("avrunda(BREDD; 1,5)")).toBe("Decimalerna i avrunda måste vara ett heltal 0–4 (tecken 16)");
    expect(validationMessage("avrunda(BREDD; DJUP)")).toBeNull();
    expect(validationMessage("avrunda_upp(BREDD; 0)")).toBe("Steget måste vara större än 0 (tecken 20)");
    expect(validationMessage("avrunda_ned(BREDD; 0 - 1)")).toBe("Steget måste vara större än 0 (tecken 20)");
  });
});

describe("formulaReferences", () => {
  it("collects upper-cased codes", () => {
    expect(formulaReferences('om(FARG = "EP"; BREDD; hjul)')).toEqual(new Set(["FARG", "BREDD", "HJUL"]));
  });

  it("returns an empty set for an unparseable formula", () => {
    expect(formulaReferences("BREDD +")).toEqual(new Set());
  });

  it("does not count function names or strings as references", () => {
    expect(formulaReferences('avrunda_upp(DJUP; 1) + om(FARG = "RD"; 1; 0)')).toEqual(new Set(["DJUP", "FARG"]));
  });
});

describe("robustness", () => {
  it("reports malformed quoted value codes", () => {
    expect(validationMessage('om(FARG = "EP; 1; 2)')).toBe('Oväntat tecken ";" (tecken 14)');
    expect(validationMessage('om(FARG = "EP')).toBe('Oväntat tecken """ (tecken 11)');
    expect(validationMessage('om(FARG = ""; 1; 2)')).toBe('Oväntat tecken """ (tecken 12)');
    expect(validationMessage(`om(FARG = "${"A".repeat(21)}"; 1; 2)`)).toBe('Oväntat tecken "A" (tecken 32)');
    expect(validationMessage("1,5x")).toBe('Oväntat tecken "x" (tecken 4)');
  });

  it("rejects a non-finite intermediate even when the final value would be finite", () => {
    const huge = Array.from({ length: 34 }, () => "9999999999").join(" * ");
    expect(evalError(`(${huge}) * 0`)).toBe("Resultatet är inte ett giltigt tal");
  });

  it("never throws and never returns a non-finite value on arbitrary input", () => {
    const alphabet = ['1', '0', ',', '.', ';', '(', ')', '+', '-', '*', '/', '=', '<', '>', ' ', '"', 'E', 'P',
      'BREDD', 'FARG', 'HJUL', 'om(', 'max(', 'avrunda(', 'avrunda_upp(', 'avrunda_ned(', '9999999999'];
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 3000; n++) {
      const len = 1 + Math.floor(rand() * 25);
      let src = "";
      for (let k = 0; k < len; k++) src += alphabet[Math.floor(rand() * alphabet.length)];
      const r = evaluateFormula(src, vals());
      if (r.ok) expect(Number.isFinite(r.value), src).toBe(true);
      else expect(typeof r.message, src).toBe("string");
      const v = validateFormula(src, groups);
      if (v) expect(v.position, src).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("fix round 1", () => {
  it("rounds both sides of a comparison to 4 decimals", () => {
    expect(num("om(BREDD * 0,07 > 84; 1; 0)", vals({ BREDD: 1200 }))).toBe(0);
    expect(num("om(BREDD - 0,1 - 0,2 = 999,7; 1; 0)", vals({ BREDD: 1000 }))).toBe(1);
    expect(num("om(BREDD * 0,07 >= 84; 1; 0)", vals({ BREDD: 1200 }))).toBe(1);
    expect(num("om(BREDD - 0,1 - 0,2 <> 999,7; 1; 0)", vals({ BREDD: 1000 }))).toBe(0);
  });

  it("rejects a number that is an all-digit group code", () => {
    const withDigits: FormulaGroupInfo[] = [...groups, { code: "123", kind: "number", valueCodes: [] }];
    expect(validateFormula("BREDD * 123", withDigits)).toEqual({
      message: "Koden 123 består bara av siffror och kan inte användas i en formel — byt kod på valgruppen (tecken 9)",
      position: 9,
    });
    expect(validateFormula("om(123 > 1; 1; 0)", withDigits)?.message).toBe(
      "Koden 123 består bara av siffror och kan inte användas i en formel — byt kod på valgruppen (tecken 4)",
    );
    expect(validateFormula("BREDD * 124 + 123,5", withDigits)).toBeNull();
  });

  it("uses the unrounded value for constant checks at save", () => {
    expect(validationMessage("avrunda_upp(BREDD; 0,00004)")).toBeNull();
    expect(validationMessage("avrunda_ned(BREDD; 0,00004)")).toBeNull();
    expect(validationMessage("avrunda(BREDD; 4,00001)")).toBe("Decimalerna i avrunda måste vara ett heltal 0–4 (tecken 16)");
  });

  it("rounds a negative value up symmetrically with avrunda_ned", () => {
    expect(num("avrunda_upp(-1,3; 0,25)")).toBe(-1.25);
    expect(num("avrunda_upp(-1,25; 0,25)")).toBe(-1.25);
    expect(num("avrunda_ned(-1,3; 0,25)")).toBe(-1.5);
    expect(num("avrunda_upp(0; 0,25)")).toBe(0);
  });

  it("rounds down robustly at large magnitudes", () => {
    expect(num("avrunda_ned(100000000,3; 0,1)")).toBe(100000000.3);
  });

  it("explains a code on the right of a value-code comparison, an exponent and a no-break space", () => {
    expect(validationMessage('om("EP" = FARG; 1; 2)')).toBe('Koden ska stå till vänster: FARG = "EP" (tecken 4)');
    expect(validationMessage("1E308")).toBe("Okänd kod 1E308 — tal skrivs utan exponent (tecken 1)");
    expect(validationMessage("2 * 1e5")).toBe("Okänd kod 1E5 — tal skrivs utan exponent (tecken 5)");
    expect(validationMessage("2 * 3")).toBe("Oväntat tecken (hårt mellanslag) (tecken 2)");
    expect(evalError("1e308")).toBe("Okänd kod 1E308 — tal skrivs utan exponent");
  });
});
