import { describe, expect, it } from "vitest";
import {
  freightMode,
  suggestParcels,
  type ParcelArticle,
  type ParcelPackageType,
} from "../src/modules/shipping/service/parcels.js";

function article(over: Partial<ParcelArticle> & { id: string }): ParcelArticle {
  return {
    name: over.id,
    type: "manufactured",
    weight: 10,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    parcelKind: null,
    stackable: false,
    loadingMeters: null,
    packageTypeId: null,
    quantityPerPackage: null,
    ...over,
  };
}

const EUR: ParcelPackageType = {
  id: "eur",
  name: "EUR-pall",
  parcelKind: "pallet",
  lengthMm: 1200,
  widthMm: 800,
  heightMm: 1000,
  tareWeight: 25,
  stackable: false,
  loadingMeters: 0.4,
};
const types = new Map([[EUR.id, EUR]]);
const map = (...as: ParcelArticle[]) => new Map(as.map((a) => [a.id, a]));

describe("freightMode", () => {
  it("package needs both a package type and antal per kolli > 0", () => {
    expect(freightMode(article({ id: "a", packageTypeId: "eur", quantityPerPackage: 40 }))).toBe("package");
    expect(freightMode(article({ id: "a", packageTypeId: "eur", quantityPerPackage: 0, lengthMm: 10 }))).toBe("own");
    expect(freightMode(article({ id: "a", lengthMm: 2000 }))).toBe("own");
    expect(freightMode(article({ id: "a" }))).toBe("none");
  });
});

describe("suggestParcels", () => {
  it("own dimensions: one row per article, mm → cm, quantity rounded up", () => {
    const a = article({ id: "a", name: "Diskbänk", lengthMm: 3005, widthMm: 650, heightMm: 900, weight: 42.123, parcelKind: "pallet", stackable: false, loadingMeters: 0.8 });
    const { parcels, warnings } = suggestParcels([{ articleId: "a", quantity: 1.5 }], map(a), types);
    expect(warnings).toEqual([]);
    expect(parcels).toEqual([
      { parcelKind: "pallet", lengthCm: 300.5, widthCm: 65, heightCm: 90, weightKg: 42.12, quantity: 2, stackable: false, loadingMeters: 0.8, description: "Diskbänk" },
    ]);
  });

  it("own dimensions default to Paket", () => {
    const a = article({ id: "a", lengthMm: 400, widthMm: 300, heightMm: 200 });
    expect(suggestParcels([{ articleId: "a", quantity: 1 }], map(a), types).parcels[0]!.parcelKind).toBe("package");
  });

  it("fills shared packages: 2.5 + 0.5 = 3 EUR pallets with tare + spread article weight", () => {
    const a = article({ id: "a", name: "A", weight: 1, packageTypeId: "eur", quantityPerPackage: 40 });
    const b = article({ id: "b", name: "B", weight: 2, packageTypeId: "eur", quantityPerPackage: 20 });
    const { parcels } = suggestParcels(
      [
        { articleId: "a", quantity: 100 },
        { articleId: "b", quantity: 10 },
      ],
      map(a, b),
      types
    );
    expect(parcels).toEqual([
      // (100×1 + 10×2) / 3 = 40, + 25 tare
      { parcelKind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 100, weightKg: 65, quantity: 3, stackable: false, loadingMeters: 0.4, description: "A, B" },
    ]);
  });

  it("sums the same article across rows (several följesedlar)", () => {
    const a = article({ id: "a", weight: 1, packageTypeId: "eur", quantityPerPackage: 40 });
    const { parcels } = suggestParcels(
      [
        { articleId: "a", quantity: 30 },
        { articleId: "a", quantity: 30 },
      ],
      map(a),
      types
    );
    expect(parcels[0]!.quantity).toBe(2);
  });

  it("spreads weight without freight description over the packages", () => {
    const a = article({ id: "a", weight: 0, packageTypeId: "eur", quantityPerPackage: 10 });
    const loose = article({ id: "l", name: "Lös", weight: 5 });
    const { parcels, warnings } = suggestParcels(
      [
        { articleId: "a", quantity: 20 },
        { articleId: "l", quantity: 2 },
      ],
      map(a, loose),
      types
    );
    expect(parcels).toHaveLength(1);
    expect(parcels[0]!.weightKg).toBe(30); // 25 tare + 10 kg loose / 2 pallets
    expect(warnings).toContain("Lös saknar fraktsätt");
    expect(warnings).toContain("a saknar vikt");
  });

  it("puts weight without freight description on an Övrigt row when there are no packages", () => {
    const loose = article({ id: "l", name: "Lös", weight: 2.5 });
    const { parcels } = suggestParcels([{ articleId: "l", quantity: 3 }], map(loose), types);
    expect(parcels).toEqual([
      { parcelKind: "other", lengthCm: 0, widthCm: 0, heightCm: 0, weightKg: 7.5, quantity: 1, stackable: false, loadingMeters: null, description: "Övrigt" },
    ]);
  });

  it("warns about missing dimensions on articles and package types", () => {
    const a = article({ id: "a", name: "Halvmått", lengthMm: 100 });
    const flat: ParcelPackageType = { ...EUR, id: "flat", name: "Platt", heightMm: null };
    const b = article({ id: "b", packageTypeId: "flat", quantityPerPackage: 1 });
    const { warnings } = suggestParcels(
      [
        { articleId: "a", quantity: 1 },
        { articleId: "b", quantity: 1 },
      ],
      map(a, b),
      new Map([[flat.id, flat]])
    );
    expect(warnings).toEqual(["Halvmått saknar mått", "Kollitypen Platt saknar mått"]);
  });

  it("skips service articles and zero quantities", () => {
    const s = article({ id: "s", type: "service" });
    const a = article({ id: "a", lengthMm: 1, widthMm: 1, heightMm: 1 });
    const { parcels } = suggestParcels(
      [
        { articleId: "s", quantity: 1 },
        { articleId: "a", quantity: 0 },
      ],
      map(s, a),
      types
    );
    expect(parcels).toEqual([]);
  });

  it("cuts descriptions at 100 characters", () => {
    const long = "x".repeat(150);
    const a = article({ id: "a", name: long, lengthMm: 1, widthMm: 1, heightMm: 1 });
    expect(suggestParcels([{ articleId: "a", quantity: 1 }], map(a), types).parcels[0]!.description).toHaveLength(100);
  });
});
