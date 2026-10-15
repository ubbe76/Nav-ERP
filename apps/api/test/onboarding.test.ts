import { describe, expect, it } from "vitest";
import { buildOnboarding, EMPTY_ONBOARDING_FACTS, type OnboardingFacts } from "../src/modules/system/service/onboarding.js";

const ALL: OnboardingFacts = {
  companyName: "Exempel AB",
  companyOrgNumber: "556677-8899",
  activeUsers: 2,
  hasArticles: true,
  hasCustomers: true,
  hasSuppliers: true,
  hasWorkCenters: true,
  hasPaymentTerms: true,
  hasDeliveryTerms: true,
  numberSeriesReviewed: true,
  hasFiscalYear: true,
  hasAccounts: true,
  smtpHost: "smtp.example.com",
};

const done = (facts: OnboardingFacts) =>
  buildOnboarding(facts).groups.flatMap((g) => g.steps).filter((s) => s.done).map((s) => s.key);

describe("Kom igång — buildOnboarding", () => {
  it("has nine steps in four groups, none done on an empty installation", () => {
    const view = buildOnboarding(EMPTY_ONBOARDING_FACTS);
    expect(view.groups.map((g) => g.title)).toEqual([
      "Företag och användare",
      "Register",
      "Grunddata och nummerserier",
      "Ekonomi och e-post",
    ]);
    expect(view).toMatchObject({ done: 0, total: 9, complete: false });
  });

  it("is complete when every fact holds", () => {
    expect(buildOnboarding(ALL)).toMatchObject({ done: 9, total: 9, complete: true });
  });

  it("needs both name and organisation number for the company, ignoring blanks", () => {
    expect(done({ ...EMPTY_ONBOARDING_FACTS, companyName: "Exempel AB" })).toEqual([]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, companyName: "  ", companyOrgNumber: "556677-8899" })).toEqual([]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, companyName: "Exempel AB", companyOrgNumber: "556677-8899" })).toEqual(["company"]);
  });

  it("needs a second active user", () => {
    expect(done({ ...EMPTY_ONBOARDING_FACTS, activeUsers: 1 })).toEqual([]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, activeUsers: 2 })).toEqual(["users"]);
  });

  it("needs both halves of the paired steps", () => {
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasCustomers: true })).toEqual([]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasCustomers: true, hasSuppliers: true })).toEqual(["partners"]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasPaymentTerms: true })).toEqual([]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasPaymentTerms: true, hasDeliveryTerms: true })).toEqual(["terms"]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasFiscalYear: true })).toEqual([]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasFiscalYear: true, hasAccounts: true })).toEqual(["accounting"]);
  });

  it("maps the single facts to their steps", () => {
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasArticles: true })).toEqual(["articles"]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, hasWorkCenters: true })).toEqual(["workCenters"]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, numberSeriesReviewed: true })).toEqual(["numberSeries"]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, smtpHost: "smtp.example.com" })).toEqual(["email"]);
    expect(done({ ...EMPTY_ONBOARDING_FACTS, smtpHost: " " })).toEqual([]);
  });

  it("offers Skapa exempeldata only on register steps that are not done", () => {
    const linksOf = (facts: OnboardingFacts, key: string) =>
      buildOnboarding(facts).groups.flatMap((g) => g.steps).find((s) => s.key === key)!.links.map((l) => l.href);
    expect(linksOf(EMPTY_ONBOARDING_FACTS, "articles")).toContain("/system/exempeldata");
    expect(linksOf({ ...EMPTY_ONBOARDING_FACTS, hasArticles: true }, "articles")).not.toContain("/system/exempeldata");
    expect(linksOf(EMPTY_ONBOARDING_FACTS, "company")).not.toContain("/system/exempeldata");
  });

  it("offers Skapa exempeldata only while all four registers are empty, since it refuses otherwise", () => {
    const linksOf = (facts: OnboardingFacts, key: string) =>
      buildOnboarding(facts).groups.flatMap((g) => g.steps).find((s) => s.key === key)!.links.map((l) => l.href);
    for (const filledRegister of [{ hasCustomers: true }, { hasSuppliers: true }, { hasWorkCenters: true }]) {
      const facts = { ...EMPTY_ONBOARDING_FACTS, ...filledRegister };
      expect(linksOf(facts, "articles")).not.toContain("/system/exempeldata");
    }
    expect(linksOf({ ...EMPTY_ONBOARDING_FACTS, hasArticles: true }, "partners")).not.toContain("/system/exempeldata");
  });
});
