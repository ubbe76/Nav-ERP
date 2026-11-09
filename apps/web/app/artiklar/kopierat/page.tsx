import { AppShell } from "../../../components/AppShell";
import { CopiedArticlesPageClient } from "../../../components/articles/CopiedArticlesPageClient";

// Kopierat (#28) — the user's own working list of articles: what is in it,
// in the order it was copied, with add/remove/clear and the jump to
// Förkalkylera flera. The client renders the topbar too, since the count in
// it changes with every action.
export default function CopiedArticlesPage() {
  return (
    <AppShell active="Artiklar">
      <CopiedArticlesPageClient />
    </AppShell>
  );
}
