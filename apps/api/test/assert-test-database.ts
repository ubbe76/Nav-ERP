// Safety gate: these tests TRUNCATE every table in the database that
// DATABASE_URL points at, and packages/db falls back to the *development*
// database when the variable is unset. Running the suite without the
// variable once wiped real data, so the run aborts instead.
//
// Called from both global-setup.ts (once, before anything touches the
// database) and setup.ts (per test file) — deliberately belt and braces,
// since removing either must not silently disarm the check.
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";

  if (!/test/i.test(dbName)) {
    throw new Error(
      `Testerna TRUNCATE:ar databasen de körs mot. DATABASE_URL pekar på "${
        dbName || "(osatt → utvecklingsdatabasen)"
      }" — kör med DATABASE_URL=postgresql://erp:erp_dev_password@localhost:5433/erp_test (eller använd npm run test).`
    );
  }
}
