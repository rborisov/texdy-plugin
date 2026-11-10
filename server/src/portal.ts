export class PortalError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown = undefined) {
    super(message);
    this.name = "PortalError";
    this.status = status;
    this.body = body;
  }
}

export interface DiagramRecord {
  slug: string;
  title: string;
  diagramType: string;
  source: string;
  version: number;
  url: string;
}

export interface DiagramSummary {
  slug: string;
  title: string;
  diagramType: string;
  version: number;
  updatedAt?: string;
  url: string;
}

export interface RenderError {
  type: string;
  message: string;
  line?: number;
}

export interface ExportOutcome {
  success: boolean;
  slug: string;
  version: number;
  /** the image file's bytes (SVG text or PNG), present when success is true */
  bytes?: Buffer;
  errors: RenderError[];
}

// The largest image export_diagram will accept from the portal.
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RenderOutcome {
  success: boolean;
  imagePngBase64?: string;
  errors: RenderError[];
}

export function validateConfig(env: Record<string, string | undefined>): {
  baseUrl: string;
  token: string;
} {
  const rawUrl = env.UML_PORTAL_URL?.trim();
  const token = env.UML_PORTAL_TOKEN?.trim();
  if (!rawUrl) throw new Error("UML_PORTAL_URL is required (the portal address, e.g. https://portal.example.com)");
  if (!token) throw new Error("UML_PORTAL_TOKEN is required (a personal token created in the portal)");
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("UML_PORTAL_URL is not a valid URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error("UML_PORTAL_URL must use https (plain http is only allowed for localhost or 127.0.0.1)");
  }
  if (u.username || u.password) {
    throw new Error("UML_PORTAL_URL must not contain credentials");
  }
  return { baseUrl: rawUrl.replace(/\/+$/, ""), token };
}

const SNIPPET_MAX = 120;

// Collapse whitespace, drop tags, cut to a short snippet. Never returns the token.
function snippet(raw: string, token: string): string {
  let s = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (token) s = s.split(token).join("[redacted]");
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + "..." : s;
}

function parseErrors(raw: unknown): RenderError[] {
  const list = Array.isArray(raw) ? (raw as Json[]) : [];
  return list.map((e) => ({
    type: String(e.type ?? "error"),
    message: String(e.message ?? ""),
    ...(typeof e.line === "number" && e.line > 0 ? { line: e.line } : {}),
  }));
}

export interface PortalClientOptions {
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

export class PortalClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(
    baseUrl: string,
    token: string,
    fetchImpl: typeof fetch = fetch,
    opts: PortalClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  urlFor(slug: string): string {
    return `${this.baseUrl}/?d=${encodeURIComponent(slug)}`;
  }

  openUrlFor(slug: string, code: string): string {
    return `${this.urlFor(slug)}&login=${encodeURIComponent(code)}`;
  }

  // One-time sign-in code for the editor link; valid for about a minute.
  async createLinkCode(): Promise<string> {
    const j = await this.request("POST", "/api/auth/link-codes");
    if (typeof j.code !== "string" || !/^umll_[A-Za-z0-9_-]{43}$/.test(j.code)) {
      throw new PortalError("Portal answered with an unexpected link code; update the portal or the plugin", 201);
    }
    return j.code;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Json> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let status = 0;
    let raw: string;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        // Never follow redirects: the server must only talk to the configured host.
        redirect: "manual",
      });
      status = res.status;
      if (status >= 300 && status < 400) {
        let target = "a Location header that is missing or unreadable";
        const loc = res.headers.get("location");
        if (loc) {
          try {
            target = `redirect to ${new URL(loc, this.baseUrl).origin}`;
          } catch {
            /* keep the generic wording; never echo the raw Location */
          }
        }
        void res.body?.cancel().catch(() => {});
        throw new PortalError(
          `Portal answered ${status} (${target}); redirects are not followed, check UML_PORTAL_URL`,
          status,
        );
      }
      raw = await res.text();
    } catch (e) {
      if (e instanceof PortalError) throw e;
      if (ctrl.signal.aborted) {
        throw new PortalError(`Portal request timed out after ${this.timeoutMs} ms`, 0);
      }
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      throw new PortalError(
        `Could not reach the portal${cause ? ` (${cause})` : ""}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = raw.length ? JSON.parse(raw) : undefined;
    } catch {
      throw new PortalError(
        status >= 200 && status < 300
          ? `Portal answered 200 but the body is not valid JSON: ${snippet(raw, this.token)}`
          : `Portal answered ${status} with a non-JSON response: ${snippet(raw, this.token)}`,
        status,
        snippet(raw, this.token),
      );
    }
    if (status < 200 || status >= 300) {
      const err =
        parsed && typeof parsed === "object" && typeof (parsed as Json).error === "string"
          ? snippet((parsed as Json).error as string, this.token)
          : "request failed";
      throw new PortalError(`Portal answered ${status}: ${err}`, status, parsed);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new PortalError("Portal answered with an unexpected JSON body", status, undefined);
    }
    return parsed as Json;
  }

  private record(j: Json): DiagramRecord {
    const slug = String(j.slug ?? "");
    return {
      slug,
      title: String(j.title ?? ""),
      diagramType: String(j.diagram_type ?? ""),
      source: String(j.source ?? ""),
      version: Number(j.version ?? 0),
      url: this.urlFor(slug),
    };
  }

  async render(source: string): Promise<RenderOutcome> {
    const j = await this.request("POST", "/api/render", { source, format: "png" });
    // Checked against the real backend (PlantUML 1.2025.2): `image` is RAW base64
    // of the PNG ("iVBORw0KGgo..."), not a data URI. A data URI prefix is stripped
    // defensively in case that changes.
    // Failed render (real backend): {"success":false,"format":"png","errors":[{"type":"syntax",
    // "message":"String:3:error:Syntax Error? ...","hint":"..."}]}; `line` may be absent.
    const image = typeof j.image === "string" && j.image ? j.image : undefined;
    return {
      success: j.success === true,
      imagePngBase64: image?.replace(/^data:image\/png;base64,/, ""),
      errors: parseErrors(j.errors),
    };
  }

  // exportImage asks the portal for the stored diagram as an image carrying its source,
  // slug and version. The answer is checked against what was asked: the same diagram,
  // the same format, a version number and a real SVG or PNG.
  async exportImage(slug: string, format: "svg" | "png"): Promise<ExportOutcome> {
    const j = await this.request(
      "GET",
      `/api/diagrams/${encodeURIComponent(slug)}/image?format=${format}&embed_source=true`,
    );
    const odd = (why: string) => new PortalError(`Portal answered with an unexpected image: ${why}`, 200);
    if (j.slug !== slug) throw odd("it is about a different diagram");
    if (j.format !== format) throw odd("it is not the format that was asked for");
    if (typeof j.version !== "number" || !Number.isInteger(j.version) || j.version < 1) throw odd("no version number");
    const errors = parseErrors(j.errors);
    if (j.success !== true) return { success: false, slug, version: j.version, errors };

    if (typeof j.image !== "string" || !j.image) throw odd("no image");
    let bytes: Buffer;
    if (format === "svg") {
      if (!j.image.includes("<svg")) throw odd("it is not an SVG");
      bytes = Buffer.from(j.image, "utf8");
    } else {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(j.image)) throw odd("it is not valid base64");
      bytes = Buffer.from(j.image, "base64");
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw odd("it is not a PNG");
    }
    if (bytes.length > MAX_EXPORT_BYTES) throw odd("it is too large");
    return { success: true, slug, version: j.version, bytes, errors };
  }

  // No diagram type is sent, here or in update: PlantUML works out what the source is.
  async create(title: string, source: string): Promise<DiagramRecord> {
    const j = await this.request("POST", "/api/diagrams", { title, source });
    return this.record(j);
  }

  async get(slug: string): Promise<DiagramRecord> {
    return this.record(await this.request("GET", `/api/diagrams/${encodeURIComponent(slug)}`));
  }

  async update(
    slug: string,
    patch: { source: string; baseVersion: number; title?: string },
  ): Promise<DiagramRecord> {
    const j = await this.request("PUT", `/api/diagrams/${encodeURIComponent(slug)}`, {
      source: patch.source,
      base_version: patch.baseVersion,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    });
    return this.record(j);
  }

  async list(): Promise<DiagramSummary[]> {
    const j = await this.request("GET", "/api/diagrams");
    const items = Array.isArray(j.diagrams) ? (j.diagrams as Json[]) : [];
    return items.map((d) => ({
      slug: String(d.slug ?? ""),
      title: String(d.title ?? ""),
      diagramType: String(d.diagram_type ?? ""),
      version: Number(d.version ?? 0),
      updatedAt: typeof d.updated_at === "string" ? d.updated_at : undefined,
      url: this.urlFor(String(d.slug ?? "")),
    }));
  }
}
