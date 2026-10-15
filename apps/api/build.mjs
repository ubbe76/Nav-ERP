// Production bundle for the API. Bundles our own workspace packages
// (@navet/db, @navet/shared — consumed as raw TS via "main": "./src/index.ts"
// in dev, so they have no build output of their own to point Node at in the
// image) while keeping every real npm dependency external (installed
// normally in node_modules, no reason to duplicate them into the bundle).
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const bundledWorkspacePackages = new Set(["@navet/db", "@navet/shared"]);

const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !bundledWorkspacePackages.has(name)
);

// @navet/db gets bundled in, so its own dependencies (drizzle-orm, postgres)
// need to stay external too — otherwise esbuild would bundle those in as well.
external.push("drizzle-orm", "postgres");

await esbuild.build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  target: "node20",
  external,
});
