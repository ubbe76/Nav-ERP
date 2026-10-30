// bcrypt cost for stored secrets — user passwords (auth) and API client
// secrets (oauth). 12 rounds is ≈ 0.3 s per hash and per compare: right for a
// login, but every API test that registers and logs in a user paid it twice,
// minutes over the suite. The test runner (vitest sets VITEST in its workers,
// never in production) uses bcrypt's minimum instead. A compare always
// follows the cost stored in the hash it is given.
export const BCRYPT_ROUNDS = process.env.VITEST ? 4 : 12;
