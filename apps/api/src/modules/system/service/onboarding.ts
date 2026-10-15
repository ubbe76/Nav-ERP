// System → Kom igång: the setup checklist an administrator sees on Översikten
// (spec docs/superpowers/specs/2026-10-15-kom-igang-design.md). Pure: the
// steps are data and buildOnboarding turns the facts the repository reads
// into the view — nothing about a step's status is stored, except that the
// number series were reviewed.

export interface OnboardingFacts {
  companyName: string;
  companyOrgNumber: string | null;
  activeUsers: number;
  hasArticles: boolean;
  hasCustomers: boolean;
  hasSuppliers: boolean;
  hasWorkCenters: boolean;
  hasPaymentTerms: boolean;
  hasDeliveryTerms: boolean;
  numberSeriesReviewed: boolean;
  hasFiscalYear: boolean;
  hasAccounts: boolean;
  smtpHost: string | null;
}

export const EMPTY_ONBOARDING_FACTS: OnboardingFacts = {
  companyName: "",
  companyOrgNumber: null,
  activeUsers: 1,
  hasArticles: false,
  hasCustomers: false,
  hasSuppliers: false,
  hasWorkCenters: false,
  hasPaymentTerms: false,
  hasDeliveryTerms: false,
  numberSeriesReviewed: false,
  hasFiscalYear: false,
  hasAccounts: false,
  smtpHost: null,
};

export type OnboardingStepKey =
  | "company"
  | "users"
  | "articles"
  | "partners"
  | "workCenters"
  | "terms"
  | "numberSeries"
  | "accounting"
  | "email";

export interface OnboardingLink {
  href: string;
  label: string;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  title: string;
  description: string;
  done: boolean;
  links: OnboardingLink[];
}

export interface OnboardingView {
  groups: { title: string; steps: OnboardingStep[] }[];
  done: number;
  total: number;
  complete: boolean;
}

const filled = (value: string | null) => (value ?? "").trim() !== "";

// Shown on an unfinished register step while every register is empty — the
// quick way to try the system without one's own registers.
const DEMO_LINK: OnboardingLink = { href: "/system/exempeldata", label: "Skapa exempeldata" };

interface StepDefinition {
  group: string;
  key: OnboardingStepKey;
  title: string;
  description: string;
  done: (f: OnboardingFacts) => boolean;
  links: OnboardingLink[];
  register?: boolean;
}

const STEPS: StepDefinition[] = [
  {
    group: "Företag och användare",
    key: "company",
    title: "Företagsinformation",
    description: "Namn, organisationsnummer och adress — de skrivs ut på order, fakturor och andra dokument.",
    done: (f) => filled(f.companyName) && filled(f.companyOrgNumber),
    links: [{ href: "/system/foretagsinfo", label: "Företagsinformation" }],
  },
  {
    group: "Företag och användare",
    key: "users",
    title: "Användare",
    description: "Lägg upp de som ska arbeta i systemet och ge dem en behörighetsgrupp.",
    done: (f) => f.activeUsers >= 2,
    links: [{ href: "/system/anvandare", label: "Användare" }],
  },
  {
    group: "Register",
    key: "articles",
    title: "Artiklar",
    description: "Artikelregistret med struktur och operationer — importera dina egna eller prova med exempeldata.",
    done: (f) => f.hasArticles,
    links: [{ href: "/artiklar/import", label: "Importera artiklar" }],
    register: true,
  },
  {
    group: "Register",
    key: "partners",
    title: "Kunder och leverantörer",
    description: "Kund- och leverantörsregistren med adresser och villkor.",
    done: (f) => f.hasCustomers && f.hasSuppliers,
    links: [
      { href: "/kunder/import", label: "Importera kunder" },
      { href: "/leverantorer/import", label: "Importera leverantörer" },
    ],
    register: true,
  },
  {
    group: "Register",
    key: "workCenters",
    title: "Resurser",
    description: "Maskiner och arbetsstationer som operationerna utförs i, med timkostnad.",
    done: (f) => f.hasWorkCenters,
    links: [{ href: "/tillverkning/resurser", label: "Resurser" }],
    register: true,
  },
  {
    group: "Grunddata och nummerserier",
    key: "terms",
    title: "Betalnings- och leveransvillkor",
    description: "Villkoren som kunder, leverantörer och order använder — leveransvillkoren kan förifyllas med Combiterms.",
    done: (f) => f.hasPaymentTerms && f.hasDeliveryTerms,
    links: [{ href: "/grunddata", label: "Grunddata" }],
  },
  {
    group: "Grunddata och nummerserier",
    key: "numberSeries",
    title: "Nummerserier",
    description: "Kontrollera prefix och nästa nummer för order, fakturor, kunder och leverantörer innan du börjar.",
    done: (f) => f.numberSeriesReviewed,
    links: [{ href: "/system/nummerserier", label: "Nummerserier" }],
  },
  {
    group: "Ekonomi och e-post",
    key: "accounting",
    title: "Räkenskapsår och kontoplan",
    description: "Ett räkenskapsår och en kontoplan behövs för att fakturor och betalningar ska bokföras — kontoplanen kan förifyllas med BAS.",
    done: (f) => f.hasFiscalYear && f.hasAccounts,
    links: [
      { href: "/ekonomi/rakenskapsar", label: "Räkenskapsår" },
      { href: "/ekonomi/kontoplan", label: "Kontoplan" },
    ],
  },
  {
    group: "Ekonomi och e-post",
    key: "email",
    title: "E-post",
    description: "En SMTP-server så att order, förfrågningar och fakturor kan mejlas direkt ur systemet.",
    done: (f) => filled(f.smtpHost),
    links: [{ href: "/system/installningar", label: "Inställningar" }],
  },
];

export function buildOnboarding(facts: OnboardingFacts): OnboardingView {
  // Skapa exempeldata refuses as soon as any of the four registers has data,
  // so the link is only offered on a completely empty installation.
  const demoAvailable = !facts.hasArticles && !facts.hasCustomers && !facts.hasSuppliers && !facts.hasWorkCenters;
  const groups: OnboardingView["groups"] = [];
  for (const def of STEPS) {
    const done = def.done(facts);
    const step: OnboardingStep = {
      key: def.key,
      title: def.title,
      description: def.description,
      done,
      links: def.register && !done && demoAvailable ? [DEMO_LINK, ...def.links] : def.links,
    };
    const group = groups.find((g) => g.title === def.group);
    if (group) group.steps.push(step);
    else groups.push({ title: def.group, steps: [step] });
  }
  const doneCount = STEPS.filter((def) => def.done(facts)).length;
  return { groups, done: doneCount, total: STEPS.length, complete: doneCount === STEPS.length };
}
