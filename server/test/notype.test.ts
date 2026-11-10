import { test } from "node:test";
import assert from "node:assert/strict";
import { PortalClient } from "../src/portal.ts";
import { buildTools } from "../src/tools.ts";
import { TOKEN, json, startFake, type Handler } from "./fake.ts";

const SLUG = "0123456789ab";

async function call(handler: Handler, tool: string, args: Record<string, unknown>) {
  const f = await startFake(handler);
  try {
    const tools = buildTools(new PortalClient(f.url, TOKEN));
    const res = (await tools[tool as keyof typeof tools].handler(args)) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { res, seen: f.seen };
  } finally {
    await f.close();
  }
}
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("no tool lets the caller choose a diagram type: PlantUML decides", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  for (const name of ["render_diagram", "create_diagram", "update_diagram", "export_diagram", "get_diagram", "open_diagram"] as const) {
    assert.ok(!("diagram_type" in tools[name].inputSchema), `${name} must not take diagram_type`);
  }
});

test("create_diagram sends no diagram_type, even if a caller still passes one", async () => {
  const { res, seen } = await call(
    (_q, r) => json(r, 201, { slug: SLUG, title: "T", diagram_type: "", source: "s", version: 1 }),
    "create_diagram",
    { title: "T", source: "@startuml\n[A] --> [B]\n@enduml", diagram_type: "sequence" },
  );
  assert.ok(!res.isError, text(res));
  const body = JSON.parse(seen[0].body);
  assert.ok(!("diagram_type" in body), JSON.stringify(body));
  assert.deepEqual(Object.keys(body).sort(), ["source", "title"]);
});

test("update_diagram sends no diagram_type", async () => {
  const { res, seen } = await call(
    (_q, r) => json(r, 200, { slug: SLUG, title: "T", diagram_type: "", source: "s", version: 2 }),
    "update_diagram",
    { slug: SLUG, source: "@startuml\n@enduml", base_version: 1, diagram_type: "class" },
  );
  assert.ok(!res.isError, text(res));
  assert.ok(!("diagram_type" in JSON.parse(seen[0].body)));
});

test("render_diagram sends no diagram_type", async () => {
  const { seen } = await call(
    (_q, r) => json(r, 200, { success: true, format: "png", image: "iVBORw0KGgo=" }),
    "render_diagram",
    { source: "@startuml\nA -> B\n@enduml", diagram_type: "sequence" },
  );
  assert.ok(!("diagram_type" in JSON.parse(seen[0].body)), seen[0].body);
});

test("get_diagram and list_diagrams do not print an empty type", async () => {
  const got = await call(
    (_q, r) => json(r, 200, { slug: SLUG, title: "T", diagram_type: "", source: "SRC", version: 3 }),
    "get_diagram",
    { slug: SLUG },
  );
  assert.ok(!/^type:/m.test(text(got.res)), text(got.res));
  assert.match(text(got.res), /version: 3/);

  const listed = await call(
    (_q, r) => json(r, 200, { diagrams: [{ slug: SLUG, title: "First", diagram_type: "", version: 2 }] }),
    "list_diagrams",
    {},
  );
  assert.match(text(listed.res), new RegExp(`^${SLUG}  "First"  v2  http`));
});

test("a type the portal does report is still shown", async () => {
  const got = await call(
    (_q, r) => json(r, 200, { slug: SLUG, title: "T", diagram_type: "component", source: "SRC", version: 3 }),
    "get_diagram",
    { slug: SLUG },
  );
  assert.match(text(got.res), /^type: component$/m);
});
