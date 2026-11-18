import { describe, expect, it } from "vitest";
import { printStrategy } from "../../web/lib/printPdf.js";

const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA = SAFARI_MAC;
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

describe("printStrategy", () => {
  it("prints in an iframe in Chromium, Edge and Firefox on the desktop", () => {
    expect(printStrategy(EDGE, 0)).toBe("iframe");
    expect(printStrategy(EDGE, 0, true)).toBe("iframe");
    expect(printStrategy(CHROME, 0)).toBe("iframe");
    expect(printStrategy(FIREFOX, 0, true)).toBe("iframe");
  });
  it("opens a tab when the browser cannot show a PDF inline", () => {
    expect(printStrategy(EDGE, 0, false)).toBe("tab");
    expect(printStrategy(CHROME, 0, false)).toBe("tab");
  });
  it("opens a tab on Android, whatever it says about the viewer", () => {
    expect(printStrategy(CHROME_ANDROID, 5)).toBe("tab");
    expect(printStrategy(CHROME_ANDROID, 5, true)).toBe("tab");
  });
  it("opens a tab in desktop Safari", () => {
    expect(printStrategy(SAFARI_MAC, 0)).toBe("tab");
  });
  it("opens a tab on iPhone, also in other browsers (all WebKit)", () => {
    expect(printStrategy(SAFARI_IPHONE, 5)).toBe("tab");
    expect(printStrategy(CHROME_IPHONE, 5)).toBe("tab");
  });
  it("opens a tab on an iPad that reports a Mac user agent", () => {
    expect(printStrategy(IPAD_DESKTOP_UA, 5)).toBe("tab");
  });
});
