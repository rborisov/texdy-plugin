import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { PortalClient } from "../src/portal.ts";
import { buildTools } from "../src/tools.ts";
import { TOKEN, json, startFake, type Handler } from "./fake.ts";

const SLUG = "8c13156003a1";
// a real, tiny PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPjPAAWMDAwMAAQiAQHdMkJPAAAAAElFTkSuQmCC";

const TOKEN_PART = "Pau-Hx_QLUhzl02wifoEzCEYn4YNekV5";
const LINK = { url: `/i/${TOKEN_PART}.png`, expires_at: "2030-01-02T03:04:05Z", slug: SLUG, version: 7 };

// the picture, and (POST) a link to it
const portal = (image: unknown, link: (r: Parameters<Handler>[1]) => void = (r) => json(r, 201, LINK)): Handler =>
  (req, r) => (req.method === "POST" ? link(r) : json(r, 200, image));

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function show(handler: Handler, args: Record<string, unknown>) {
  const f = await startFake(handler);
  try {
    const tools = buildTools(new PortalClient(f.url, TOKEN));
    const res = (await tools.show_diagram.handler(args)) as { content: Content[]; isError?: boolean };
    return { res, seen: f.seen };
  } finally {
    await f.close();
  }
}
const text = (r: { content: Content[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("show_diagram returns the saved diagram's picture as an image, and says which version it is", async () => {
  const { res, seen } = await show(
    portal({ success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }),
    { slug: SLUG },
  );
  assert.ok(!res.isError, text(res));
  const image = res.content.find((c) => c.type === "image");
  assert.equal(image?.data, PNG_B64);
  assert.equal(image?.mimeType, "image/png");
  assert.match(text(res), new RegExp(`${SLUG}.*version 7`));
  // a picture for looking at: the source need not be embedded in it
  assert.equal(seen[0].method, "GET");
  assert.match(seen[0].path, new RegExp(`^/api/diagrams/${SLUG}/image\\?format=png`));
  assert.ok(!/embed_source=true/.test(seen[0].path), seen[0].path);
});

test("show_diagram also makes an image link, for the user, and gives the markdown to put in the reply", async () => {
  const { res, seen } = await show(
    portal({ success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }),
    { slug: SLUG },
  );
  const post = seen.find((s) => s.method === "POST")!;
  assert.equal(post.path, `/api/diagrams/${SLUG}/image-link`);
  assert.deepEqual(JSON.parse(post.body), { format: "png", ttl_minutes: 15, embed_source: false });
  assert.equal(post.auth, `Bearer ${TOKEN}`);
  // the address is the portal's own (the answer is relative to it)
  const url = new RegExp(`http://127\\.0\\.0\\.1:\\d+/i/${TOKEN_PART}\\.png`);
  assert.match(text(res), url);
  assert.match(text(res), new RegExp(`!\\[[^\\]]*\\]\\(${url.source}\\)`), "the markdown that shows the picture");
  assert.match(text(res), /2030/); // when it stops working
  assert.match(text(res), /15 minutes|until/i);
  // the model still gets the picture
  assert.ok(res.content.some((c) => c.type === "image"));
});

test("show_diagram without image links on the portal still shows the picture, and says so", async () => {
  const { res } = await show(
    portal({ success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }, (r) => json(r, 404, { error: "Not found" })),
    { slug: SLUG },
  );
  assert.ok(!res.isError, text(res));
  assert.ok(res.content.some((c) => c.type === "image"));
  assert.match(text(res), /no image links|does not (support|have)/i);
  assert.ok(!/!\[/.test(text(res)), "no markdown for a link there is not");
});

test("show_diagram reports why no link was made (too many, does not render) and still shows the picture", async () => {
  const { res } = await show(
    portal({ success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }, (r) => json(r, 429, { error: "Too many active image links: wait for one to expire" })),
    { slug: SLUG },
  );
  assert.ok(!res.isError, text(res));
  assert.ok(res.content.some((c) => c.type === "image"));
  assert.match(text(res), /Too many active image links/);
  // a portal answer that is not a link is not trusted
  for (const odd of [{ url: "http://evil.example/x.png", expires_at: "2030-01-02T03:04:05Z" }, { url: "/i/short.png", expires_at: "2030-01-02T03:04:05Z" }, { url: `/i/${TOKEN_PART}.png` }]) {
    const { res: r2 } = await show(
      portal({ success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }, (r) => json(r, 201, odd)),
      { slug: SLUG },
    );
    assert.ok(!/!\[/.test(text(r2)), JSON.stringify(odd));
  }
});

test("show_diagram on a diagram that does not render lists the errors and shows no image", async () => {
  const { res } = await show(
    (_q, r) =>
      json(r, 200, {
        success: false, format: "png", slug: SLUG, version: 3,
        errors: [{ type: "syntax", message: "Syntax Error?", line: 4 }],
      }),
    { slug: SLUG },
  );
  assert.equal(res.isError, true);
  assert.ok(!res.content.some((c) => c.type === "image"));
  assert.match(text(res), /line 4/i);
  assert.match(text(res), /version 3/);
});

test("show_diagram does not trust a broken answer, and reports portal errors readably", async () => {
  for (const payload of [
    { success: true, format: "png", image: PNG_B64, slug: "ffffffffffff", version: 7 }, // another diagram
    { success: true, format: "png", image: "bm90IGEgcG5n", slug: SLUG, version: 7 },    // not a PNG
    { success: true, format: "svg", image: PNG_B64, slug: SLUG, version: 7 },           // not what was asked
  ]) {
    const { res } = await show((_q, r) => json(r, 200, payload), { slug: SLUG });
    assert.equal(res.isError, true, JSON.stringify(payload).slice(0, 50));
    assert.ok(!res.content.some((c) => c.type === "image"));
  }
  for (const status of [401, 404, 500]) {
    const { res } = await show((_q, r) => json(r, status, { error: "nope" }), { slug: SLUG });
    assert.equal(res.isError, true, String(status));
    assert.match(text(res), new RegExp(String(status)));
  }
});

test("show_diagram will not put a huge picture in the chat: it says to export it instead", async () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]);
  const { res } = await show(
    (_q, r) => json(r, 200, { success: true, format: "png", image: big.toString("base64"), slug: SLUG, version: 7 }),
    { slug: SLUG },
  );
  assert.ok(!res.isError, text(res));
  assert.ok(!res.content.some((c) => c.type === "image"));
  assert.match(text(res), /too large/i);
  assert.match(text(res), /export_diagram/);
});

test("show_diagram takes a well-formed slug, or none (then the diagram in focus)", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  const schema = z.object(tools.show_diagram.inputSchema);
  assert.ok(schema.safeParse({ slug: SLUG }).success);
  assert.ok(!schema.safeParse({ slug: "../x" }).success);
  assert.ok(schema.safeParse({}).success);
  assert.deepEqual(Object.keys(tools.show_diagram.inputSchema), ["slug"]);
});
