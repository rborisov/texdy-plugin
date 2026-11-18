import { test } from "node:test";
import assert from "node:assert/strict";
import { Focus } from "../src/focus.ts";

const A = { slug: "aaaaaaaaaaaa", title: "A", version: 1 };

test("nothing is in focus at first; set, get and clear", () => {
  const f = new Focus();
  assert.equal(f.get(), null);
  f.set(A);
  assert.deepEqual(f.get(), A);
  f.set({ slug: "bbbbbbbbbbbb", title: "B", version: 4 });
  assert.equal(f.get()!.slug, "bbbbbbbbbbbb");
  f.clear();
  assert.equal(f.get(), null);
});

test("changeSince: a later version of what was seen gives the diff and the version it was seen at", () => {
  const f = new Focus();
  f.saw(A.slug, 5, "@startuml\nA -> B\n@enduml");
  const c = f.changeSince(A.slug, 8, "@startuml\nA -> C\n@enduml")!;
  assert.equal(c.fromVersion, 5);
  assert.match(c.diff, /- A -> B/);
  assert.match(c.diff, /\+ A -> C/);
});

test("changeSince is null for a first read, the same version, or the same text", () => {
  const f = new Focus();
  assert.equal(f.changeSince(A.slug, 1, "x"), null, "never seen");
  f.saw(A.slug, 5, "x");
  assert.equal(f.changeSince(A.slug, 5, "y"), null, "same version");
  assert.equal(f.changeSince(A.slug, 6, "x"), null, "the text did not change");
  assert.equal(f.changeSince("bbbbbbbbbbbb", 6, "y"), null, "another diagram");
});

test("what was seen is updated by the next saw, so the next diff is against that", () => {
  const f = new Focus();
  f.saw(A.slug, 1, "one");
  f.saw(A.slug, 2, "two");
  assert.equal(f.changeSince(A.slug, 3, "three")!.fromVersion, 2);
});

test("an older version than the one seen is not a change to report", () => {
  const f = new Focus();
  f.saw(A.slug, 5, "x");
  assert.equal(f.changeSince(A.slug, 4, "y"), null);
});

test("at most 20 diagrams are remembered, the oldest first to go", () => {
  const f = new Focus();
  const slug = (i: number) => i.toString(16).padStart(12, "0");
  for (let i = 0; i < 25; i++) f.saw(slug(i), 1, `s${i}`);
  assert.equal(f.changeSince(slug(0), 2, "new"), null, "the first was dropped");
  assert.notEqual(f.changeSince(slug(24), 2, "new"), null, "the last is kept");
  assert.notEqual(f.changeSince(slug(5), 2, "new"), null, "the 20th from the end is kept");
  assert.equal(f.changeSince(slug(4), 2, "new"), null);
});

test("a source over 200 KB is not kept", () => {
  const f = new Focus();
  f.saw(A.slug, 1, "x".repeat(200 * 1024 + 1));
  assert.equal(f.changeSince(A.slug, 2, "y"), null);
  f.saw(A.slug, 1, "x".repeat(200 * 1024));
  assert.notEqual(f.changeSince(A.slug, 2, "y"), null);
});

test("seeing a diagram again counts it as the newest", () => {
  const f = new Focus();
  const slug = (i: number) => i.toString(16).padStart(12, "0");
  for (let i = 0; i < 20; i++) f.saw(slug(i), 1, `s${i}`);
  f.saw(slug(0), 2, "again"); // the oldest is seen again: now it is the newest
  f.saw(slug(99), 1, "extra"); // one too many: the oldest left is slug(1)
  assert.notEqual(f.changeSince(slug(0), 3, "z"), null);
  assert.equal(f.changeSince(slug(1), 2, "z"), null);
});
