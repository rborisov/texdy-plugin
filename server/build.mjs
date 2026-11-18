import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";

// the one place the plugin's version is written: the server reports it, and the update check compares it
const version = JSON.parse(readFileSync("../.claude-plugin/plugin.json", "utf8")).version;
const define = { __PLUGIN_VERSION__: JSON.stringify(version) };

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
    define,
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
    define,
    logLevel: "warning",
    // Bundled CJS deps may call require(); give them one in ESM output.
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
  });
}
