import type { AiInvoiceFields } from "../../src/modules/purchase/service/invoice-scan/ai-fields.js";
import {
  InvoiceInterpreterError,
  type AiInterpretation,
  type InvoiceInterpreter,
  type InvoiceInterpreterConfig,
  type InvoiceInterpreterContext,
  type InvoiceInterpreterFactory,
  type InvoiceInterpreterFile,
} from "../../src/modules/purchase/service/invoice-scan/invoice-interpreter.js";
import { FAKE_OCR, FAKE_SUPPLIER } from "./invoice-pdf.js";

// In-memory InvoiceInterpreter for the Fakturainkorg's AI tests — never a
// network call. `state` scripts the answer (fields, truncated), an error to
// throw, and a gate that holds the call open so a test can act while it
// "runs" (Avvisa/Skapa meanwhile, a second Tolka med AI). `calls` records
// every interpret call with the config it was made with.

export interface FakeInterpreter {
  factory: InvoiceInterpreterFactory;
  calls: { config: InvoiceInterpreterConfig; file: InvoiceInterpreterFile; context: InvoiceInterpreterContext }[];
  tests: InvoiceInterpreterConfig[];
  state: {
    fields: AiInvoiceFields;
    truncated: boolean;
    error: Error | null;
    testError: Error | null;
    // While set, interpret() waits for release() before answering.
    gate: Promise<void> | null;
  };
  // Holds the next calls open until the returned release() is called; the
  // promise `entered` resolves once a call is waiting at the gate.
  hold(): { release: () => void; entered: Promise<void> };
}

const sure = <T>(value: T) => ({ value, confidence: "high" as const });
const none = { value: null, confidence: "low" as const };

// The made-up test invoice (helpers/invoice-pdf.ts FAKE_SUPPLIER) as a
// confident model would read it: 1 000,00 + 250,00 = 1 250,00, OCR valid.
export function sampleAiFields(overrides: Partial<AiInvoiceFields> = {}): AiInvoiceFields {
  return {
    supplier: {
      name: sure(FAKE_SUPPLIER.name),
      orgNumber: sure(FAKE_SUPPLIER.orgNumber),
      vatNumber: sure(FAKE_SUPPLIER.vatNumber),
      bankgiro: sure(FAKE_SUPPLIER.bankgiro),
      plusgiro: none,
      iban: none,
      bic: none,
      address: sure(FAKE_SUPPLIER.address),
      postalCode: sure(FAKE_SUPPLIER.postalCode),
      city: sure(FAKE_SUPPLIER.city),
      country: sure("SE"),
    },
    invoiceNumber: sure("AI-4711"),
    invoiceDate: sure(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })),
    dueDate: none,
    currency: sure("SEK"),
    netAmount: sure(1000),
    vatAmount: sure(250),
    grossAmount: sure(1250),
    vatRate: sure(25),
    paymentReference: { value: FAKE_OCR, kind: "ocr", confidence: "high" },
    isCreditNote: sure(false),
    purchaseOrderReference: none,
    rows: [
      { description: "Plåt 2 mm", quantity: 10, unitPrice: 60, lineAmount: 600, vatRate: 25, supplierArticleNumber: "PL-2", confidence: "high" },
      { description: "Plåt 3 mm", quantity: 4, unitPrice: 100, lineAmount: 400, vatRate: 25, supplierArticleNumber: "PL-3", confidence: "high" },
    ],
    ...overrides,
  };
}

export function createFakeInvoiceInterpreter(): FakeInterpreter {
  const calls: FakeInterpreter["calls"] = [];
  const tests: InvoiceInterpreterConfig[] = [];
  const state: FakeInterpreter["state"] = { fields: sampleAiFields(), truncated: false, error: null, testError: null, gate: null };
  let entered: (() => void) | null = null;

  const factory: InvoiceInterpreterFactory = (config): InvoiceInterpreter => ({
    async interpret(file, context): Promise<AiInterpretation> {
      calls.push({ config, file, context });
      if (state.gate) {
        entered?.();
        await state.gate;
      }
      if (state.error) throw state.error;
      return { fields: structuredClone(state.fields), truncated: state.truncated };
    },
    async testConnection() {
      tests.push(config);
      if (state.testError) throw state.testError;
    },
  });

  return {
    factory,
    calls,
    tests,
    state,
    hold() {
      let release!: () => void;
      state.gate = new Promise<void>((resolve) => {
        release = () => {
          state.gate = null;
          resolve();
        };
      });
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { release, entered: enteredPromise };
    },
  };
}

export { InvoiceInterpreterError };
