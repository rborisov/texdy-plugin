import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PortalClient } from "../src/portal.ts";
import { buildTools } from "../src/tools.ts";
import { TOKEN, json, startFake, type Handler } from "./fake.ts";

type Content = { type: string; text?: string };
type Result = { content: Content[]; isError?: boolean };
type Doc = { slug: string; title: string; source: string; version: number; diagram_type?: string; chosen_type?: string; foreign?: boolean };

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const COPY = "cccccccccccc";
const SHARE = "Pau-Hx_QLUhzl02wifoEzCEYn4YNekV5";
const EXPIRED = "x".repeat(32);
const SRC = "@startuml\nA -> B\n@enduml";

const text = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// A small portal in memory: the diagrams, their versions, share links.
function portal(initial: Doc[], shares: Record<string, { copy: string; own?: boolean; title: string } | null> = {}) {
  const docs = new Map(initial.map((d) => [d.slug, { ...d }]));
  const calls: string[] = [];
  let next = 1;
  const handler: Handler = (req, res, seen) => {
    calls.push(`${req.method} ${req.url}`);
    const m = /^\/api\/diagrams\/([0-9a-f]{12})(?:\/(.*))?$/.exec(req.url ?? "");
    if (req.method === "POST" && req.url === "/api/diagrams") {
      const b = JSON.parse(seen.body);
      const slug = (0xd00000000000 + next++).toString(16);
      docs.set(slug, { slug, title: b.title, source: b.source, version: 1, chosen_type: b.chosen_type ?? "" });
      return json(res, 201, docs.get(slug));
    }
    if (req.method === "POST" && req.url === "/api/shares/open") {
      const s = shares[JSON.parse(seen.body).token];
      if (!s) return json(res, 404, { error: "This link has expired or does not exist" });
      const d = docs.get(s.copy);
      return json(res, 200, { title: s.title, source: d?.source ?? "", copy: s.copy, ...(s.own ? { own: true } : {}) });
    }
    if (m && req.method === "GET" && !m[2]) {
      const d = docs.get(m[1]);
      if (d?.foreign) return json(res, 403, { error: "Access denied" }); // the real portal answers 403 for someone else's diagram
      return d ? json(res, 200, d) : json(res, 404, { error: "diagram not found" });
    }
    if (m && req.method === "PUT") {
      const d = docs.get(m[1]);
      if (!d) return json(res, 404, { error: "Diagram not found" });
      const b = JSON.parse(seen.body);
      if (b.base_version !== d.version) return json(res, 409, { error: "changed", current_version: d.version });
      Object.assign(d, { source: b.source ?? d.source, version: d.version + 1 });
      return json(res, 200, d);
    }
    json(res, 404, { error: "no route" });
  };
  return { docs, calls, handler };
}

async function session(initial: Doc[], shares?: Parameters<typeof portal>[1], root?: string) {
  const p = portal(initial, shares);
  const f = await startFake(p.handler);
  const tools = buildTools(new PortalClient(f.url, TOKEN), root ? { exportRoot: root } : {});
  const call = async (tool: keyof typeof tools, args: Record<string, unknown> = {}) => {
    const r = (await tools[tool].handler(args)) as Result;
    assert.ok(!JSON.stringify(r).includes(TOKEN), "a result must never hold the API token");
    return r;
  };
  return { ...p, f, call, close: () => f.close() };
}
const doc = (slug: string, title: string, version = 1, source = SRC): Doc => ({ slug, title, source, version });

test("nothing is in focus at first, and the tools say what to do", async () => {
  const s = await session([doc(A, "Shop")]);
  try {
    assert.match(text(await s.call("current_diagram")), /No diagram is in focus/);
    for (const tool of ["get_diagram", "update_diagram", "export_diagram", "show_diagram", "open_diagram"] as const) {
      const args = tool === "update_diagram" ? { source: SRC, base_version: 1 } : {};
      const r = await s.call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.match(text(r), /No diagram in focus: pass a slug, or call focus_diagram/, tool);
    }
    assert.deepEqual(s.calls, [], "nothing was asked of the portal");
  } finally {
    await s.close();
  }
});

test("focus_diagram by slug and by the editor address: the diagram is read and is now in focus", async () => {
  const s = await session([doc(A, "Shop", 3), doc(B, "Other")]);
  try {
    const r = await s.call("focus_diagram", { ref: A });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /Shop/);
    assert.match(text(r), new RegExp(A));
    assert.match(text(r), /version: 3/);
    assert.match(text(r), /@startuml/);
    assert.match(text(await s.call("current_diagram")), new RegExp(`Shop.*${A}`));

    const r2 = await s.call("focus_diagram", { ref: `${s.f.url}/?d=${B}&login=umll_${"x".repeat(43)}` });
    assert.ok(!r2.isError, text(r2));
    assert.match(text(await s.call("current_diagram")), new RegExp(`Other.*${B}`));
    assert.ok(!s.calls.some((c) => c.includes("login")), "a sign-in code is never passed on");
  } finally {
    await s.close();
  }
});

test("the tools default to the focus, and an explicit other slug says it is not the focused one", async () => {
  const s = await session([doc(A, "Shop", 3), doc(B, "Other", 7)]);
  try {
    await s.call("focus_diagram", { ref: A });
    assert.match(text(await s.call("get_diagram")), /title: Shop/);
    const other = text(await s.call("get_diagram", { slug: B }));
    assert.match(other, /title: Other/);
    assert.match(other, /not the focused diagram/);
    assert.match(text(await s.call("get_diagram", { slug: A })), /title: Shop/);
    assert.ok(!/not the focused/.test(text(await s.call("get_diagram", { slug: A }))));
    const u = await s.call("update_diagram", { source: "@startuml\nX -> Y\n@enduml", base_version: 3 });
    assert.ok(!u.isError, text(u));
    assert.equal(s.docs.get(A)!.version, 4);
    assert.equal(s.docs.get(B)!.version, 7, "the other diagram was not touched");
  } finally {
    await s.close();
  }
});

test("create_diagram creates nothing while a diagram is in focus, unless it is deliberately another", async () => {
  const s = await session([doc(A, "Shop")]);
  try {
    await s.call("focus_diagram", { ref: A });
    s.calls.length = 0;
    const refused = await s.call("create_diagram", { title: "Again", source: SRC });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Shop/);
    assert.match(text(refused), /update_diagram/);
    assert.match(text(refused), /another: true/);
    assert.deepEqual(s.calls, [], "the portal was not asked to create");
    assert.equal(s.docs.size, 1);

    const made = await s.call("create_diagram", { title: "Second", source: SRC, another: true });
    assert.ok(!made.isError, text(made));
    assert.equal(s.docs.size, 2);
    assert.match(text(await s.call("current_diagram")), /Second/, "the new diagram is now in focus");
  } finally {
    await s.close();
  }
});

test("with no focus, create_diagram creates and puts the new diagram in focus; the next create is refused", async () => {
  const s = await session([]);
  try {
    const first = await s.call("create_diagram", { title: "One", source: SRC });
    assert.ok(!first.isError, text(first));
    assert.match(text(first), /in focus/i);
    assert.match(text(await s.call("current_diagram")), /One/);
    assert.equal((await s.call("create_diagram", { title: "Two", source: SRC })).isError, true);
    assert.equal(s.docs.size, 1);
  } finally {
    await s.close();
  }
});

test("a share link gives the user's own copy, which is in focus; the token is not kept or shown", async () => {
  const s = await session([doc(COPY, "Shared: Shop", 1, "@startuml\nS -> T\n@enduml")], { [SHARE]: { copy: COPY, title: "Shop" } });
  try {
    const r = await s.call("focus_diagram", { ref: `${s.f.url}/#share=${SHARE}` });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /copy/i);
    assert.match(text(r), /do not reach the original/i);
    assert.match(text(r), new RegExp(COPY));
    assert.ok(!JSON.stringify(r).includes(SHARE));
    assert.match(text(await s.call("current_diagram")), new RegExp(COPY));
    assert.ok(!text(await s.call("current_diagram")).includes(SHARE));
    // the token went in the body, the API token in the header
    const seen = s.f.seen.find((x) => x.path === "/api/shares/open")!;
    assert.deepEqual(JSON.parse(seen.body), { token: SHARE });
    assert.equal(seen.auth, `Bearer ${TOKEN}`);
    assert.ok(!seen.path.includes(SHARE));
  } finally {
    await s.close();
  }
});

test("a share link to the user's own diagram says so, and an expired one is a plain line that leaves the focus alone", async () => {
  const s = await session([doc(A, "Shop"), doc(B, "Mine")], { [SHARE]: { copy: B, own: true, title: "Mine" }, [EXPIRED]: null });
  try {
    await s.call("focus_diagram", { ref: A });
    const own = await s.call("focus_diagram", { ref: `${s.f.url}/#share=${SHARE}` });
    assert.match(text(own), /your own diagram/i);
    assert.match(text(await s.call("current_diagram")), new RegExp(B));

    const expired = await s.call("focus_diagram", { ref: `${s.f.url}/#share=${EXPIRED}` });
    assert.equal(expired.isError, true);
    assert.match(text(expired), /expired|does not exist/i);
    assert.match(text(await s.call("current_diagram")), new RegExp(B), "the focus did not move");
  } finally {
    await s.close();
  }
});

test("an address of another portal, or one that names nothing, is refused without asking any portal", async () => {
  const s = await session([doc(A, "Shop")]);
  try {
    await s.call("focus_diagram", { ref: A });
    s.calls.length = 0;
    for (const ref of [`https://evil.example/?d=${B}`, `https://evil.example/#share=${SHARE}`, `${s.f.url}/`, "", `${s.f.url}/#share=short`]) {
      const r = await s.call("focus_diagram", { ref });
      assert.equal(r.isError, true, ref);
    }
    assert.deepEqual(s.calls, []);
    assert.match(text(await s.call("current_diagram")), new RegExp(A));
  } finally {
    await s.close();
  }
});

test("a diagram that is gone or not the user's (404) leaves the focus as it was; if the focused one disappears, the focus is cleared", async () => {
  const s = await session([doc(A, "Shop")]);
  try {
    await s.call("focus_diagram", { ref: A });
    const missing = await s.call("focus_diagram", { ref: B });
    assert.equal(missing.isError, true);
    assert.match(text(await s.call("current_diagram")), new RegExp(A));
    s.docs.delete(A);
    const gone = await s.call("get_diagram");
    assert.equal(gone.isError, true);
    assert.match(text(await s.call("current_diagram")), /No diagram is in focus/);
  } finally {
    await s.close();
  }
});

test("someone else's diagram (the portal says 403) is explained, not shown as a bare status, and the focus stays", async () => {
  const s = await session([doc(A, "Shop"), { ...doc(B, "Theirs"), foreign: true }]);
  try {
    await s.call("focus_diagram", { ref: A });
    for (const ref of [B, `${s.f.url}/?d=${B}`]) {
      const r = await s.call("focus_diagram", { ref });
      assert.equal(r.isError, true, ref);
      assert.match(text(r), /belongs to someone else/);
      assert.match(text(r), /share link/i, "it says how to get such a diagram");
      assert.ok(!/403/.test(text(r)));
    }
    assert.match(text(await s.call("current_diagram")), new RegExp(A));
  } finally {
    await s.close();
  }
});

test("review: a second read says what changed since the first, as a diff; a first read or no change says nothing", async () => {
  const s = await session([doc(A, "Shop", 5, "@startuml\nA -> B\n@enduml")]);
  try {
    const first = text(await s.call("focus_diagram", { ref: A }));
    assert.ok(!/Changed since/.test(first));
    assert.ok(!/Changed since/.test(text(await s.call("get_diagram"))), "same version, nothing changed");

    const d = s.docs.get(A)!; // the user edits in the portal
    Object.assign(d, { source: "@startuml\nA -> C\n@enduml", version: 8 });
    const second = text(await s.call("get_diagram"));
    assert.match(second, /Changed since you last saw it \(v5 to v8\)/);
    assert.match(second, /- A -> B/);
    assert.match(second, /\+ A -> C/);
    assert.ok(second.indexOf("Changed since") < second.indexOf("source:"), "the change comes before the source");
    assert.ok(!/Changed since/.test(text(await s.call("get_diagram"))), "and it is said once");

    Object.assign(d, { version: 9 }); // a new version with the same text
    assert.ok(!/Changed since/.test(text(await s.call("get_diagram"))));
  } finally {
    await s.close();
  }
});

test("what Claude itself saved is not reported back as a change", async () => {
  const s = await session([doc(A, "Shop", 1)]);
  try {
    await s.call("focus_diagram", { ref: A });
    await s.call("update_diagram", { source: "@startuml\nX -> Y\n@enduml", base_version: 1 });
    assert.ok(!/Changed since/.test(text(await s.call("get_diagram"))));
  } finally {
    await s.close();
  }
});

// ---- images the portal made --------------------------------------------------------------------------------------

const svgFor = (slug: string, version: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="uml-portal-source"><source xmlns="urn:uml-portal:source:1" diagram-type="sequence" slug="${slug}" version="${version}"><![CDATA[@startuml\nA -> B\n@enduml]]></source></metadata></svg>`;

async function project() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "uml-focus-")));
}

test("an exported SVG in the project says which diagram it is, and says when the diagram has moved on", async () => {
  const root = await project();
  await fs.mkdir(path.join(root, "diagrams"));
  await fs.writeFile(path.join(root, "diagrams", `${A}.svg`), svgFor(A, 2));
  const s = await session([doc(A, "Shop", 6)], undefined, root);
  try {
    const r = await s.call("focus_diagram", { ref: `diagrams/${A}.svg` });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /Shop/);
    assert.match(text(r), /file is version 2.*now at version 6/i);
    assert.match(text(await s.call("current_diagram")), new RegExp(A));
    // an absolute path inside the folder is the same file
    const abs = await s.call("focus_diagram", { ref: path.join(root, "diagrams", `${A}.svg`) });
    assert.ok(!abs.isError, text(abs));
  } finally {
    await s.close();
  }
});

test("an exported PNG with the id in its text chunks works the same", async () => {
  const root = await project();
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const itxt = (k: string, v: string) => chunk("iTXt", Buffer.concat([Buffer.from(k), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(v)]));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.alloc(13)),
    itxt("uml-portal-slug", B),
    itxt("uml-portal-version", "1"),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await fs.writeFile(path.join(root, "pic.png"), png);
  const s = await session([doc(B, "Other", 1)], undefined, root);
  try {
    const r = await s.call("focus_diagram", { ref: "pic.png" });
    assert.ok(!r.isError, text(r));
    assert.match(text(await s.call("current_diagram")), new RegExp(B));
    assert.ok(!/file is version/i.test(text(r)), "the version matches: nothing to say");
  } finally {
    await s.close();
  }
});

test("a file with no id, a missing file, and a diagram that is gone leave the focus alone and say why", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "plain.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(root, "gone.svg"), svgFor(B, 1));
  await fs.writeFile(path.join(root, "notes.txt"), "hello");
  const s = await session([doc(A, "Shop")], undefined, root);
  try {
    await s.call("focus_diagram", { ref: A });
    const noId = await s.call("focus_diagram", { ref: "plain.svg" });
    assert.equal(noId.isError, true);
    assert.match(text(noId), /no diagram id/i);
    assert.equal((await s.call("focus_diagram", { ref: "nope.svg" })).isError, true);
    assert.equal((await s.call("focus_diagram", { ref: "gone.svg" })).isError, true);
    assert.equal((await s.call("focus_diagram", { ref: "notes.txt" })).isError, true);
    assert.match(text(await s.call("current_diagram")), new RegExp(A));
  } finally {
    await s.close();
  }
});

test("only files inside the project folder are read, and never through a symlink", async () => {
  const root = await project();
  const outside = await project();
  await fs.writeFile(path.join(outside, "x.svg"), svgFor(A, 1));
  await fs.symlink(outside, path.join(root, "link"));
  await fs.symlink(path.join(outside, "x.svg"), path.join(root, "x.svg"));
  const s = await session([doc(A, "Shop")], undefined, root);
  try {
    for (const ref of ["../x.svg", path.join(outside, "x.svg"), "link/x.svg", "x.svg", "a/../../x.svg"]) {
      const r = await s.call("focus_diagram", { ref });
      assert.equal(r.isError, true, ref);
    }
    assert.deepEqual(s.calls, [], "the portal was never asked");
  } finally {
    await s.close();
  }
});

test("a file over 20 MB is not read", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "huge.svg"), Buffer.alloc(20 * 1024 * 1024 + 1, 32));
  const s = await session([doc(A, "Shop")], undefined, root);
  try {
    const r = await s.call("focus_diagram", { ref: "huge.svg" });
    assert.equal(r.isError, true);
    assert.match(text(r), /too large|20 MB/i);
  } finally {
    await s.close();
  }
});

test("the new inputs: focus_diagram needs a ref, slug is optional where the focus can stand in, create takes another", async () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  const s = (name: keyof typeof tools, key: string, v: unknown) => (tools[name].inputSchema[key] as { safeParse: (x: unknown) => { success: boolean } }).safeParse(v).success;
  assert.equal(s("focus_diagram", "ref", undefined), false);
  assert.equal(s("focus_diagram", "ref", "x"), true);
  for (const name of ["get_diagram", "update_diagram", "export_diagram", "show_diagram", "open_diagram"] as const) {
    assert.equal(s(name, "slug", undefined), true, `${name}: slug optional`);
    assert.equal(s(name, "slug", "../x"), false, `${name}: still a slug when given`);
  }
  assert.equal(s("create_diagram", "another", undefined), true);
  assert.equal(s("create_diagram", "another", true), true);
  assert.equal(s("create_diagram", "another", "yes"), false);
  assert.deepEqual(Object.keys(tools.current_diagram.inputSchema), []);
});
