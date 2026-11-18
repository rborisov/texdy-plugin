import { test } from "node:test";
import assert from "node:assert/strict";
import { readImageIdentity } from "../src/image.ts";

const SLUG = "8c13156003a1";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // the checksum is not checked
};
const itxt = (keyword: string, text: string) =>
  chunk("iTXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")]));
const png = (...extra: Buffer[]) =>
  Buffer.concat([PNG_SIG, chunk("IHDR", Buffer.alloc(13)), ...extra, chunk("IDAT", Buffer.from([1, 2, 3])), chunk("IEND", Buffer.alloc(0))]);

const svg = (attrs: string, body = "A -> B") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><metadata id="uml-portal-source"><source xmlns="urn:uml-portal:source:1" ${attrs}><![CDATA[@startuml\n${body}\n@enduml]]></source></metadata><g/></svg>`;

test("an exported SVG says which diagram it is, and at which version", () => {
  const b = Buffer.from(svg(`diagram-type="sequence" slug="${SLUG}" version="7"`));
  assert.deepEqual(readImageIdentity(b), { slug: SLUG, version: 7 });
});

test("an SVG with a slug and no version", () => {
  assert.deepEqual(readImageIdentity(Buffer.from(svg(`slug="${SLUG}"`))), { slug: SLUG });
});

test("an exported PNG says it in its text chunks", () => {
  const b = png(itxt("uml-portal-source", "@startuml\nA -> B\n@enduml"), itxt("uml-portal-slug", SLUG), itxt("uml-portal-version", "12"));
  assert.deepEqual(readImageIdentity(b), { slug: SLUG, version: 12 });
});

test("a PNG with the slug and no version", () => {
  assert.deepEqual(readImageIdentity(png(itxt("uml-portal-slug", SLUG))), { slug: SLUG });
});

test("a plain picture, or one with no id, gives null", () => {
  assert.equal(readImageIdentity(png()), null);
  assert.equal(readImageIdentity(png(itxt("uml-portal-source", "@startuml\n@enduml"))), null, "source but no slug");
  assert.equal(readImageIdentity(Buffer.from(svg(`diagram-type="class"`))), null);
  assert.equal(readImageIdentity(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>')), null);
});

test("a slug that is mentioned but not carried by the portal's element does not count", () => {
  assert.equal(readImageIdentity(Buffer.from(`<svg><text>slug="${SLUG}" version="3"</text></svg>`)), null);
  // a diagram whose own text looks like the element: only the real one, which comes first, is read
  const tricky = svg(`slug="${SLUG}" version="2"`, `note: <source xmlns="urn:uml-portal:source:1" slug="ffffffffffff" version="9">`);
  assert.deepEqual(readImageIdentity(Buffer.from(tricky)), { slug: SLUG, version: 2 });
});

test("a slug that is not twelve hex characters is not an id", () => {
  assert.equal(readImageIdentity(Buffer.from(svg(`slug="not-a-slug"`))), null);
  assert.equal(readImageIdentity(Buffer.from(svg(`slug="${SLUG}ab"`))), null);
  assert.equal(readImageIdentity(png(itxt("uml-portal-slug", "../../etc/passwd"))), null);
});

test("garbage, truncated and empty input give null, never an error", () => {
  assert.equal(readImageIdentity(Buffer.alloc(0)), null);
  assert.equal(readImageIdentity(Buffer.from("hello")), null);
  assert.equal(readImageIdentity(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null);
  const whole = png(itxt("uml-portal-slug", SLUG));
  for (const cut of [9, 20, 40, whole.length - 30]) assert.doesNotThrow(() => readImageIdentity(whole.subarray(0, cut)));
  const lying = Buffer.concat([PNG_SIG, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("iTXt")]);
  assert.equal(readImageIdentity(lying), null, "a chunk longer than the file");
});

test("a version that is not a plain whole number is dropped, the slug kept", () => {
  assert.deepEqual(readImageIdentity(png(itxt("uml-portal-slug", SLUG), itxt("uml-portal-version", "abc"))), { slug: SLUG });
  assert.deepEqual(readImageIdentity(Buffer.from(svg(`slug="${SLUG}" version="1e9"`))), { slug: SLUG });
});
