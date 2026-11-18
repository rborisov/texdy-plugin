import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff } from "../src/diff.ts";

const src = (...lines: string[]) => lines.join("\n");

test("equal texts have no diff", () => {
  assert.equal(lineDiff("a\nb", "a\nb"), null);
  assert.equal(lineDiff("a\r\nb", "a\nb"), null, "line endings are not a change");
  assert.equal(lineDiff("", ""), null);
});

test("a changed line shows what left and what came, with context around it", () => {
  const d = lineDiff(src("1", "2", "3", "B", "5", "6", "7"), src("1", "2", "3", "C", "5", "6", "7"))!;
  assert.deepEqual(d.split("\n"), ["  2", "  3", "- B", "+ C", "  5", "  6"]);
});

test("added and removed lines", () => {
  assert.deepEqual(lineDiff(src("a", "b"), src("a", "b", "c"))!.split("\n"), ["  a", "  b", "+ c"]);
  assert.deepEqual(lineDiff(src("a", "b", "c"), src("a", "c"))!.split("\n"), ["  a", "- b", "  c"]);
  assert.deepEqual(lineDiff("", "x")!.split("\n"), ["+ x"]);
  assert.deepEqual(lineDiff("x", "")!.split("\n"), ["- x"]);
});

test("far apart changes are two hunks, with a mark between them", () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const next = old.slice();
  next[2] = "X2";
  next[17] = "X17";
  const d = lineDiff(old.join("\n"), next.join("\n"))!.split("\n");
  assert.ok(d.includes("- l2") && d.includes("+ X2") && d.includes("- l17") && d.includes("+ X17"));
  assert.ok(d.includes("  ..."), "a gap between the hunks");
  assert.ok(!d.includes("  l9"), "lines far from any change are left out");
});

test("a change longer than the cap is said to be, and not shown", () => {
  const old = Array.from({ length: 300 }, (_, i) => `old${i}`).join("\n");
  const next = Array.from({ length: 300 }, (_, i) => `new${i}`).join("\n");
  const d = lineDiff(old, next, 50)!;
  assert.match(d, /^\(the change is longer than 50 lines; read the new source\)$/);
});

test("moved text is a removal and an addition, and the diff stays correct", () => {
  const d = lineDiff(src("a", "b", "c", "d"), src("d", "a", "b", "c"))!;
  assert.ok(d.includes("+ d") && d.includes("- d"));
});
