// Serienummer (#8 etapp 2): the ONE way a list of serial numbers is written
// out — documents, dialogs and lists all print the same text. Pure; the web
// keeps a copy in apps/web/lib/serials.ts (web-mirrors.shared.test.ts).
//
// Natural order (Swedish, numeric). Numbers with the same prefix and the same
// digit width in an unbroken run of three or more are written as a range,
// "SN-001001–SN-001010"; two in a row are written one by one; the rest are
// listed. Every number is always there — never "m.fl.".

const SERIAL_RANGE_DASH = "–";

function serialParts(serial: string): { prefix: string; digits: string } | null {
  const match = /^(.*?)(\d+)$/s.exec(serial);
  return match ? { prefix: match[1]!, digits: match[2]! } : null;
}

// Whether `next` is the number right after `previous`: same prefix, same
// digit width, value + 1 (BigInt — a serial number can be longer than 15 digits).
function followsSerial(previous: string, next: string): boolean {
  const a = serialParts(previous);
  const b = serialParts(next);
  if (!a || !b) return false;
  if (a.prefix !== b.prefix || a.digits.length !== b.digits.length) return false;
  return BigInt(b.digits) === BigInt(a.digits) + 1n;
}

export function sortSerialNumbers(numbers: readonly string[]): string[] {
  return [...new Set(numbers)].sort((a, b) => a.localeCompare(b, "sv", { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0));
}

// The groups behind the text: each a single number or a run (first, last, count).
export function serialNumberRuns(numbers: readonly string[]): { first: string; last: string; count: number }[] {
  const runs: { first: string; last: string; count: number }[] = [];
  for (const serial of sortSerialNumbers(numbers)) {
    const run = runs[runs.length - 1];
    if (run && followsSerial(run.last, serial)) {
      run.last = serial;
      run.count += 1;
    } else {
      runs.push({ first: serial, last: serial, count: 1 });
    }
  }
  return runs;
}

export function compressSerialNumbers(numbers: readonly string[]): string {
  return serialNumberRuns(numbers)
    .flatMap((run) =>
      run.count === 1 ? [run.first] : run.count === 2 ? [run.first, run.last] : [`${run.first}${SERIAL_RANGE_DASH}${run.last}`]
    )
    .join(", ");
}
