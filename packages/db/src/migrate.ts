import { runMigrations } from "./migrations.js";

// CLI entry for `npm run db:migrate`. The work itself lives in migrations.ts
// so the api container's start command and the test setup can call it too.
runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});
