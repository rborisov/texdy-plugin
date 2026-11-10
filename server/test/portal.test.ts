import { test } from "node:test";
import assert from "node:assert/strict";
import { PortalClient, PortalError, validateConfig } from "../src/portal.ts";
import { TOKEN, json, startFake } from "./fake.ts";

const diagram = {
  slug: "abc123",
  title: "T",
  diagram_type: "sequence",
  source: "@startuml\nA->B\n@enduml",
  version: 3,
};

test("validateConfig: missing URL", () => {
  assert.throws(() => validateConfig({ UML_PORTAL_TOKEN: TOKEN }), /UML_PORTAL_URL/);
});

test("validateConfig: missing token", () => {
  assert.throws(
    () => validateConfig({ UML_PORTAL_URL: "https://d.example.com" }),
    /UML_PORTAL_TOKEN/,
  );
});

test("validateConfig: plain http to a remote host is rejected", () => {
  assert.throws(
    () => validateConfig({ UML_PORTAL_URL: "http://example.com", UML_PORTAL_TOKEN: TOKEN }),
    /https/,
  );
});

test("validateConfig: localhost http and https with trailing slash are accepted", () => {
  assert.deepEqual(
    validateConfig({ UML_PORTAL_URL: "http://localhost:8080", UML_PORTAL_TOKEN: TOKEN }),
    { baseUrl: "http://localhost:8080", token: TOKEN },
  );
  assert.deepEqual(
    validateConfig({ UML_PORTAL_URL: "http://127.0.0.1:8080/", UML_PORTAL_TOKEN: TOKEN }),
    { baseUrl: "http://127.0.0.1:8080", token: TOKEN },
  );
  assert.deepEqual(
    validateConfig({ UML_PORTAL_URL: "https://portal.example.com/uml/", UML_PORTAL_TOKEN: TOKEN }),
    { baseUrl: "https://portal.example.com/uml", token: TOKEN },
  );
});

test("validateConfig: garbage URL is rejected without echoing the token", () => {
  try {
    validateConfig({ UML_PORTAL_URL: "not a url", UML_PORTAL_TOKEN: TOKEN });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!(e as Error).message.includes(TOKEN));
  }
});

test("create: POST /api/diagrams with bearer and JSON body; url is the deep link", async () => {
  const f = await startFake((_q, res) => json(res, 201, diagram));
  try {
    const c = new PortalClient(f.url + "/", TOKEN);
    const d = await c.create("T", "src");
    assert.equal(f.seen[0].method, "POST");
    assert.equal(f.seen[0].path, "/api/diagrams");
    assert.equal(f.seen[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(f.seen[0].body), { title: "T", source: "src" });
    assert.equal(d.url, `${f.url}/?d=abc123`);
    assert.equal(d.diagramType, "sequence"); // a type the portal reports is still read back
    assert.equal(d.version, 3);
  } finally {
    await f.close();
  }
});

test("get: GET /api/diagrams/<slug>", async () => {
  const f = await startFake((_q, res) => json(res, 200, diagram));
  try {
    const d = await new PortalClient(f.url, TOKEN).get("abc123");
    assert.equal(f.seen[0].method, "GET");
    assert.equal(f.seen[0].path, "/api/diagrams/abc123");
    assert.equal(f.seen[0].auth, `Bearer ${TOKEN}`);
    assert.equal(d.source, diagram.source);
    assert.equal(d.url, `${f.url}/?d=abc123`);
  } finally {
    await f.close();
  }
});

test("update: PUT with base_version and optional fields only", async () => {
  const f = await startFake((_q, res) => json(res, 200, { ...diagram, version: 4 }));
  try {
    const d = await new PortalClient(f.url, TOKEN).update("abc123", {
      source: "new",
      baseVersion: 3,
      title: "N",
    });
    assert.equal(f.seen[0].method, "PUT");
    assert.equal(f.seen[0].path, "/api/diagrams/abc123");
    assert.equal(f.seen[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(f.seen[0].body), { source: "new", base_version: 3, title: "N" });
    assert.equal(d.version, 4);
  } finally {
    await f.close();
  }
});

test("list: GET /api/diagrams unwraps {diagrams}", async () => {
  const f = await startFake((_q, res) =>
    json(res, 200, { diagrams: [{ ...diagram, source: undefined, updated_at: "2026-01-01T00:00:00Z" }] }),
  );
  try {
    const l = await new PortalClient(f.url, TOKEN).list();
    assert.equal(f.seen[0].method, "GET");
    assert.equal(f.seen[0].path, "/api/diagrams");
    assert.equal(l.length, 1);
    assert.equal(l[0].slug, "abc123");
    assert.equal(l[0].url, `${f.url}/?d=abc123`);
  } finally {
    await f.close();
  }
});

test("render: POST /api/render png; raw base64 and data URI both yield raw base64", async () => {
  let image = "iVBORw0KGgo=";
  const f = await startFake((_q, res) =>
    json(res, 200, { success: true, image, format: "png", detected_type: "sequence" }),
  );
  try {
    const c = new PortalClient(f.url, TOKEN);
    let r = await c.render("src");
    assert.deepEqual(JSON.parse(f.seen[0].body), { source: "src", format: "png" });
    assert.equal(f.seen[0].path, "/api/render");
    assert.equal(f.seen[0].auth, `Bearer ${TOKEN}`);
    assert.equal(r.imagePngBase64, "iVBORw0KGgo=");
    image = "data:image/png;base64,iVBORw0KGgo=";
    r = await c.render("src");
    assert.equal(r.imagePngBase64, "iVBORw0KGgo=");
  } finally {
    await f.close();
  }
});

test("401 and 409 become PortalError with status and body", async () => {
  const f = await startFake((req, res) => {
    if (req.method === "PUT")
      json(res, 409, { error: "Diagram changed elsewhere", current_version: 7 });
    else json(res, 401, { error: "Unauthorized" });
  });
  try {
    const c = new PortalClient(f.url, TOKEN);
    await assert.rejects(c.get("x"), (e: unknown) => {
      assert.ok(e instanceof PortalError);
      assert.equal(e.status, 401);
      assert.deepEqual(e.body, { error: "Unauthorized" });
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
    await assert.rejects(c.update("x", { source: "s", baseVersion: 1 }), (e: unknown) => {
      assert.ok(e instanceof PortalError);
      assert.equal(e.status, 409);
      assert.deepEqual(e.body, { error: "Diagram changed elsewhere", current_version: 7 });
      return true;
    });
  } finally {
    await f.close();
  }
});

test("HTML error page: short token-free PortalError, no raw page echoed", async () => {
  const page = `<html><body><h1>502 Bad Gateway</h1>${"x".repeat(2000)} ${TOKEN}</body></html>`;
  const f = await startFake((_q, res) => {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end(page);
  });
  try {
    await assert.rejects(new PortalClient(f.url, TOKEN).get("x"), (e: unknown) => {
      assert.ok(e instanceof PortalError);
      assert.equal(e.status, 502);
      assert.ok(e.message.length < 400, `message too long: ${e.message.length}`);
      assert.ok(!e.message.includes(TOKEN));
      assert.ok(!JSON.stringify(e.body).includes(TOKEN));
      assert.ok(!e.message.includes("<html>"));
      return true;
    });
  } finally {
    await f.close();
  }
});

test("200 with non-JSON body is a PortalError", async () => {
  const f = await startFake((_q, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>welcome</html>");
  });
  try {
    await assert.rejects(new PortalClient(f.url, TOKEN).get("x"), (e: unknown) => {
      assert.ok(e instanceof PortalError);
      assert.match(e.message, /not valid JSON/i);
      return true;
    });
  } finally {
    await f.close();
  }
});

test("a socket that never answers times out with a PortalError", async () => {
  const f = await startFake(() => {});
  try {
    const c = new PortalClient(f.url, TOKEN, undefined, { timeoutMs: 100 });
    await assert.rejects(c.get("x"), (e: unknown) => {
      assert.ok(e instanceof PortalError);
      assert.match(e.message, /timed out/i);
      return true;
    });
  } finally {
    await f.close();
  }
});

test("connection refused is a PortalError, not a crash", async () => {
  const f = await startFake(() => {});
  const url = f.url;
  await f.close();
  await assert.rejects(new PortalClient(url, TOKEN).get("x"), (e: unknown) => {
    assert.ok(e instanceof PortalError);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

for (const [status, method, loc] of [
  [302, "get", "origin"],
  [307, "create", "origin"],
  [308, "update", "origin"],
  [302, "get", "same"],
  [302, "get", "missing"],
  [302, "get", "garbage"],
] as const) {
  test(`${status} on ${method} (${loc}) is refused and never followed`, async () => {
    const other = await startFake((_q, res) => json(res, 200, diagram));
    const secret = `${other.url}/steal?token=${TOKEN}&x=1`;
    const f = await startFake((req, res) => {
      const target =
        loc === "origin" ? secret : loc === "same" ? "/elsewhere?q=zzz" : loc === "garbage" ? "http://[bad" : undefined;
      res.writeHead(status, target ? { Location: target } : {});
      res.end();
    });
    try {
      const c = new PortalClient(f.url, TOKEN);
      const p =
        method === "get"
          ? c.get("x")
          : method === "create"
            ? c.create("T", "src")
            : c.update("x", { source: "s", baseVersion: 1 });
      await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof PortalError);
        assert.equal(e.status, status);
        assert.match(e.message, new RegExp(`${status}`));
        assert.match(e.message, /UML_PORTAL_URL/);
        assert.ok(!e.message.includes(TOKEN));
        assert.ok(!e.message.includes("/steal"));
        assert.ok(!e.message.includes("zzz"));
        if (loc === "origin") assert.ok(e.message.includes(other.url));
        return true;
      });
      assert.equal(other.seen.length, 0, "redirect target must receive no request");
      assert.equal(f.seen.length, 1, "redirect must not be followed on the same host either");
    } finally {
      await f.close();
      await other.close();
    }
  });
}

test("createLinkCode: POST /api/auth/link-codes with bearer, returns the code; openUrlFor appends encoded login", async () => {
  const code = "umll_" + "a".repeat(43);
  const f = await startFake((_q, res) => json(res, 201, { code, expires_at: "2026-11-09T10:00:00Z" }));
  try {
    const c = new PortalClient(f.url, TOKEN);
    assert.equal(await c.createLinkCode(), code);
    assert.equal(f.seen[0].method, "POST");
    assert.equal(f.seen[0].path, "/api/auth/link-codes");
    assert.equal(f.seen[0].auth, `Bearer ${TOKEN}`);
    assert.equal(c.openUrlFor("abcdef012345", code), `${c.urlFor("abcdef012345")}&login=${code}`);
    assert.equal(c.openUrlFor("abcdef012345", "a b&c"), `${c.urlFor("abcdef012345")}&login=a%20b%26c`);
  } finally {
    await f.close();
  }
});
