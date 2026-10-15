import Link from "next/link";
import { AppShell } from "../../components/AppShell";
import shellStyles from "../../components/AppShell.module.css";

// Where the proxy sends a user who opened a page their behörighetsgrupp
// doesn't cover (or who has no group at all).
export default function NoAccessPage() {
  return (
    <AppShell active="Översikt">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Ingen behörighet</div>
        </div>
      </div>
      <p>Du saknar behörighet till den här sidan. Kontakta en administratör om du behöver åtkomst.</p>
      <p>
        <Link href="/hjalp">Till hjälpen</Link>
      </p>
    </AppShell>
  );
}
