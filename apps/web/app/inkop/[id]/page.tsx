import { redirect } from "next/navigation";

// The order list and card moved to /inkop/ordrar — old links and bookmarks
// land here. A page stub (not a next.config redirect) so static siblings
// like /inkop/inleverans keep winning over the dynamic segment.
export default async function LegacyPurchaseOrderRedirect(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/inkop/ordrar/${id}`);
}
