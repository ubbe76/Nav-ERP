import { AppShell } from "../../../components/AppShell";
import { PostCalculationBatchPageClient } from "../../../components/manufacturing/PostCalculationBatchPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Efterkalkylera flera (#34) — post-calculate many manufacturing orders at
// once, review actual against calculated and save the marked ones.
export default function PostCalculationBatchPage() {
  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Efterkalkylera flera</div>
          <div className={shellStyles.meta}>Efterkalkylera ett urval tillverkningsordrar, jämför mot kalkylerat och spara de markerade</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="efterkalkylera-flera" label="Hjälp om Efterkalkylera flera" />
      </div>
      <PostCalculationBatchPageClient />
    </AppShell>
  );
}
