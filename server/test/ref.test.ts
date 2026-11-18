import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRef } from "../src/ref.ts";

const SLUG = "0123456789ab";
const TOKEN = "Pau-Hx_QLUhzl02wifoEzCEYn4YNekV5";

test("a bare slug", () => {
  assert.deepEqual(parseRef(SLUG, "https://h"), { kind: "slug", slug: SLUG });
  assert.deepEqual(parseRef(`  ${SLUG}\n`, "https://h"), { kind: "slug", slug: SLUG });
});

test("an editor address of this portal, with a path prefix, parameters or a trailing slash", () => {
  for (const [ref, base] of [
    [`https://h/?d=${SLUG}`, "https://h"],
    [`https://h/uml/?d=${SLUG}`, "https://h/uml"],
    [`https://h/uml/?d=${SLUG}`, "https://h/uml/"],
    [`https://h/?foo=1&d=${SLUG}&bar=2`, "https://h"],
    [`http://127.0.0.1:8080/?d=${SLUG}`, "http://127.0.0.1:8080"],
  ] as const) {
    assert.deepEqual(parseRef(ref, base), { kind: "editor", slug: SLUG }, ref);
  }
});

test("a sign-in code in an address is ignored, never carried on", () => {
  const r = parseRef(`https://h/?d=${SLUG}&login=umll_${"x".repeat(43)}`, "https://h");
  assert.deepEqual(r, { kind: "editor", slug: SLUG });
  assert.ok(!JSON.stringify(r).includes("umll_"));
});

test("a share link, with and without a path prefix; the token is kept, nothing else", () => {
  assert.deepEqual(parseRef(`https://h/#share=${TOKEN}`, "https://h"), { kind: "share", token: TOKEN });
  assert.deepEqual(parseRef(`https://h/uml/#share=${TOKEN}`, "https://h/uml"), { kind: "share", token: TOKEN });
  assert.deepEqual(parseRef(`https://h/uml/?x=1#share=${TOKEN}`, "https://h/uml"), { kind: "share", token: TOKEN });
});

test("an address of another portal is refused, not followed", () => {
  for (const ref of [`https://evil.example/?d=${SLUG}`, `https://h.evil.example/#share=${TOKEN}`, `http://h/?d=${SLUG}`, `https://h:8443/?d=${SLUG}`]) {
    const r = parseRef(ref, "https://h");
    assert.equal(r.kind, "invalid", ref);
  }
  assert.equal(parseRef(`https://h/other/?d=${SLUG}`, "https://h/uml").kind, "invalid", "outside the portal's path");
});

test("addresses that name no diagram, and tokens that cannot be ours", () => {
  for (const ref of ["https://h/", "https://h/?d=nothex", `https://h/?d=${SLUG}0`, "https://h/#share=short", `https://h/#share=${"a".repeat(65)}`, "https://h/#share=has space-in-it-xxxxxxxxxx"]) {
    assert.equal(parseRef(ref, "https://h").kind, "invalid", ref);
  }
  for (const ref of ["ftp://h/?d=" + SLUG, "javascript:alert(1)", "file:///etc/passwd"]) {
    assert.equal(parseRef(ref, "https://h").kind, "invalid", ref);
  }
});

test("a share link wins over an editor parameter in the same address", () => {
  assert.deepEqual(parseRef(`https://h/?d=${SLUG}#share=${TOKEN}`, "https://h"), { kind: "share", token: TOKEN });
});

test("anything else without a scheme is a file path; nothing at all is invalid", () => {
  assert.deepEqual(parseRef("diagrams/shop.svg", "https://h"), { kind: "file", path: "diagrams/shop.svg" });
  assert.deepEqual(parseRef("/Users/me/project/diagrams/x.png", "https://h"), { kind: "file", path: "/Users/me/project/diagrams/x.png" });
  assert.deepEqual(parseRef("my diagram.svg", "https://h"), { kind: "file", path: "my diagram.svg" });
  assert.equal(parseRef("", "https://h").kind, "invalid");
  assert.equal(parseRef("   ", "https://h").kind, "invalid");
  assert.equal(parseRef("a\0b.svg", "https://h").kind, "invalid");
});

test("invalid says why, in a line the agent can pass on", () => {
  const r = parseRef("https://evil.example/?d=" + SLUG, "https://h");
  assert.equal(r.kind, "invalid");
  assert.match((r as { why: string }).why, /not this portal/i);
  assert.ok(!(r as { why: string }).why.includes("\n"));
});
