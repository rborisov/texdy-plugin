import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PortalClient, PortalError } from "../src/portal.ts";
import { buildTools } from "../src/tools.ts";
import { exportRoot, writeExport } from "../src/export.ts";
import { TOKEN, json, startFake, type Handler } from "./fake.ts";

const SLUG = "8c13156003a1";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><metadata id="uml-portal-source"><source xmlns="urn:uml-portal:source:1" diagram-type="sequence" slug="${SLUG}" version="7"><![CDATA[@startuml\nA -> B\n@enduml]]></source></metadata></svg>`;
// a real, tiny PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPjPAAWMDAwMAAQiAQHdMkJPAAAAAElFTkSuQmCC";

async function tmp(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "uml-export-")));
}

// ---- the file writer: nothing may land outside the project folder ------------

test("writeExport: default name, creates the folder, writes the exact bytes", async () => {
  const root = await tmp();
  const bytes = Buffer.from(SVG);
  const r = await writeExport(root, undefined, SLUG, "svg", bytes);
  assert.equal(r.relPath, `diagrams/${SLUG}.svg`);
  assert.deepEqual(await fs.readFile(path.join(root, r.relPath)), bytes);
});

test("writeExport: a relative path of the caller's choice, replacing an earlier export", async () => {
  const root = await tmp();
  await writeExport(root, "docs/img/login.svg", SLUG, "svg", Buffer.from("old"));
  const r = await writeExport(root, "docs/img/login.svg", SLUG, "svg", Buffer.from("new"));
  assert.equal(r.relPath, "docs/img/login.svg");
  assert.equal(await fs.readFile(path.join(root, "docs/img/login.svg"), "utf8"), "new");
});

test("writeExport refuses paths that leave the folder or do not fit", async () => {
  const root = await tmp();
  const bad: Array<[string, string]> = [
    ["/etc/x.svg", "absolute path"],
    ["../x.svg", "parent folder"],
    ["a/../../x.svg", "parent folder, hidden"],
    ["diagrams/x.png", "wrong extension for svg"],
    ["diagrams/x", "no extension"],
    ["diagrams/x.svg\0.png", "NUL byte"],
    ["", "empty"],
    ["diagrams/", "a folder, not a file"],
  ];
  for (const [p, why] of bad) {
    await assert.rejects(writeExport(root, p, SLUG, "svg", Buffer.from("x")), PortalError, why);
  }
  assert.deepEqual(await fs.readdir(root), [], "nothing may have been written");
});

test("writeExport refuses to follow a symlink out of the folder", async () => {
  const root = await tmp();
  const outside = await tmp();
  await fs.symlink(outside, path.join(root, "diagrams"));
  await assert.rejects(writeExport(root, undefined, SLUG, "svg", Buffer.from("x")), PortalError);
  assert.deepEqual(await fs.readdir(outside), [], "the symlink target must stay untouched");

  const root2 = await tmp();
  await fs.mkdir(path.join(root2, "diagrams"));
  const victim = path.join(outside, "victim.svg");
  await fs.writeFile(victim, "keep me");
  await fs.symlink(victim, path.join(root2, "diagrams", `${SLUG}.svg`));
  await assert.rejects(writeExport(root2, undefined, SLUG, "svg", Buffer.from("x")), PortalError);
  assert.equal(await fs.readFile(victim, "utf8"), "keep me");
});

test("writeExport will not replace a folder", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "diagrams", `${SLUG}.svg`), { recursive: true });
  await assert.rejects(writeExport(root, undefined, SLUG, "svg", Buffer.from("x")), PortalError);
});

test("exportRoot: the project folder, never the filesystem root", () => {
  assert.equal(exportRoot({ CLAUDE_PROJECT_DIR: "/work/proj" }, "/elsewhere"), "/work/proj");
  assert.equal(exportRoot({}, "/work/proj"), "/work/proj");
  assert.throws(() => exportRoot({}, "/"), PortalError);
  assert.throws(() => exportRoot({ CLAUDE_PROJECT_DIR: "relative/dir" }, "/work"), PortalError);
});

// ---- the client and the tool --------------------------------------------------

async function runExport(handler: Handler, args: Record<string, unknown>, root: string) {
  const f = await startFake(handler);
  try {
    const tools = buildTools(new PortalClient(f.url, TOKEN), { exportRoot: root });
    const res = (await tools.export_diagram.handler(args)) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    assert.ok(!JSON.stringify(res).includes(TOKEN), "result must not contain the token");
    return { res, seen: f.seen };
  } finally {
    await f.close();
  }
}
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const okSVG: Handler = (_q, res) =>
  json(res, 200, { success: true, format: "svg", image: SVG, slug: SLUG, version: 7 });

test("export_diagram saves the SVG in the project and reports path and version, not the picture", async () => {
  const root = await tmp();
  const { res, seen } = await runExport(okSVG, { slug: SLUG }, root);
  assert.ok(!res.isError, text(res));
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].path, `/api/diagrams/${SLUG}/image?format=svg&embed_source=true`);
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(await fs.readFile(path.join(root, `diagrams/${SLUG}.svg`), "utf8"), SVG);
  const t = text(res);
  assert.match(t, new RegExp(`diagrams/${SLUG}\\.svg`));
  assert.match(t, /version 7/);
  assert.ok(!t.includes("<svg"), "the picture itself must not be put into the conversation");
});

test("export_diagram saves a PNG as bytes", async () => {
  const root = await tmp();
  const { res, seen } = await runExport(
    (_q, r) => json(r, 200, { success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }),
    { slug: SLUG, format: "png", path: "img/login.png" },
    root,
  );
  assert.ok(!res.isError, text(res));
  assert.match(seen[0].path, /format=png&embed_source=true/);
  assert.deepEqual(await fs.readFile(path.join(root, "img/login.png")), Buffer.from(PNG_B64, "base64"));
});

test("export_diagram on a diagram that does not render lists the errors and writes nothing", async () => {
  const root = await tmp();
  const { res } = await runExport(
    (_q, r) =>
      json(r, 200, {
        success: false,
        format: "svg",
        slug: SLUG,
        version: 7,
        errors: [{ type: "syntax", message: "Syntax Error?", line: 3 }],
      }),
    { slug: SLUG },
    root,
  );
  assert.equal(res.isError, true);
  assert.match(text(res), /line 3: Syntax Error\?/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("export_diagram: portal errors are readable and nothing is written", async () => {
  for (const [status, body] of [
    [404, { error: "diagram not found" }],
    [401, { error: "Invalid or expired session" }],
    [500, { error: "boom" }],
  ] as const) {
    const root = await tmp();
    const { res } = await runExport((_q, r) => json(r, status, body), { slug: SLUG }, root);
    assert.equal(res.isError, true, String(status));
    assert.match(text(res), new RegExp(String(status)));
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test("export_diagram does not trust an answer about another diagram or a broken image", async () => {
  const root = await tmp();
  for (const payload of [
    { success: true, format: "svg", image: SVG, slug: "ffffffffffff", version: 7 }, // wrong diagram
    { success: true, format: "svg", image: "not an svg", slug: SLUG, version: 7 },
    { success: true, format: "png", image: "bm90IGEgcG5n", slug: SLUG, version: 7 }, // "not a png"
    { success: true, format: "svg", image: SVG, slug: SLUG, version: "7" },           // version not a number
    { success: true, format: "gif", image: SVG, slug: SLUG, version: 7 },             // not what was asked
  ]) {
    const { res } = await runExport((_q, r) => json(r, 200, payload), { slug: SLUG }, root);
    assert.equal(res.isError, true, JSON.stringify(payload).slice(0, 60));
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("export_diagram refuses a bad path before asking the portal for anything", async () => {
  const root = await tmp();
  const { res, seen } = await runExport(okSVG, { slug: SLUG, path: "../escape.svg" }, root);
  assert.equal(res.isError, true);
  assert.equal(seen.length, 0, "no request may be made for a path that cannot be used");
});

test("export_diagram's input schema", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN), { exportRoot: "/x" });
  const schema = z.object(tools.export_diagram.inputSchema);
  assert.ok(schema.safeParse({ slug: SLUG }).success);
  assert.ok(schema.safeParse({ slug: SLUG, format: "png", path: "a/b.png" }).success);
  assert.ok(!schema.safeParse({ slug: "../x" }).success);
  assert.ok(!schema.safeParse({ slug: SLUG, format: "gif" }).success);
});
