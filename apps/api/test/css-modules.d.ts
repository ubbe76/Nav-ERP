// A few tests import web helpers whose components use CSS modules. Next.js
// declares these for the web build (next-env.d.ts); the api's test
// type-check (tsconfig.test.json) needs the same declaration.
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
