import { describe, expect, it } from "vitest";
import type { AlertGroup, AlertItem } from "@navet/shared";
import {
  DIGEST_NO_LINKS_TEXT,
  DIGEST_ROWS_PER_KIND,
  digestItemCount,
  digestSubject,
  escapeHtml,
  formatDigestDay,
  renderAlertDigestMail,
} from "../src/modules/alerts/service/alert-digest-mail.js";

// The digest mail, pure: subject, the per-kind sections, the 20-row cap,
// links only with Navs adress, error groups as one line, and escaping.

function item(n: number, overrides: Partial<AlertItem> = {}): AlertItem {
  return { key: `k${n}`, severity: "yellow", href: `/forsaljning/ordrar/${n}`, primary: `KO-${n} Kund ${n}`, secondary: `${n} dagar försenad`, date: null, ...overrides };
}

function group(kind: AlertGroup["kind"], items: AlertItem[], overrides: Partial<AlertGroup> = {}): AlertGroup {
  return {
    kind,
    label: "Försenade kundordrar",
    severity: "yellow",
    count: items.length,
    listHref: "/forsaljning/ordrar",
    items,
    error: false,
    message: null,
    ...overrides,
  };
}

describe("alert-digest-mail", () => {
  it("formats the day in Swedish and the subject with singular/plural", () => {
    expect(formatDigestDay("2026-10-20")).toBe("tisdag 20 oktober");
    expect(formatDigestDay("2026-01-05")).toBe("måndag 5 januari");
    expect(digestSubject(5, "2026-10-20")).toBe("Nav: 5 saker att bevaka — tisdag 20 oktober");
    expect(digestSubject(1, "2026-10-20")).toBe("Nav: 1 sak att bevaka — tisdag 20 oktober");
    expect(digestSubject(0, "2026-10-20")).toBe("Nav: 0 saker att bevaka — tisdag 20 oktober");
  });

  it("counts the rows of the computed groups only — an error group is not a thing to attend to", () => {
    const groups = [
      group("sales_order_late", [item(1), item(2)]),
      group("stock_negative", [], { error: true, message: "Kunde inte räknas fram negativt saldo: boom", count: 0 }),
    ];
    expect(digestItemCount(groups)).toBe(2);
  });

  it("renders a heading per kind with its count, absolute links per row and the settings link", () => {
    const mail = renderAlertDigestMail({
      date: "2026-10-20",
      baseUrl: "https://erp.foretag.se",
      groups: [group("sales_order_late", [item(1), item(2)])],
    });
    expect(mail.subject).toBe("Nav: 2 saker att bevaka — tisdag 20 oktober");
    expect(mail.text).toContain("Försenade kundordrar (2)");
    expect(mail.text).toContain("- KO-1 Kund 1 — 1 dagar försenad");
    expect(mail.text).toContain("https://erp.foretag.se/forsaljning/ordrar/1");
    expect(mail.text).toContain("Ändra vad du får: https://erp.foretag.se/aviseringar");
    expect(mail.text).not.toContain(DIGEST_NO_LINKS_TEXT);
    expect(mail.html).toContain('<a href="https://erp.foretag.se/forsaljning/ordrar/1">KO-1 Kund 1</a>');
    expect(mail.html).toContain("Försenade kundordrar (2)");
    expect(mail.html).toContain('<a href="https://erp.foretag.se/aviseringar">Ändra vad du får</a>');
    expect(mail.html).toContain('<html lang="sv">');
  });

  it("caps each kind at 20 rows and links '… och N till' to the list page", () => {
    const items = Array.from({ length: 33 }, (_, i) => item(i + 1));
    const mail = renderAlertDigestMail({ date: "2026-10-20", baseUrl: "https://erp.foretag.se", groups: [group("sales_order_late", items)] });
    expect(DIGEST_ROWS_PER_KIND).toBe(20);
    expect(mail.text).toContain("KO-20 Kund 20");
    expect(mail.text).not.toContain("KO-21 Kund 21");
    expect(mail.text).toContain("… och 13 till: https://erp.foretag.se/forsaljning/ordrar");
    expect(mail.html).toContain('<a href="https://erp.foretag.se/forsaljning/ordrar">… och 13 till</a>');
    // The count is the real one even when the response itself was capped.
    const capped = group("sales_order_late", items.slice(0, 25), { count: 300 });
    expect(renderAlertDigestMail({ date: "2026-10-20", baseUrl: "", groups: [capped] }).text).toContain("… och 280 till");
  });

  it("without Navs adress: no links at all and the 'Öppna Nav' text", () => {
    const mail = renderAlertDigestMail({
      date: "2026-10-20",
      baseUrl: "",
      groups: [group("sales_order_late", Array.from({ length: 21 }, (_, i) => item(i + 1)))],
    });
    expect(mail.text).toContain(DIGEST_NO_LINKS_TEXT);
    expect(mail.text).not.toContain("http");
    expect(mail.text).toContain("… och 1 till\n");
    expect(mail.text.trimEnd().endsWith("Ändra vad du får")).toBe(true);
    expect(mail.html).toContain(DIGEST_NO_LINKS_TEXT);
    expect(mail.html).not.toContain("<a ");
  });

  it("writes an error group as one line with the message and escapes everything from the data", () => {
    const mail = renderAlertDigestMail({
      date: "2026-10-20",
      baseUrl: "https://erp.foretag.se",
      groups: [
        group("stock_negative", [], { label: "Negativt saldo", error: true, message: "Kunde inte räknas fram negativt saldo: <boom>", count: 0 }),
        group("sales_order_late", [item(1, { primary: 'KO-1 Kund & <Söner> "AB"', secondary: null, href: "/forsaljning/ordrar/1?x=1&y=2" })]),
      ],
    });
    expect(mail.subject).toBe("Nav: 1 sak att bevaka — tisdag 20 oktober");
    expect(mail.text).toContain("Negativt saldo: Kunde inte räknas fram negativt saldo: <boom>");
    expect(mail.html).toContain("<strong>Negativt saldo:</strong> Kunde inte räknas fram negativt saldo: &lt;boom&gt;");
    expect(mail.html).toContain("KO-1 Kund &amp; &lt;Söner&gt; &quot;AB&quot;</a>");
    expect(mail.html).toContain('href="https://erp.foretag.se/forsaljning/ordrar/1?x=1&amp;y=2"');
    expect(mail.html).not.toContain("<boom>");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("a row without a card (href null) is text even with Navs adress", () => {
    const mail = renderAlertDigestMail({
      date: "2026-10-20",
      baseUrl: "https://erp.foretag.se",
      groups: [group("email_failed", [item(1, { href: null, primary: "Testmejl: Hej" })], { label: "Utskick som misslyckades", listHref: "/system/e-postlogg" })],
    });
    expect(mail.html).toContain("<li>Testmejl: Hej — 1 dagar försenad</li>");
    expect(mail.text).toContain("- Testmejl: Hej — 1 dagar försenad\n");
    expect(mail.text).not.toContain("https://erp.foretag.se/null");
  });
});
