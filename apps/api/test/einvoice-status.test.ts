import { describe, expect, it } from "vitest";
import {
  EINVOICE_STATUSES,
  einvoiceStatusLabel,
  isKnownProviderState,
  isLiveStatus,
  isTerminalStatus,
  mapProviderState,
  PROVIDER_STATE_MAP,
  providerErrorText,
  UNKNOWN_PROVIDER_STATE_STATUS,
} from "../src/modules/einvoice/service/einvoice-status.js";

describe("einvoice-status", () => {
  it("maps every B2Brouter state in the spec §3.4 table", () => {
    expect(PROVIDER_STATE_MAP).toEqual({
      new: "sending",
      sending: "sending",
      sent: "sent",
      downloaded: "sent",
      registered: "delivered",
      accepted: "delivered",
      paid: "delivered",
      closed: "delivered",
      allegedly_paid: "delivered",
      refused: "rejected",
      error: "failed",
    });
    for (const [state, status] of Object.entries(PROVIDER_STATE_MAP)) {
      expect(mapProviderState(state)).toBe(status);
      expect(isKnownProviderState(state)).toBe(true);
    }
  });

  it("matches states case-insensitively and trimmed", () => {
    expect(mapProviderState(" Registered ")).toBe("delivered");
    expect(mapProviderState("REFUSED")).toBe("rejected");
  });

  it("an unknown state stays live as 'sending' — never delivered, never freed for a resend", () => {
    expect(UNKNOWN_PROVIDER_STATE_STATUS).toBe("sending");
    expect(mapProviderState("archived")).toBe("sending");
    expect(mapProviderState("")).toBe("sending");
    expect(isKnownProviderState("archived")).toBe(false);
    expect(isLiveStatus(mapProviderState("whatever"))).toBe(true);
    expect(isTerminalStatus(mapProviderState("whatever"))).toBe(false);
  });

  it("live vs terminal", () => {
    expect(EINVOICE_STATUSES).toEqual(["sending", "sent", "delivered", "rejected", "failed"]);
    expect(EINVOICE_STATUSES.filter(isLiveStatus)).toEqual(["sending", "sent", "delivered"]);
    expect(EINVOICE_STATUSES.filter(isTerminalStatus)).toEqual(["delivered", "rejected", "failed"]);
  });

  it("Swedish labels", () => {
    expect(EINVOICE_STATUSES.map(einvoiceStatusLabel)).toEqual(["Skickas", "Skickad", "Mottagen", "Avvisad", "Misslyckad"]);
  });

  it("translates known B2Brouter error codes, passes other text through, null for nothing", () => {
    expect(providerErrorText("PEPPOL_NO_RECEIVER")).toBe("Mottagaren finns inte i Peppol");
    expect(providerErrorText("Delivery failed: PEPPOL_NO_RECEIVER (0088:9500047420799)")).toBe("Mottagaren finns inte i Peppol");
    expect(providerErrorText("peppol_no_receiver")).toBe("Mottagaren finns inte i Peppol");
    expect(providerErrorText("XPEPPOL_NO_RECEIVERX")).toBe("XPEPPOL_NO_RECEIVERX");
    expect(providerErrorText("Schematron validation failed")).toBe("Schematron validation failed");
    expect(providerErrorText("  ")).toBeNull();
    expect(providerErrorText(null)).toBeNull();
    expect(providerErrorText(undefined)).toBeNull();
  });
});
