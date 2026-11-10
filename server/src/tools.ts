import { z } from "zod";
import { PortalClient, PortalError, type RenderError } from "./portal.ts";
import { exportRoot, planExport, writeExport } from "./export.ts";

export const TOOL_NAMES = [
  "render_diagram",
  "create_diagram",
  "get_diagram",
  "update_diagram",
  "list_diagrams",
  "open_diagram",
  "export_diagram",
] as const;

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  [key: string]: unknown;
  content: Content[];
  isError?: boolean;
}

export interface ToolDef {
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: any) => Promise<ToolResult>;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const slug = z
  .string()
  .regex(/^[0-9a-f]{12}$/, "slug must be 12 lowercase hex characters (the id in the ?d=<slug> link)")
  .describe("Diagram slug: 12 lowercase hex characters (the id in the ?d=<slug> link)");
// "Errors:" text for a diagram that did not render, with PlantUML's line numbers.
const errorLines = (errors: RenderError[]) =>
  "Errors:\n" + errors.map((e) => `- ${e.line ? `line ${e.line}: ` : ""}${e.message}`).join("\n");

function errorResult(e: unknown): ToolResult {
  if (e instanceof PortalError) return fail(e.message);
  return fail("Unexpected error in the MCP server while talking to the portal");
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}

export interface ToolOptions {
  /** where export_diagram may write; default: the project folder (see exportRoot) */
  exportRoot?: string;
}

export function buildTools(
  client: PortalClient,
  opts: ToolOptions = {},
): Record<(typeof TOOL_NAMES)[number], ToolDef> {
  return {
    render_diagram: {
      description:
        "Render PlantUML source to a PNG image without saving anything. Returns the image, or syntax errors with line numbers.",
      inputSchema: {
        source: z.string().min(1).describe("PlantUML source including @startuml/@enduml"),
      },
      handler: ({ source }) =>
        guard(async () => {
          const r = await client.render(source);
          const content: Content[] = [];
          if (r.imagePngBase64) {
            content.push({ type: "image", data: r.imagePngBase64, mimeType: "image/png" });
          }
          if (r.errors.length) {
            content.push({ type: "text", text: errorLines(r.errors) });
          } else if (!r.success) {
            content.push({ type: "text", text: "Render failed without details." });
          } else {
            content.push({ type: "text", text: "Rendered OK." });
          }
          return { content, ...(r.success ? {} : { isError: true }) };
        }),
    },

    create_diagram: {
      description:
        "Save a new diagram in the portal. Returns its slug, version and an editor link the user can open.",
      inputSchema: {
        title: z.string().min(1).describe("Diagram title"),
        source: z.string().min(1).describe("PlantUML source"),
      },
      handler: ({ title, source }) =>
        guard(async () => {
          const d = await client.create(title, source);
          return ok(
            `Created diagram "${d.title}" (slug ${d.slug}, version ${d.version}).\nOpen in the editor: ${d.url}`,
          );
        }),
    },

    get_diagram: {
      description:
        "Read a diagram's current source, title, type and version. Use its version as base_version when updating.",
      inputSchema: { slug },
      handler: ({ slug }) =>
        guard(async () => {
          const d = await client.get(slug);
          // the type is PlantUML's to decide: shown only when the portal has recorded one
          const type = d.diagramType ? `type: ${d.diagramType}\n` : "";
          return ok(`title: ${d.title}\n${type}version: ${d.version}\nurl: ${d.url}\n\nsource:\n${d.source}`);
        }),
    },

    update_diagram: {
      description:
        "Update a diagram's source (and optionally title or type). base_version is required: pass the version you last read. If the diagram changed elsewhere, you get the current version and source back to merge.",
      inputSchema: {
        slug,
        source: z.string().min(1).describe("Full new PlantUML source"),
        base_version: z.number().int().min(1).describe("The version you based this edit on (a positive integer)"),
        title: z.string().min(1).optional(),
      },
      handler: ({ slug, source, base_version, title }) =>
        guard(async () => {
          try {
            const d = await client.update(slug, {
              source,
              baseVersion: base_version,
              title,
            });
            return ok(`Updated diagram ${d.slug} to version ${d.version}.\nOpen in the editor: ${d.url}`);
          } catch (e) {
            if (!(e instanceof PortalError) || e.status !== 409) throw e;
            const body = e.body as { current_version?: unknown } | undefined;
            let current_version = typeof body?.current_version === "number" ? body.current_version : undefined;
            let sourceText = "";
            try {
              const cur = await client.get(slug);
              current_version = cur.version;
              sourceText = `\n\ncurrent source:\n${cur.source}`;
            } catch {
              sourceText = "\n\n(could not fetch the current source; call get_diagram)";
            }
            return fail(
              `Conflict: the diagram changed elsewhere. Your base_version was ${base_version}; current_version: ${current_version ?? "unknown"}. ` +
                `Merge your changes into the current source and call update_diagram again with base_version ${current_version ?? "<current_version>"}.` +
                sourceText,
            );
          }
        }),
    },

    list_diagrams: {
      description: "List your diagrams (slug, title, type, version, editor link). Source is not included; use get_diagram.",
      inputSchema: {},
      handler: () =>
        guard(async () => {
          const l = await client.list();
          if (!l.length) return ok("No diagrams yet.");
          return ok(
            l
              .map((d) => `${d.slug}  "${d.title}"  ${d.diagramType ? d.diagramType + "  " : ""}v${d.version}  ${d.url}`)
              .join("\n"),
          );
        }),
    },

    open_diagram: {
      description:
        "Get a link that opens the diagram in the portal editor already signed in. The link works once and only for about a minute, so give it to the user right away and do not store or share it. For a link to share or print, use the plain link from create_diagram or get_diagram instead.",
      inputSchema: { slug },
      handler: ({ slug }) =>
        guard(async () => {
          let code: string;
          try {
            code = await client.createLinkCode();
          } catch (e) {
            if (e instanceof PortalError && e.status === 429) {
              return fail("Portal answered 429: too many unopened links, wait a minute");
            }
            throw e;
          }
          return ok(
            `Open in the editor (signed in): ${client.openUrlFor(slug, code)}\nThis link works once and for about a minute; open it right away.`,
          );
        }),
    },
    export_diagram: {
      description:
        "Save the diagram as an SVG (default) or PNG file in the project folder, by default diagrams/<slug>.svg. The file records the diagram's slug, its version and its PlantUML source, so it can later be compared with get_diagram's version to see whether it is outdated. Returns the path and version, not the picture. Call it after create_diagram or update_diagram, and again when the user asks you to review their changes in the portal.",
      inputSchema: {
        slug,
        format: z.enum(["svg", "png"]).default("svg").describe("svg (default) or png"),
        path: z
          .string()
          .optional()
          .describe("File path relative to the project folder; must end in .svg or .png to match the format. Default: diagrams/<slug>.<format>"),
      },
      handler: ({ slug, format, path: requested }) =>
        guard(async () => {
          const fmt: "svg" | "png" = format === "png" ? "png" : "svg";
          const root = opts.exportRoot ?? exportRoot(process.env, process.cwd());
          planExport(root, requested, slug, fmt); // refuse a bad path before asking the portal for anything
          const out = await client.exportImage(slug, fmt);
          if (!out.success || !out.bytes) {
            return fail(
              (out.errors.length ? errorLines(out.errors) : "The diagram does not render.") +
                `\n(diagram ${slug}, version ${out.version}; nothing was saved)`,
            );
          }
          const saved = await writeExport(root, requested, slug, fmt, out.bytes);
          return ok(
            `Saved ${saved.relPath} (${fmt.toUpperCase()}, ${saved.bytes} bytes): diagram ${slug}, version ${out.version}, source embedded.\n` +
              `The file records this slug and version; if get_diagram later reports a higher version, the file is outdated.`,
          );
        }),
    },
  };
}
