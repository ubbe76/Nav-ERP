import { describe, expect, it } from "vitest";
import { VAT_BOXES, VAT_BOX_LABELS } from "@navet/shared";
import * as web from "../../web/lib/vatBoxes.js";

describe("momsruta — web mirror", () => {
  it("is identical to @navet/shared", () => {
    expect([...web.VAT_BOXES]).toEqual([...VAT_BOXES]);
    expect(web.VAT_BOX_LABELS).toEqual(VAT_BOX_LABELS);
  });

  it("labels null and 'none' distinctly", () => {
    expect(web.vatBoxLabel(null)).toBe("Ej angiven");
    expect(web.vatBoxLabel("none")).toBe("Ingen ruta");
    expect(web.vatBoxLabel("05")).toBe("05 · Momspliktig försäljning som inte ingår i ruta 06, 07 eller 08");
  });
});
