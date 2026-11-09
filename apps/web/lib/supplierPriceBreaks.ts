// The most staffel steps one catalog row may carry — the API's zod limit
// (SUPPLIER_PRICE_BREAKS_MAX in packages/shared/src/purchase.ts; the web
// cannot import @navet/shared). supplier-price.test.ts keeps the two equal.
// No imports — the API tests load it.
export const SUPPLIER_PRICE_BREAKS_MAX = 50;
