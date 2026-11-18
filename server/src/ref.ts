// What the user hands Claude to say which diagram they mean: a slug, the editor's address, a share link, or the path of
// an exported image. This only reads the text; it asks nobody anything. An address is accepted only for the portal the
// plugin is configured for, so that nothing here ever points the plugin at another site.

export type Ref =
  | { kind: "slug"; slug: string }
  | { kind: "editor"; slug: string }
  | { kind: "share"; token: string }
  | { kind: "file"; path: string }
  | { kind: "invalid"; why: string };

const SLUG = /^[0-9a-f]{12}$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const invalid = (why: string): Ref => ({ kind: "invalid", why });

/** `portalBase` is the configured portal address (it may carry a path, such as https://host/uml). */
export function parseRef(ref: string, portalBase: string): Ref {
  const text = ref.trim();
  if (!text) return invalid("nothing was given: pass a slug, the diagram's address in the portal, a share link, or the path of an exported image");
  if (text.includes("\0")) return invalid("that is not a usable path");
  if (SLUG.test(text)) return { kind: "slug", slug: text };

  // a path has no scheme (a Windows drive letter is a path, not a scheme)
  if (!SCHEME.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return { kind: "file", path: text };

  let url: URL;
  let base: URL;
  try {
    url = new URL(text);
    base = new URL(portalBase);
  } catch {
    return invalid("that address could not be read");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid("only http and https addresses of this portal are used");
  if (url.origin !== base.origin) return invalid("that address is not this portal, so it is not used");
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return invalid("that address is not in this portal's path, so it is not used");

  const share = /^#share=(.*)$/.exec(url.hash);
  if (share && SHARE_TOKEN.test(share[1])) return { kind: "share", token: share[1] };
  const d = url.searchParams.get("d");
  if (d && SLUG.test(d)) return { kind: "editor", slug: d };
  return invalid("that address names no diagram (it needs ?d=<slug> or a #share=… link)");
}
