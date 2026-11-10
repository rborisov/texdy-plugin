import { build } from "esbuild";
import { readdirSync } from "node:fs";

const tests = process.argv.includes("--tests");

if (tests) {
  const entries = readdirSync("test")
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `test/${f}`);
  await build({
    entryPoints: entries,
    outdir: ".test-build",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
} else {
  await build({
    entryPoints: ["src/index.ts"],
    outfile: "dist/server.mjs",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: false,
    logLevel: "warning",
    // Bundled CJS deps may call require(); give them one in ESM output.
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
  });
}
