import type { ParcelKind } from "@navet/shared";

// Kolliförslag — pure (no DB imports), ported from ERPNext Sverige Frakt's
// kollin.py. Input rows are delivered quantities in the BASE unit; the same
// article on several rows (several följesedlar) is summed first.

export interface ParcelArticle {
  id: string;
  name: string;
  type: "manufactured" | "purchased" | "service";
  weight: number | null; // kg per base unit
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  parcelKind: ParcelKind | null; // null = Paket
  stackable: boolean;
  loadingMeters: number | null;
  packageTypeId: string | null;
  quantityPerPackage: number | null;
}

export interface ParcelPackageType {
  id: string;
  name: string;
  parcelKind: ParcelKind;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  tareWeight: number | null;
  stackable: boolean;
  loadingMeters: number | null;
}

export interface ParcelDraft {
  parcelKind: ParcelKind;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number; // per parcel
  quantity: number;
  stackable: boolean;
  loadingMeters: number | null; // per unit
  description: string | null;
}

export type FreightMode = "package" | "own" | "none";

const DESCRIPTION_MAX = 100;
const round2 = (n: number) => Math.round(n * 100) / 100;
// mm → cm with one decimal (shipment_parcels is numeric(8,1)).
const mmToCm = (mm: number | null) => (mm === null ? 0 : Math.round(mm) / 10);
const hasAllDimensions = (l: number | null, w: number | null, h: number | null) => !!l && !!w && !!h;

// Fraktsättet is derived, never chosen: a package type with antal per kolli
// wins, otherwise any own dimension, otherwise nothing.
export function freightMode(article: ParcelArticle): FreightMode {
  if (article.packageTypeId && article.quantityPerPackage !== null && article.quantityPerPackage > 0) return "package";
  if (article.lengthMm || article.widthMm || article.heightMm) return "own";
  return "none";
}

export function suggestParcels(
  rows: { articleId: string; quantity: number }[],
  articles: Map<string, ParcelArticle>,
  packageTypes: Map<string, ParcelPackageType>
): { parcels: ParcelDraft[]; warnings: string[] } {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.quantity <= 0) continue;
    totals.set(row.articleId, (totals.get(row.articleId) ?? 0) + row.quantity);
  }

  const own: ParcelDraft[] = [];
  const warnings: string[] = [];
  const packs = new Map<string, { fill: number; weight: number; names: string[] }>();
  let looseWeight = 0;

  for (const [articleId, quantity] of totals) {
    const article = articles.get(articleId);
    if (!article || article.type === "service") continue;
    const weight = article.weight ?? 0;
    if (!article.weight) warnings.push(`${article.name} saknar vikt`);

    const mode = freightMode(article);
    const packageType = mode === "package" ? packageTypes.get(article.packageTypeId!) : undefined;
    if (packageType) {
      const pack = packs.get(packageType.id) ?? { fill: 0, weight: 0, names: [] };
      pack.fill += quantity / article.quantityPerPackage!;
      pack.weight += weight * quantity;
      if (!pack.names.includes(article.name)) pack.names.push(article.name);
      packs.set(packageType.id, pack);
    } else if (mode === "own") {
      if (!hasAllDimensions(article.lengthMm, article.widthMm, article.heightMm)) {
        warnings.push(`${article.name} saknar mått`);
      }
      own.push({
        parcelKind: article.parcelKind ?? "package",
        lengthCm: mmToCm(article.lengthMm),
        widthCm: mmToCm(article.widthMm),
        heightCm: mmToCm(article.heightMm),
        weightKg: round2(weight),
        quantity: Math.ceil(quantity),
        stackable: article.stackable,
        loadingMeters: article.loadingMeters,
        description: article.name.slice(0, DESCRIPTION_MAX),
      });
    } else {
      warnings.push(`${article.name} saknar fraktsätt`);
      looseWeight += weight * quantity;
    }
  }

  const packed: ParcelDraft[] = [];
  for (const [packageTypeId, pack] of packs) {
    const type = packageTypes.get(packageTypeId)!;
    if (!hasAllDimensions(type.lengthMm, type.widthMm, type.heightMm)) {
      warnings.push(`Kollitypen ${type.name} saknar mått`);
    }
    // toFixed(6) absorbs float drift (2.5 + 0.5 = 3.0000000001 is 3 pallets).
    const count = Math.max(1, Math.ceil(Number(pack.fill.toFixed(6))));
    packed.push({
      parcelKind: type.parcelKind,
      lengthCm: mmToCm(type.lengthMm),
      widthCm: mmToCm(type.widthMm),
      heightCm: mmToCm(type.heightMm),
      weightKg: (type.tareWeight ?? 0) + pack.weight / count,
      quantity: count,
      stackable: type.stackable,
      loadingMeters: type.loadingMeters,
      description: pack.names.join(", ").slice(0, DESCRIPTION_MAX),
    });
  }

  if (looseWeight > 0 && packed.length > 0) {
    const perUnit = looseWeight / packed.reduce((sum, p) => sum + p.quantity, 0);
    for (const p of packed) p.weightKg += perUnit;
  } else if (looseWeight > 0) {
    own.push({
      parcelKind: "other",
      lengthCm: 0,
      widthCm: 0,
      heightCm: 0,
      weightKg: round2(looseWeight),
      quantity: 1,
      stackable: false,
      loadingMeters: null,
      description: "Övrigt",
    });
  }
  for (const p of packed) p.weightKg = round2(p.weightKg);

  return { parcels: [...own, ...packed], warnings };
}
