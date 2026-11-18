// The id inside an image the portal made. An exported SVG or PNG carries the diagram's source, slug and version (see
// EmbedSource in the portal's backend, and the editor's "Open file", which reads the same): an SVG in
// <metadata id="uml-portal-source"><source xmlns="urn:uml-portal:source:1" slug="…" version="N">, a PNG in iTXt chunks
// "uml-portal-slug" and "uml-portal-version". Nothing here trusts the file: a value that is not exactly a slug (12 hex
// characters) or a whole number is dropped.

export interface ImageIdentity {
  slug: string;
  version?: number;
}

const SLUG = /^[0-9a-f]{12}$/;
const NAMESPACE = "urn:uml-portal:source:1";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const identity = (slug: string | undefined, version: string | undefined): ImageIdentity | null => {
  if (!slug || !SLUG.test(slug)) return null;
  return version && /^\d{1,9}$/.test(version) ? { slug, version: Number(version) } : { slug };
};

function fromPng(b: Uint8Array): ImageIdentity | null {
  const text = new Map<string, string>();
  let at = PNG_SIGNATURE.length;
  while (at + 8 <= b.length) {
    const len = ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    const start = at + 8;
    if (start + len + 4 > b.length) break; // a chunk longer than the file: stop, keep what was read
    if (type === "iTXt") {
      // keyword \0 compression-flag compression-method language-tag \0 translated-keyword \0 text
      const data = b.subarray(start, start + len);
      const k = data.indexOf(0);
      if (k > 0 && data[k + 1] === 0) {
        let p = k + 3;
        for (let zeros = 0; zeros < 2 && p < data.length; p++) if (data[p] === 0) zeros++;
        text.set(Buffer.from(data.subarray(0, k)).toString("latin1"), Buffer.from(data.subarray(p)).toString("utf8"));
      }
    }
    if (type === "IEND") break;
    at = start + len + 4;
  }
  return identity(text.get("uml-portal-slug"), text.get("uml-portal-version"));
}

function fromSvg(b: Uint8Array): ImageIdentity | null {
  const head = Buffer.from(b.subarray(0, 4 * 1024 * 1024)).toString("utf8");
  if (!head.includes(NAMESPACE)) return null;
  // the first <source> element that declares the portal's namespace comes before the diagram's own text
  for (const m of head.matchAll(/<source\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!attrs.includes(`xmlns="${NAMESPACE}"`)) continue;
    return identity(/\bslug="([^"]*)"/.exec(attrs)?.[1], /\bversion="([^"]*)"/.exec(attrs)?.[1]);
  }
  return null;
}

/** The diagram an exported image is of, or null for a picture that carries no id (or is not one of ours). */
export function readImageIdentity(bytes: Uint8Array): ImageIdentity | null {
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return fromPng(bytes);
  return fromSvg(bytes);
}
