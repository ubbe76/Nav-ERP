// Bankgiro-style OCR reference: the invoice number's digits + a length digit
// + a Luhn (mod-10) check digit. Pure — no DB, no series row. The length
// digit is the total OCR length (incl. itself and the check digit) mod 10.
export function computeOcrNumber(invoiceNumber: string): string {
  const base = invoiceNumber.replace(/\D/g, "");
  const lengthDigit = (base.length + 2) % 10;
  const withLength = base + String(lengthDigit);
  const checkDigit = luhnCheckDigit(withLength);
  return withLength + String(checkDigit);
}

// The exact inverse of computeOcrNumber above, for an OCR reference somebody
// typed in (or a bank file supplied) before it is looked up as an open item:
// digits only, long enough to carry both control digits, the length digit must
// be the reference's own length mod 10, and the last digit must be the Luhn
// digit of everything before it. Pure — a valid number here says nothing about
// whether any invoice actually carries it (B3: the lookup answers that).
export function validateOcrNumber(ocr: string): boolean {
  if (!/^\d+$/.test(ocr)) return false;
  // 1 base digit + length digit + check digit is the shortest thing
  // computeOcrNumber can produce.
  if (ocr.length < 3) return false;
  if (Number(ocr[ocr.length - 2]) !== ocr.length % 10) return false;
  return luhnCheckDigit(ocr.slice(0, -1)) === Number(ocr[ocr.length - 1]);
}

function luhnCheckDigit(digits: string): number {
  let sum = 0;
  // Double every other digit from the right, starting with the rightmost
  // (which sits immediately left of the future check digit).
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
