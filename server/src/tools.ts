import { z } from "zod";
import { PortalClient, PortalError, type DiagramRecord, type RenderError } from "./portal.ts";
import { exportRoot, planExport, readProjectFile, writeExport } from "./export.ts";
import { Focus } from "./focus.ts";
import { readImageIdentity } from "./image.ts";
import { parseRef } from "./ref.ts";

export const TOOL_NAMES = [
  "render_diagram",
  "create_diagram",
  "get_diagram",
  "update_diagram",
  "list_diagrams",
  "open_diagram",
  "export_diagram",
  "show_diagram",
  "focus_diagram",
  "current_diagram",
] as const;

// The largest picture show_diagram puts in the conversation; a bigger one is exported to a file instead.
const MAX_SHOW_BYTES = 4 * 1024 * 1024;

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
// where a tool may take the slug from the diagram in focus
const optionalSlug = z
  .string()
  .regex(/^[0-9a-f]{12}$/, "slug must be 12 lowercase hex characters (the id in the ?d=<slug> link)")
  .optional()
  .describe("Diagram slug: 12 lowercase hex characters (the id in the ?d=<slug> link). Optional: the diagram in focus when omitted.");

// "Errors:" text for a diagram that did not render: PlantUML's line, what is on it, what is probably wrong and, when
// the portal can tell, the line as it would read once mended.
const errorLines = (errors: RenderError[]) =>
  "Errors:\n" +
  errors
    .map((e) =>
      [
        `- ${e.line ? `line ${e.line}: ` : ""}${e.message}`,
        e.snippet ? `    text: ${e.snippet.trim()}` : "",
        e.hint ? `    hint: ${e.hint}` : "",
        e.suggestion ? `    fix:  ${e.suggestion.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

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

// The types a diagram can be given; the portal refuses any other (its list of types the editor has tools for).
export const CHOSEN_TYPES = [
  "sequence", "usecase", "class", "object", "activity", "component", "deployment", "state", "timing",
  "json", "yaml", "ebnf", "regex", "nwdiag", "salt", "archimate", "sdl", "ditaa", "gantt", "chronology",
  "mindmap", "wbs", "math", "ie", "er", "chart", "files",
] as const;

const chosenType = z
  .enum([...CHOSEN_TYPES, "auto"])
  .optional()
  .describe(
    "The type the editor's tools follow for this diagram (Constructor actions, style presets, @start keywords). Optional: omit to leave it as it is; 'auto' clears it so the type PlantUML recognizes is used. It does not rewrite the source: write the matching @start…/@end… keywords yourself, and PlantUML still reports what it recognizes in the text.",
  );

/** 'auto' is the portal's empty choice. */
const portalChosen = (t: string | undefined) => (t === undefined ? undefined : t === "auto" ? "" : t);

// The image link for show_diagram, as the text that goes after the picture. A link that could not be made is a note, never
// a failure: the picture was fetched all the same.
async function imageLinkText(client: PortalClient, slug: string): Promise<string> {
  try {
    const l = await client.createImageLink(slug);
    return (
      `Image link for the user (anyone who has this address sees this picture, with no sign-in, until ${l.expiresAt}; nothing is published): ${l.url}\n` +
      `To show it in the chat, put this in your reply: ![Diagram ${slug}](${l.url})`
    );
  } catch (e) {
    if (e instanceof PortalError && e.status === 404) {
      return "No image link: this portal has no image links yet (it needs to be updated). Give the user the file from export_diagram or the editor link instead.";
    }
    const why = e instanceof PortalError || e instanceof Error ? e.message : "unknown error";
    return `No image link could be made (${why}). Give the user the file from export_diagram or the editor link instead.`;
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
  // the diagram this conversation works on, and what was last shown of each diagram (memory of this server only)
  const focus = new Focus();

  // run `run` on the slug given or, without one, on the diagram in focus; a 404 for the focused diagram clears the focus
  async function onDiagram(given: string | undefined, run: (slug: string, note: string) => Promise<ToolResult>): Promise<ToolResult> {
    const f = focus.get();
    const slug = given ?? f?.slug;
    if (!slug) {
      return fail("No diagram in focus: pass a slug, or call focus_diagram first (with the diagram's address in the portal, a share link, or an exported image).");
    }
    const note = given && f && f.slug !== given ? `\n(not the focused diagram: "${f.title}" (${f.slug}) is in focus)` : "";
    try {
      return await run(slug, note);
    } catch (e) {
      if (e instanceof PortalError && (e.status === 404 || e.status === 403) && f && f.slug === slug) focus.clear();
      throw e;
    }
  }

  // remember what was shown of a diagram; say what changed since the last time (before it is replaced)
  function remember(d: { slug: string; title: string; version: number; source: string }) {
    const change = focus.changeSince(d.slug, d.version, d.source);
    focus.saw(d.slug, d.version, d.source);
    if (focus.get()?.slug === d.slug) focus.set(d);
    return change;
  }

  const describe = (d: DiagramRecord, change: { fromVersion: number; diff: string } | null) => {
    // the type is PlantUML's to decide: shown only when the portal has recorded one; the chosen one only when set
    const type = (d.diagramType ? `type: ${d.diagramType}\n` : "") + (d.chosenType ? `chosen type: ${d.chosenType}\n` : "");
    const changed = change ? `\nChanged since you last saw it (v${change.fromVersion} to v${d.version}):\n${change.diff}\n` : "";
    return `title: ${d.title}\n${type}version: ${d.version}\nurl: ${d.url}\n${changed}\nsource:\n${d.source}`;
  };

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
        chosen_type: chosenType,
        another: z
          .boolean()
          .optional()
          .describe("Only when the user asked for a separate, new diagram while another is in focus. Without it, create_diagram refuses while a diagram is in focus: update that one."),
      },
      handler: ({ title, source, chosen_type, another }) =>
        guard(async () => {
          const f = focus.get();
          if (f && !another) {
            return fail(
              `Diagram "${f.title}" (${f.slug}) is in focus: use update_diagram on it (read it with get_diagram first). ` +
                "If the user asked for a separate, new diagram, call create_diagram again with another: true.",
            );
          }
          const d = await client.create(title, source, portalChosen(chosen_type));
          focus.set(d);
          // what the portal stored (it may have added the user's look) is what Claude knows of the diagram now
          focus.saw(d.slug, d.version, d.source || source);
          const chosen = d.chosenType ? `, chosen type: ${d.chosenType}` : "";
          const look = d.lookApplied
            ? `\nApplied your default style: ${d.lookApplied[0].toUpperCase()}${d.lookApplied.slice(1)}.` +
              (d.lookLevel === "base"
                ? " Only the basics for now: the rest of the style is added in the editor once PlantUML recognizes what kind of diagram it is."
                : "")
            : "";
          return ok(
            `Created diagram "${d.title}" (slug ${d.slug}, version ${d.version}${chosen}). It is now the diagram in focus.${look}\nOpen in the editor: ${d.url}`,
          );
        }),
    },

    get_diagram: {
      description:
        "Read a diagram's current source, title, type and version (the diagram in focus when no slug is given). 'type' is what PlantUML recognized in the source; 'chosen type' (shown only when one is set) is what was chosen for the diagram. When the diagram changed since you last read it, the result says what changed (a diff): that is how to review the user's edits. Use its version as base_version when updating.",
      inputSchema: { slug: optionalSlug },
      handler: ({ slug: given }) =>
        guard(() =>
          onDiagram(given, async (slug, note) => {
            const d = await client.get(slug);
            const change = remember(d);
            return ok(describe(d, change) + note);
          }),
        ),
    },

    update_diagram: {
      description:
        "Update a diagram's source (and optionally its title or chosen type); the diagram in focus when no slug is given. base_version is required: pass the version you last read. If the diagram changed elsewhere, you get the current version and source back to merge.",
      inputSchema: {
        slug: optionalSlug,
        source: z.string().min(1).describe("Full new PlantUML source"),
        base_version: z.number().int().min(1).describe("The version you based this edit on (a positive integer)"),
        title: z.string().min(1).optional(),
        chosen_type: chosenType,
      },
      handler: ({ slug: given, source, base_version, title, chosen_type }) =>
        guard(() =>
          onDiagram(given, async (slug, note) => {
          try {
            const d = await client.update(slug, {
              source,
              baseVersion: base_version,
              title,
              chosenType: portalChosen(chosen_type),
            });
            // what was just saved is what Claude now knows of the diagram: not a change to be reported back later
            focus.saw(d.slug, d.version, source);
            if (focus.get()?.slug === d.slug) focus.set(d);
            return ok(`Updated diagram ${d.slug} to version ${d.version}.\nOpen in the editor: ${d.url}${note}`);
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
        ),
    },

    list_diagrams: {
      description: "List your diagrams (slug, title, type, chosen type when set as chosen:<type>, version, editor link). Source is not included; use get_diagram.",
      inputSchema: {},
      handler: () =>
        guard(async () => {
          const l = await client.list();
          if (!l.length) return ok("No diagrams yet.");
          return ok(
            l
              .map(
                (d) =>
                  `${d.slug}  "${d.title}"  ${d.diagramType ? d.diagramType + "  " : ""}${d.chosenType ? "chosen:" + d.chosenType + "  " : ""}v${d.version}  ${d.url}`,
              )
              .join("\n"),
          );
        }),
    },

    open_diagram: {
      description:
        "Get a link that opens the diagram in the portal editor already signed in. The link works once and only for about a minute, so give it to the user right away and do not store or share it. For a link to share or print, use the plain link from create_diagram or get_diagram instead.",
      inputSchema: { slug: optionalSlug },
      handler: ({ slug: given }) =>
        guard(() =>
          onDiagram(given, async (slug, note) => {
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
              `Open in the editor (signed in): ${client.openUrlFor(slug, code)}\nThis link works once and for about a minute; open it right away.${note}`,
            );
          }),
        ),
    },
    show_diagram: {
      description:
        "Show a saved diagram's current picture in the conversation (the diagram in focus when no slug is given). Returns the picture (PNG) to you, and an image link for the user: the chat asks the user to click 'Show image' before it loads a picture from an address, and does not show a tool's own image to them, so put the returned markdown in your reply. The link is not a publication: anyone who has the address sees the picture, with no sign-in, for about 15 minutes, and then it stops working. Reads the stored diagram, so it includes any edits the user made in the editor, and says which version it shows. Nothing is written to disk: use export_diagram for a file.",
      inputSchema: { slug: optionalSlug },
      handler: ({ slug: given }) =>
        guard(() =>
          onDiagram(given, async (slug, note) => {
            const out = await client.exportImage(slug, "png", false);
            if (!out.success || !out.bytes) {
              return fail(
                (out.errors.length ? errorLines(out.errors) : "The diagram does not render.") +
                  `\n(diagram ${slug}, version ${out.version}; nothing to show)${note}`,
              );
            }
            const link = await imageLinkText(client, slug);
            if (out.bytes.length > MAX_SHOW_BYTES) {
              return ok(
                `The picture of diagram ${slug} (version ${out.version}) is too large to show here (${out.bytes.length} bytes). Use export_diagram to save it as a file.\n${link}${note}`,
              );
            }
            return {
              content: [
                { type: "image", data: out.bytes.toString("base64"), mimeType: "image/png" },
                { type: "text", text: `Diagram ${slug}, version ${out.version}.\n${link}${note}` },
              ],
            };
          }),
        ),
    },

    export_diagram: {
      description:
        "Save the diagram as an SVG (default) or PNG file in the project folder, by default diagrams/<slug>.svg. The file records the diagram's slug, its version and its PlantUML source, so it can later be compared with get_diagram's version to see whether it is outdated. Returns the path and version, not the picture. Call it after create_diagram or update_diagram, and again when the user asks you to review their changes in the portal.",
      inputSchema: {
        slug: optionalSlug,
        format: z.enum(["svg", "png"]).default("svg").describe("svg (default) or png"),
        path: z
          .string()
          .optional()
          .describe("File path relative to the project folder; must end in .svg or .png to match the format. Default: diagrams/<slug>.<format>"),
      },
      handler: ({ slug: given, format, path: requested }) =>
        guard(() =>
          onDiagram(given, async (slug, note) => {
            const fmt: "svg" | "png" = format === "png" ? "png" : "svg";
            const root = opts.exportRoot ?? exportRoot(process.env, process.cwd());
            planExport(root, requested, slug, fmt); // refuse a bad path before asking the portal for anything
            const out = await client.exportImage(slug, fmt);
            if (!out.success || !out.bytes) {
              return fail(
                (out.errors.length ? errorLines(out.errors) : "The diagram does not render.") +
                  `\n(diagram ${slug}, version ${out.version}; nothing was saved)${note}`,
              );
            }
            const saved = await writeExport(root, requested, slug, fmt, out.bytes);
            return ok(
              `Saved ${saved.relPath} (${fmt.toUpperCase()}, ${saved.bytes} bytes): diagram ${slug}, version ${out.version}, source embedded.\n` +
                `The file records this slug and version; if get_diagram later reports a higher version, the file is outdated.${note}`,
            );
          }),
        ),
    },

    focus_diagram: {
      description:
        "Make a diagram the one this conversation works on, and read it. `ref` is what the user gave you: a slug, the diagram's address in the portal (…/?d=<slug>), a share link (…/#share=…), or the path of an image the portal exported (an SVG or PNG saved with its source, inside the project folder). A share link gives the user their own COPY of the diagram (changes do not reach the original); the user's own address or slug is the diagram itself. After this the other tools need no slug, and create_diagram refuses to make another diagram until the user asks for one. A picture pasted into the chat carries no id: ask for the file, the address or the slug instead.",
      inputSchema: {
        ref: z.string().min(1).describe("A slug, the portal address of the diagram, a share link, or the path of an exported SVG/PNG in the project folder"),
      },
      handler: ({ ref }) =>
        guard(async () => {
          const parsed = parseRef(ref, client.baseUrlForRefs());
          if (parsed.kind === "invalid") return fail(`Cannot use that: ${parsed.why}.`);

          let slug: string;
          let shared: { own: boolean } | null = null;
          let fileVersion: number | undefined;
          const gone =
            parsed.kind === "file"
              ? (s: string) => `The diagram in that file (slug ${s}) is not in your portal: it was deleted, or it belongs to someone else. If it is someone else's, ask them for a share link.`
              : (s: string) => `No diagram with slug ${s} in your portal: it was deleted, or it belongs to someone else. If it is someone else's, ask them for a share link.`;

          if (parsed.kind === "slug" || parsed.kind === "editor") {
            slug = parsed.slug;
          } else if (parsed.kind === "share") {
            try {
              const s = await client.openShare(parsed.token);
              slug = s.slug;
              shared = { own: s.own };
            } catch (e) {
              if (e instanceof PortalError && e.status === 404) return fail("This share link has expired or does not exist.");
              throw e;
            }
          } else {
            const root = opts.exportRoot ?? exportRoot(process.env, process.cwd());
            const id = readImageIdentity(await readProjectFile(root, parsed.path));
            if (!id) {
              return fail(
                "That file carries no diagram id (it is not an image the portal exported with its source embedded). Ask the user for the diagram's address in the portal, a share link or the slug.",
              );
            }
            slug = id.slug;
            fileVersion = id.version;
          }

          let d: DiagramRecord;
          try {
            d = await client.get(slug);
          } catch (e) {
            // the portal says 404 for a diagram that is not there and 403 for one that is someone else's
            if (e instanceof PortalError && (e.status === 404 || e.status === 403)) return fail(gone(slug));
            throw e;
          }
          const notes: string[] = [];
          if (shared) {
            notes.push(
              shared.own
                ? "This share link is to your own diagram, so that diagram itself is now in focus."
                : "The share link gave you your own copy of the shared diagram. It is a copy: your changes do not reach the original.",
            );
          }
          if (fileVersion !== undefined && fileVersion !== d.version) {
            notes.push(`The file is version ${fileVersion}; the diagram is now at version ${d.version}.`);
          }
          const change = focus.changeSince(d.slug, d.version, d.source);
          focus.saw(d.slug, d.version, d.source);
          focus.set(d);
          return ok(`Now working on diagram "${d.title}" (slug ${d.slug}, version ${d.version}).\n${notes.map((n) => n + "\n").join("")}\n${describe(d, change)}`);
        }),
    },

    current_diagram: {
      description:
        "Say which diagram this conversation is working on (the one in focus), or that there is none. Call it before doing anything with a diagram: it is how you find the diagram again after a long conversation, so that you update it instead of creating another.",
      inputSchema: {},
      handler: () =>
        guard(async () => {
          const f = focus.get();
          return ok(
            f
              ? `In focus: "${f.title}" (slug ${f.slug}, version ${f.version} when last read).`
              : "No diagram is in focus. Pass a slug to a tool, or call focus_diagram with the diagram's address in the portal, a share link, or an exported image file.",
          );
        }),
    },
  };
}
