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

// Two different things: the type PlantUML recognized in the text (diagram_type, never sent by the plugin) and the
// type the user (or the agent on their behalf) chose, which the editor's tools follow (chosen_type).
test("no tool lets the caller set the detected diagram type: PlantUML decides", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  for (const name of ["render_diagram", "create_diagram", "update_diagram", "export_diagram", "get_diagram", "open_diagram"] as const) {
    assert.ok(!("diagram_type" in tools[name].inputSchema), `${name} must not take diagram_type`);
  }
});

test("only create_diagram and update_diagram take a chosen type, optional, from the portal's list of types", () => {
  const tools = buildTools(new PortalClient("http://127.0.0.1:1", TOKEN));
  for (const name of ["create_diagram", "update_diagram"] as const) {
    const schema = tools[name].inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    assert.ok("chosen_type" in schema, `${name} takes chosen_type`);
    assert.ok(schema.chosen_type.safeParse(undefined).success, `${name}: chosen_type is optional`);
    for (const ok of ["sequence", "usecase", "mindmap", "auto"]) assert.ok(schema.chosen_type.safeParse(ok).success, ok);
    for (const bad of ["", "bogus", "UML"]) assert.ok(!schema.chosen_type.safeParse(bad).success, bad);
  }
  for (const name of ["render_diagram", "export_diagram", "get_diagram", "list_diagrams", "open_diagram"] as const) {
    assert.ok(!("chosen_type" in tools[name].inputSchema), `${name} must not take chosen_type`);
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

test("create_diagram sends the chosen type when given, and not when omitted", async () => {
  const reply = (_q: unknown, r: Parameters<Handler>[1]) =>
    json(r, 201, { slug: SLUG, title: "T", diagram_type: "", chosen_type: "mindmap", source: "s", version: 1 });
  const given = await call(reply as Handler, "create_diagram", { title: "T", source: "@startmindmap\n* a\n@endmindmap", chosen_type: "mindmap" });
  assert.ok(!given.res.isError, text(given.res));
  assert.deepEqual(Object.keys(JSON.parse(given.seen[0].body)).sort(), ["chosen_type", "source", "title"]);
  assert.equal(JSON.parse(given.seen[0].body).chosen_type, "mindmap");
  assert.match(text(given.res), /chosen type: mindmap/);

  const omitted = await call(reply as Handler, "create_diagram", { title: "T", source: "@startuml\n@enduml" });
  assert.ok(!("chosen_type" in JSON.parse(omitted.seen[0].body)));
});

test("update_diagram sends the chosen type when given; 'auto' clears it; omitted leaves it alone", async () => {
  const reply = (_q: unknown, r: Parameters<Handler>[1]) =>
    json(r, 200, { slug: SLUG, title: "T", diagram_type: "sequence", chosen_type: "class", source: "s", version: 2 });
  const set = await call(reply as Handler, "update_diagram", { slug: SLUG, source: "@startuml\n@enduml", base_version: 1, chosen_type: "class" });
  assert.ok(!set.res.isError, text(set.res));
  assert.equal(JSON.parse(set.seen[0].body).chosen_type, "class");
  assert.ok(!("diagram_type" in JSON.parse(set.seen[0].body)));

  const auto = await call(reply as Handler, "update_diagram", { slug: SLUG, source: "@startuml\n@enduml", base_version: 1, chosen_type: "auto" });
  assert.equal(JSON.parse(auto.seen[0].body).chosen_type, "", "auto is sent as the empty choice");

  const none = await call(reply as Handler, "update_diagram", { slug: SLUG, source: "@startuml\n@enduml", base_version: 1 });
  assert.ok(!("chosen_type" in JSON.parse(none.seen[0].body)));
});

test("a portal that refuses the chosen type is reported, not hidden", async () => {
  const { res } = await call(
    (_q, r) => json(r, 400, { error: "Unknown diagram type" }),
    "update_diagram",
    { slug: SLUG, source: "@startuml\n@enduml", base_version: 1, chosen_type: "class" },
  );
  assert.ok(res.isError);
  assert.match(text(res), /400.*Unknown diagram type/);
});

test("get_diagram shows the chosen type beside what PlantUML recognized; nothing when none is chosen", async () => {
  const got = await call(
    (_q, r) => json(r, 200, { slug: SLUG, title: "T", diagram_type: "component", chosen_type: "usecase", source: "SRC", version: 3 }),
    "get_diagram",
    { slug: SLUG },
  );
  assert.match(text(got.res), /^type: component$/m);
  assert.match(text(got.res), /^chosen type: usecase$/m);

  const none = await call(
    (_q, r) => json(r, 200, { slug: SLUG, title: "T", diagram_type: "component", chosen_type: "", source: "SRC", version: 3 }),
    "get_diagram",
    { slug: SLUG },
  );
  assert.ok(!/chosen type/.test(text(none.res)), text(none.res));
  // an older portal does not send the field at all
  const old = await call(
    (_q, r) => json(r, 200, { slug: SLUG, title: "T", diagram_type: "component", source: "SRC", version: 3 }),
    "get_diagram",
    { slug: SLUG },
  );
  assert.ok(!/chosen type/.test(text(old.res)), text(old.res));
});

test("list_diagrams marks a diagram that has a chosen type", async () => {
  const { res } = await call(
    (_q, r) =>
      json(r, 200, {
        diagrams: [
          { slug: "a1", title: "One", diagram_type: "component", chosen_type: "usecase", version: 2 },
          { slug: "b2", title: "Two", diagram_type: "sequence", chosen_type: "", version: 1 },
        ],
      }),
    "list_diagrams",
    {},
  );
  const lines = text(res).split("\n");
  assert.match(lines[0], /^a1  "One"  component  chosen:usecase  v2  http/);
  assert.match(lines[1], /^b2  "Two"  sequence  v1  http/);
});
