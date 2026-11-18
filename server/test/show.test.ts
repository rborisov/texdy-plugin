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
    (_q, r) => json(r, 200, { success: true, format: "png", image: PNG_B64, slug: SLUG, version: 7 }),
    { slug: SLUG },
  );
  assert.ok(!res.isError, text(res));
  const image = res.content.find((c) => c.type === "image");
  assert.equal(image?.data, PNG_B64);
  assert.equal(image?.mimeType, "image/png");
  assert.match(text(res), new RegExp(`${SLUG}.*version 7`));
  // a picture for looking at: the source need not be embedded in it
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.match(seen[0].path, new RegExp(`^/api/diagrams/${SLUG}/image\\?format=png`));
  assert.ok(!/embed_source=true/.test(seen[0].path), seen[0].path);
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

test("show_diagram takes only a well-formed slug", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  const schema = z.object(tools.show_diagram.inputSchema);
  assert.ok(schema.safeParse({ slug: SLUG }).success);
  assert.ok(!schema.safeParse({ slug: "../x" }).success);
  assert.ok(!schema.safeParse({}).success);
  assert.deepEqual(Object.keys(tools.show_diagram.inputSchema), ["slug"]);
});
