import type { ToolDef } from "./tools.ts";

// The server tells the agent, once per session, when a newer plugin is published, so the user hears about it where they
// work. "Published" is the plugin.json of the public repository the plugin is installed from (scripts/publish-plugin.sh
// replaces it on every release), so the answer cannot be ahead of what can be installed. Nothing about the user is sent:
// it is a plain GET of a public file. Whatever comes back is only ever used as a version number (x.y.z), never as text.

// Set by the build from plugin.json (build.mjs), so that the version the server reports and the one published are one.
declare const __PLUGIN_VERSION__: string;
export const PLUGIN_VERSION: string = typeof __PLUGIN_VERSION__ === "string" ? __PLUGIN_VERSION__ : "0.0.0";

export const PUBLISHED_MANIFEST_URL = "https://raw.githubusercontent.com/rborisov/texdy-plugin/main/.claude-plugin/plugin.json";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v: string): number[] | null => {
  const m = VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Whether `latest` is a higher x.y.z than `current`. Anything that is not exactly x.y.z is never newer. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The version in the published plugin.json, or null when it cannot be read or does not look like a version. */
export async function fetchPublishedVersion(
  url: string = PUBLISHED_MANIFEST_URL,
  o: { timeoutMs?: number } = {},
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 3000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.text();
    if (body.length > 100_000) return null;
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === "string" && VERSION.test(version) ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What the agent is told to say to the user. The steps are the user's to run, not the agent's. */
export function updateNotice(current: string, latest: string): string {
  return [
    `Plugin update available: this is the mimosoid plugin ${current}, and ${latest} is published. Tell the user once, in your own words, and do not run these commands yourself:`,
    "- Claude Code: run `claude plugin marketplace update mimosoid-marketplace`, then `claude plugin update mimosoid@mimosoid-marketplace`, then restart Claude Code. To get updates without doing this: /plugin, Marketplaces, mimosoid-marketplace, Enable auto-update.",
    "- Another agent running a git clone of the plugin: run `git pull` in the clone and restart the agent.",
  ].join("\n");
}

/**
 * Starts the check now (in the background) and returns what to ask later: the notice, or null when the plugin is up to
 * date, the check failed, or it is switched off (MIMOSOID_NO_UPDATE_CHECK=1). It asks once however often it is read, and
 * waits only a moment for an answer that has not come.
 */
export function startUpdateCheck(o: {
  current: string;
  url?: string;
  env: Record<string, string | undefined>;
  waitMs?: number;
}): () => Promise<string | null> {
  const off = (o.env.MIMOSOID_NO_UPDATE_CHECK ?? "").toLowerCase();
  if (off === "1" || off === "true") return async () => null;
  const check = fetchPublishedVersion(o.url).then((latest) => (latest && isNewer(latest, o.current) ? updateNotice(o.current, latest) : null));
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), o.waitMs ?? 1500); });
    try {
      return await Promise.race([check, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The same tools, the first result of the session carrying the update notice (when there is one). Nothing else changes. */
export function withUpdateNotice<T extends Record<string, ToolDef>>(tools: T, getNotice: () => Promise<string | null>): T {
  let shown = false;
  const wrapped: Record<string, ToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    wrapped[name] = {
      ...def,
      handler: async (args) => {
        const result = await def.handler(args);
        if (shown) return result;
        const notice = await getNotice();
        if (!notice) return result;
        shown = true;
        return { ...result, content: [...result.content, { type: "text" as const, text: notice }] };
      },
    };
  }
  return wrapped as T;
}
