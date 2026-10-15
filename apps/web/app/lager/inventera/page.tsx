import { redirect } from "next/navigation";

// The single-row adjustment moved to /lager/justering when D2 claimed
// "Inventering" for the count routine — old links and bookmarks land here.
export default function LegacyAdjustmentRedirect() {
  redirect("/lager/justering");
}
