import { test } from "node:test";
import assert from "node:assert/strict";
import { PortalClient } from "../src/portal.ts";
import { buildTools, TOOL_NAMES } from "../src/tools.ts";
import { TOKEN, json, startFake, type Handler } from "./fake.ts";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Content[]; isError?: boolean };

async function run(
  handler: Handler,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Result> {
  const f = await startFake(handler);
  try {
    const tools = buildTools(new PortalClient(f.url, TOKEN, undefined, { timeoutMs }));
    const res = (await tools[tool as keyof typeof tools].handler(args)) as Result;
    const all = JSON.stringify(res);
    assert.ok(!all.includes(TOKEN), "result must not contain the token");
    return res;
  } finally {
    await f.close();
  }
}

const text = (r: Result) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

test("exposes exactly the seven tools", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  assert.deepEqual(Object.keys(tools).sort(), [...TOOL_NAMES].sort());
  assert.deepEqual(
    [...TOOL_NAMES].sort(),
    ["create_diagram", "export_diagram", "get_diagram", "list_diagrams", "open_diagram", "render_diagram", "update_diagram"],
  );
});

test("update_diagram requires base_version", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  const schema = tools.update_diagram.inputSchema;
  assert.ok("base_version" in schema);
  assert.equal(schema.base_version.safeParse(undefined).success, false);
  assert.equal(schema.base_version.safeParse(3).success, true);
});

test("update_diagram base_version must be a positive integer (0 means unchecked to the backend)", () => {
  const schema = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN)).update_diagram.inputSchema;
  for (const bad of [0, -1, 1.5]) {
    assert.equal(schema.base_version.safeParse(bad).success, false, `rejects ${bad}`);
  }
  assert.equal(schema.base_version.safeParse(1).success, true);
});

test("get_diagram and update_diagram reject malformed slugs before any request", async () => {
  let requests = 0;
  const f = await startFake((_q, res) => {
    requests++;
    json(res, 200, {});
  });
  try {
    const tools = buildTools(new PortalClient(f.url, TOKEN));
    for (const name of ["get_diagram", "update_diagram"] as const) {
      const schema = tools[name].inputSchema;
      for (const bad of ["../x", "abc", "ABCDEF012345", "abcdef0123456"]) {
        assert.equal(schema.slug.safeParse(bad).success, false, `${name} rejects ${bad}`);
      }
      assert.equal(schema.slug.safeParse("abcdef012345").success, true);
    }
    assert.equal(requests, 0);
  } finally {
    await f.close();
  }
});

test("update_diagram 409: error naming current_version with the current source", async () => {
  const current = {
    slug: "abcdef012345",
    title: "T",
    diagram_type: "sequence",
    source: "@startuml\nCURRENT SOURCE\n@enduml",
    version: 9,
  };
  const r = await run(
    (req, res) => {
      if (req.method === "PUT")
        json(res, 409, { error: "Diagram changed elsewhere", current_version: 9 });
      else json(res, 200, current);
    },
    "update_diagram",
    { slug: "abcdef012345", source: "mine", base_version: 2 },
  );
  assert.equal(r.isError, true);
  assert.match(text(r), /current_version/);
  assert.match(text(r), /9/);
  assert.ok(text(r).includes("CURRENT SOURCE"));
});

test("update_diagram success reports new version and link", async () => {
  const r = await run(
    (_q, res) =>
      json(res, 200, { slug: "abcdef012345", title: "T", diagram_type: "sequence", source: "s", version: 4 }),
    "update_diagram",
    { slug: "abcdef012345", source: "s", base_version: 3 },
  );
  assert.notEqual(r.isError, true);
  assert.match(text(r), /version 4/i);
  assert.match(text(r), /\/\?d=abcdef012345/);
});

test("render_diagram success returns a PNG image block", async () => {
  const r = await run(
    (_q, res) => json(res, 200, { success: true, image: "iVBORw0KGgo=", format: "png" }),
    "render_diagram",
    { source: "@startuml\nA->B\n@enduml" },
  );
  assert.notEqual(r.isError, true);
  const img = r.content.find((c) => c.type === "image");
  assert.ok(img);
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.data, "iVBORw0KGgo=");
});

test("render_diagram failure lists errors with line numbers", async () => {
  const r = await run(
    (_q, res) =>
      json(res, 200, {
        success: false,
        format: "png",
        errors: [
          { type: "syntax", message: "Syntax Error?", line: 3 },
          { type: "syntax", message: "No line here" },
        ],
      }),
    "render_diagram",
    { source: "bad" },
  );
  assert.equal(r.isError, true);
  assert.equal(r.content.find((c) => c.type === "image"), undefined);
  assert.match(text(r), /line 3.*Syntax Error\?/);
  assert.match(text(r), /No line here/);
});

test("create_diagram returns slug, version and deep link", async () => {
  const r = await run(
    (_q, res) =>
      json(res, 201, { slug: "0123456789ab", title: "T", diagram_type: "class", source: "s", version: 1 }),
    "create_diagram",
    { title: "T", source: "s" },
  );
  assert.match(text(r), /0123456789ab/);
  assert.match(text(r), /\/\?d=0123456789ab/);
});

test("get_diagram returns source and version", async () => {
  const r = await run(
    (_q, res) =>
      json(res, 200, { slug: "0123456789ab", title: "T", diagram_type: "class", source: "THE SRC", version: 5 }),
    "get_diagram",
    { slug: "0123456789ab" },
  );
  assert.ok(text(r).includes("THE SRC"));
  assert.match(text(r), /5/);
});

test("list_diagrams lists slug, title, version", async () => {
  const r = await run(
    (_q, res) =>
      json(res, 200, {
        diagrams: [{ slug: "a1", title: "First", diagram_type: "class", version: 2 }],
      }),
    "list_diagrams",
    {},
  );
  assert.match(text(r), /a1/);
  assert.match(text(r), /First/);
});

test("portal answering an HTML 502 page gives a readable isError result", async () => {
  const r = await run(
    (_q, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(`<html><h1>502 Bad Gateway</h1>nginx ${TOKEN}</html>`);
    },
    "get_diagram",
    { slug: "aaaaaaaaaaaa" },
  );
  assert.equal(r.isError, true);
  assert.match(text(r), /502/);
  assert.ok(text(r).length < 500);
  assert.ok(!text(r).includes("<html>"));
});

test("non-JSON 200 gives a readable isError result", async () => {
  const r = await run(
    (_q, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>hello</html>");
    },
    "list_diagrams",
    {},
  );
  assert.equal(r.isError, true);
  assert.match(text(r), /not valid JSON/i);
});

test("a portal that never answers gives a timeout isError result", async () => {
  const r = await run(() => {}, "get_diagram", { slug: "aaaaaaaaaaaa" }, 100);
  assert.equal(r.isError, true);
  assert.match(text(r), /timed out/i);
});

test("401 gives an isError result without the token", async () => {
  const r = await run((_q, res) => json(res, 401, { error: "Unauthorized" }), "list_diagrams", {});
  assert.equal(r.isError, true);
  assert.match(text(r), /401/);
});

test("a redirecting portal gives an isError result naming only the origin", async () => {
  const other = await startFake((_q, res) => json(res, 200, {}));
  try {
    const r = await run(
      (_q, res) => {
        res.writeHead(307, { Location: `${other.url}/p?token=${TOKEN}` });
        res.end();
      },
      "create_diagram",
      { title: "T", source: "s" },
    );
    assert.equal(r.isError, true);
    assert.ok(text(r).includes(other.url));
    assert.ok(!text(r).includes("/p?"));
    assert.equal(other.seen.length, 0);
  } finally {
    await other.close();
  }
});

const CODE = "umll_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_x";

test("open_diagram link equals create_diagram's link plus &login=<code>", async () => {
  const slugValue = "0123456789ab";
  const created = await run(
    (_q, res) =>
      json(res, 201, { slug: slugValue, title: "T", diagram_type: "class", source: "s", version: 1 }),
    "create_diagram",
    { title: "T", source: "s" },
  );
  const plain = /Open in the editor: (\S+)/.exec(text(created))![1];
  let seenReq: { method: string; path: string; auth?: string } | undefined;
  const r = await run(
    (req, res) => {
      seenReq = { method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization };
      json(res, 201, { code: CODE, expires_at: "2026-11-09T10:00:00Z" });
    },
    "open_diagram",
    { slug: slugValue },
  );
  assert.notEqual(r.isError, true);
  assert.equal(seenReq?.method, "POST");
  assert.equal(seenReq?.path, "/api/auth/link-codes");
  // the two fake portals listen on different ports; compare after the origin
  const tail = (u: string) => u.slice(u.indexOf("/?d="));
  const link = /(http\S+)/.exec(text(r))![1];
  assert.equal(tail(link), `${tail(plain)}&login=${CODE}`);
  assert.match(text(r), /once.*minute/i);
});

test("open_diagram rejects malformed slugs before any request", async () => {
  let requests = 0;
  const f = await startFake((_q, res) => {
    requests++;
    json(res, 201, { code: CODE });
  });
  try {
    const schema = buildTools(new PortalClient(f.url, TOKEN)).open_diagram.inputSchema;
    for (const bad of ["../x", "abc", "ABCDEF012345", "abcdef0123456"]) {
      assert.equal(schema.slug.safeParse(bad).success, false, `rejects ${bad}`);
    }
    assert.equal(schema.slug.safeParse("abcdef012345").success, true);
    assert.equal(requests, 0);
  } finally {
    await f.close();
  }
});

test("open_diagram 401, 403 and 429 become readable isError results", async () => {
  for (const [status, re] of [
    [401, /401/],
    [403, /403/],
    [429, /too many unopened links, wait a minute/],
  ] as const) {
    const r = await run((_q, res) => json(res, status, { error: "nope" }), "open_diagram", {
      slug: "aaaaaaaaaaaa",
    });
    assert.equal(r.isError, true, String(status));
    assert.match(text(r), re);
  }
});

test("open_diagram: HTML 502, timeout and redirect give isError without the token", async () => {
  const bad = await run(
    (_q, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(`<html><h1>502 Bad Gateway</h1>${TOKEN}</html>`);
    },
    "open_diagram",
    { slug: "aaaaaaaaaaaa" },
  );
  assert.equal(bad.isError, true);
  assert.match(text(bad), /502/);
  const slow = await run(() => {}, "open_diagram", { slug: "aaaaaaaaaaaa" }, 100);
  assert.equal(slow.isError, true);
  assert.match(text(slow), /timed out/i);
  const other = await startFake((_q, res) => json(res, 200, {}));
  try {
    const red = await run(
      (_q, res) => {
        res.writeHead(307, { Location: `${other.url}/p?token=${TOKEN}` });
        res.end();
      },
      "open_diagram",
      { slug: "aaaaaaaaaaaa" },
    );
    assert.equal(red.isError, true);
    assert.ok(!text(red).includes(TOKEN));
    assert.equal(other.seen.length, 0);
  } finally {
    await other.close();
  }
});

test("open_diagram refuses a malformed code from the portal", async () => {
  for (const body of [{}, { code: 5 }, { code: "umll_short" }, { code: "x&login=evil" }, { code: CODE + "&a=b" }]) {
    const r = await run((_q, res) => json(res, 201, body), "open_diagram", { slug: "aaaaaaaaaaaa" });
    assert.equal(r.isError, true, JSON.stringify(body));
    assert.ok(!text(r).includes("evil"));
    assert.ok(!text(r).includes("&a=b"));
  }
});

test("open_diagram description says one-time, about a minute, and plain link is for sharing", () => {
  const d = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN)).open_diagram.description;
  assert.match(d, /signed in/i);
  assert.match(d, /once/i);
  assert.match(d, /minute/i);
  assert.match(d, /create_diagram/);
  assert.match(d, /shar/i);
});
