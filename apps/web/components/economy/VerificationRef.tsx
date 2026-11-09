import Link from "next/link";

// A verifikat's number on a document card or list (invoice, payment,
// reminder fee): a link for whoever may open Ekonomi → Verifikat, plain text
// for everyone else — the number alone says the booking exists, which is
// what a seller or buyer needs to see, and it is printed on nothing secret.
export function VerificationRef({
  id,
  displayNumber,
  canOpen,
}: {
  id: string;
  displayNumber: string | null | undefined;
  canOpen: boolean;
}) {
  const text = displayNumber ?? "–";
  return canOpen ? <Link href={`/ekonomi/verifikat/${id}`}>{text}</Link> : <>{text}</>;
}
