import { redirect } from "next/navigation";

// The order list and card moved to /forsaljning/ordrar — old links and
// bookmarks land here. A page stub (not a next.config redirect) so static
// siblings like /forsaljning/utleverans keep winning over the dynamic segment.
export default async function LegacySalesOrderRedirect(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/forsaljning/ordrar/${id}`);
}
