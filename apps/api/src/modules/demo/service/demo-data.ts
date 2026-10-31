// Frivillig exempeldata — the made-up company the System → Exempeldata page
// creates on an empty installation: stainless-steel catering furniture
// (spec docs/superpowers/specs/2026-10-15-exempeldata-design.md). Pure data,
// no DB imports, so its shape is tested on its own (test/demo-data.test.ts).
//
// The manufactured articles' standardCost is the costing's TVK per unit at
// quantity 1, rounded to whole kronor — test/demo-data-flows.test.ts keeps it
// in sync with the costing (sub-assemblies first: their standard cost is the
// material cost of the level above).

export type DemoUnit = "st" | "m";
export type DemoLocation = "raw" | "components";

export interface DemoCode {
  code: string;
  name: string;
}

export interface DemoWorkCenter {
  code: string;
  name: string;
  type: "machine" | "personnel";
  productionGroup: string;
  hourlyRate: number;
}

export interface DemoAddress {
  address: string;
  postalCode: string;
  city: string;
}

export interface DemoSupplier extends DemoAddress {
  key: string;
  name: string;
  email: string;
  phone: string;
}

export interface DemoCustomer extends DemoAddress {
  name: string;
  email: string;
  phone: string;
  deliveryAddress?: DemoAddress & { label: string };
  contact?: { name: string; email: string; phone: string };
}

// Minutes: setup per order, run time per piece.
export interface DemoOperation {
  sequenceNo: number;
  workCenter: string;
  setupTime: number;
  runTimePerUnit: number;
}

// quantity in the component's base unit; operation = the parent's own
// sequence number the material is drawn at (null = at final reporting).
export interface DemoBomRow {
  component: string;
  quantity: number;
  operation: number | null;
}

export interface DemoArticle {
  articleNumber: string;
  name: string;
  type: "purchased" | "manufactured";
  isPhantom?: boolean;
  unit: DemoUnit;
  group: string;
  location: DemoLocation;
  standardCost: number;
  salesPrice?: number;
  supplier?: { supplier: string; price: number; breaks?: { fromQuantity: number; price: number }[] };
  routing?: DemoOperation[];
  bom?: DemoBomRow[];
  openingStock?: number;
}

// Avvikelseorsaker (Kvalitet): which kinds of case — and the scrap
// reporting — each reason applies to.
export interface DemoDeviationReason extends DemoCode {
  customer: boolean;
  supplier: boolean;
  internal: boolean;
  scrap: boolean;
}

export interface DemoData {
  articleGroups: DemoCode[];
  deviationReasons: DemoDeviationReason[];
  paymentTerm: DemoCode;
  productionGroups: DemoCode[];
  workCenters: DemoWorkCenter[];
  suppliers: DemoSupplier[];
  customers: DemoCustomer[];
  articles: DemoArticle[];
}

export const DEMO_LOCATIONS: Record<DemoLocation, string> = {
  raw: "Råvarulager",
  components: "Komponentlager",
};

export const DEMO_DATA: DemoData = {
  articleGroups: [
    { code: "100", name: "Råvaror" },
    { code: "200", name: "Halvfabrikat" },
    { code: "300", name: "Färdiga produkter" },
    { code: "400", name: "Köpkomponenter" },
  ],
  // The code is the number of days — dueDateFromTerm reads it that way.
  paymentTerm: { code: "30", name: "30 dagar netto" },
  deviationReasons: [
    { code: "TRANSP", name: "Transportskada", customer: true, supplier: true, internal: false, scrap: false },
    { code: "FELART", name: "Fel artikel", customer: true, supplier: true, internal: false, scrap: false },
    { code: "FELANT", name: "Fel antal", customer: true, supplier: true, internal: false, scrap: false },
    { code: "MATT", name: "Måttfel", customer: true, supplier: true, internal: true, scrap: true },
    { code: "YTA", name: "Ytskada", customer: true, supplier: true, internal: true, scrap: true },
    { code: "MATFEL", name: "Materialfel", customer: false, supplier: true, internal: true, scrap: true },
    { code: "RITN", name: "Felaktig ritning", customer: false, supplier: false, internal: true, scrap: true },
    { code: "MASKIN", name: "Maskinfel", customer: false, supplier: false, internal: true, scrap: true },
  ],
  productionGroups: [
    { code: "PV", name: "Plåtverkstad" },
    { code: "MO", name: "Montering" },
  ],
  workCenters: [
    { code: "110", name: "Laserskärning", type: "machine", productionGroup: "PV", hourlyRate: 950 },
    { code: "120", name: "Kantpressning", type: "machine", productionGroup: "PV", hourlyRate: 750 },
    { code: "130", name: "Svetsning", type: "personnel", productionGroup: "PV", hourlyRate: 620 },
    { code: "140", name: "Slipning", type: "personnel", productionGroup: "PV", hourlyRate: 560 },
    { code: "150", name: "Montering", type: "personnel", productionGroup: "MO", hourlyRate: 540 },
  ],
  suppliers: [
    { key: "stal", name: "Exempel Stålhandel AB", address: "Valsverksgatan 4", postalCode: "123 45", city: "Exempelby", email: "order@exempel.invalid", phone: "010-100 10 10" },
    { key: "fast", name: "Exempel Fästelement AB", address: "Skruvvägen 12", postalCode: "123 46", city: "Exempelby", email: "order@exempel.invalid", phone: "010-100 20 20" },
    { key: "hjul", name: "Exempel Hjul & Rullar AB", address: "Rullbanan 3", postalCode: "234 56", city: "Exempelstad", email: "info@exempel.invalid", phone: "010-100 30 30" },
  ],
  customers: [
    { name: "Restaurang Exempelkrogen AB", address: "Storgatan 8", postalCode: "123 50", city: "Exempelby", email: "kok@exempel.invalid", phone: "010-200 10 10" },
    { name: "Hotell Exempel AB", address: "Hamnplan 1", postalCode: "234 60", city: "Exempelstad", email: "inkop@exempel.invalid", phone: "010-200 20 20" },
    {
      name: "Exempelby kommun – Skolköket",
      address: "Kommunhuset, Torget 1",
      postalCode: "123 40",
      city: "Exempelby",
      email: "skolkoket@exempel.invalid",
      phone: "010-200 30 30",
      deliveryAddress: { label: "Exempelskolan, köket", address: "Skolvägen 5", postalCode: "123 42", city: "Exempelby" },
    },
    {
      name: "Storköksgrossisten Exempel AB",
      address: "Industrivägen 20",
      postalCode: "345 67",
      city: "Exempeltorp",
      email: "order@exempel.invalid",
      phone: "010-200 40 40",
      contact: { name: "Erik Exempelsson", email: "erik@exempel.invalid", phone: "070-000 00 01" },
    },
  ],
  articles: [
    // Purchased — raw materials (100) and bought-in components (400).
    { articleNumber: "1001", name: "Rostfri plåt 1,0 mm 1000×2000", type: "purchased", unit: "st", group: "100", location: "raw", standardCost: 780, supplier: { supplier: "stal", price: 780, breaks: [{ fromQuantity: 10, price: 740 }] }, openingStock: 20 },
    { articleNumber: "1002", name: "Rostfri plåt 1,5 mm 1000×2000", type: "purchased", unit: "st", group: "100", location: "raw", standardCost: 1150, supplier: { supplier: "stal", price: 1150 }, openingStock: 20 },
    { articleNumber: "1010", name: "Fyrkantrör rostfritt 40×40×1,5", type: "purchased", unit: "m", group: "100", location: "raw", standardCost: 145, supplier: { supplier: "stal", price: 145 }, openingStock: 120 },
    { articleNumber: "1020", name: "Ställbar fot M10", type: "purchased", unit: "st", group: "400", location: "components", standardCost: 38, supplier: { supplier: "fast", price: 38 }, openingStock: 200 },
    { articleNumber: "1021", name: "Skruv M6×16 A2", type: "purchased", unit: "st", group: "400", location: "components", standardCost: 1.2, supplier: { supplier: "fast", price: 1.2 }, openingStock: 2000 },
    { articleNumber: "1030", name: "Hjul Ø100 med broms", type: "purchased", unit: "st", group: "400", location: "components", standardCost: 165, supplier: { supplier: "hjul", price: 165 }, openingStock: 40 },
    // Phantom — never stocked, always dissolved into its components.
    { articleNumber: "2100", name: "Benpaket", type: "manufactured", isPhantom: true, unit: "st", group: "200", location: "components", standardCost: 645, bom: [{ component: "1010", quantity: 3.4, operation: null }, { component: "1020", quantity: 4, operation: null }] },
    // Sub-assemblies (200).
    {
      articleNumber: "2001", name: "Bänkskiva 1200×600", type: "manufactured", unit: "st", group: "200", location: "components", standardCost: 1380,
      routing: [
        { sequenceNo: 10, workCenter: "110", setupTime: 10, runTimePerUnit: 6 },
        { sequenceNo: 20, workCenter: "120", setupTime: 15, runTimePerUnit: 8 },
        { sequenceNo: 30, workCenter: "130", setupTime: 0, runTimePerUnit: 12 },
        { sequenceNo: 40, workCenter: "140", setupTime: 0, runTimePerUnit: 15 },
      ],
      bom: [{ component: "1002", quantity: 0.5, operation: 10 }],
    },
    {
      articleNumber: "2002", name: "Underrede 1200", type: "manufactured", unit: "st", group: "200", location: "components", standardCost: 1837,
      routing: [
        { sequenceNo: 10, workCenter: "110", setupTime: 10, runTimePerUnit: 5 },
        { sequenceNo: 20, workCenter: "130", setupTime: 0, runTimePerUnit: 25 },
      ],
      bom: [{ component: "1010", quantity: 4.8, operation: 10 }, { component: "2100", quantity: 1, operation: 20 }],
    },
    {
      articleNumber: "2003", name: "Hyllplan 1200", type: "manufactured", unit: "st", group: "200", location: "components", standardCost: 796,
      routing: [
        { sequenceNo: 10, workCenter: "110", setupTime: 10, runTimePerUnit: 4 },
        { sequenceNo: 20, workCenter: "120", setupTime: 15, runTimePerUnit: 6 },
      ],
      bom: [{ component: "1001", quantity: 0.4, operation: 10 }],
    },
    // Finished products (300).
    {
      articleNumber: "3001", name: "Arbetsbord 1200×600", type: "manufactured", unit: "st", group: "300", location: "components", standardCost: 3407, salesPrice: 5600,
      routing: [{ sequenceNo: 10, workCenter: "150", setupTime: 5, runTimePerUnit: 15 }],
      bom: [{ component: "2001", quantity: 1, operation: 10 }, { component: "2002", quantity: 1, operation: 10 }, { component: "1021", quantity: 8, operation: 10 }],
    },
    {
      articleNumber: "3002", name: "Arbetsbord 1200 med hylla", type: "manufactured", unit: "st", group: "300", location: "components", standardCost: 4252, salesPrice: 6900,
      routing: [{ sequenceNo: 10, workCenter: "150", setupTime: 5, runTimePerUnit: 20 }],
      bom: [{ component: "2001", quantity: 1, operation: 10 }, { component: "2002", quantity: 1, operation: 10 }, { component: "2003", quantity: 1, operation: 10 }, { component: "1021", quantity: 12, operation: 10 }],
    },
    {
      articleNumber: "3003", name: "Arbetsbord 1200 på hjul", type: "manufactured", unit: "st", group: "300", location: "components", standardCost: 4112, salesPrice: 6700,
      routing: [{ sequenceNo: 10, workCenter: "150", setupTime: 5, runTimePerUnit: 20 }],
      bom: [{ component: "2001", quantity: 1, operation: 10 }, { component: "2002", quantity: 1, operation: 10 }, { component: "1030", quantity: 4, operation: 10 }, { component: "1021", quantity: 8, operation: 10 }],
    },
  ],
};
