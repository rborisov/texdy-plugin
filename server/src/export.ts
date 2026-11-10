import fs from "node:fs/promises";
import path from "node:path";
import { PortalError } from "./portal.ts";

// Where export_diagram may write: the project folder Claude Code was started in,
// never the filesystem root. CLAUDE_PROJECT_DIR wins when it is set.
export function exportRoot(env: Record<string, string | undefined>, cwd: string): string {
  const root = env.CLAUDE_PROJECT_DIR || cwd;
  if (!path.isAbsolute(root)) {
    throw new PortalError("Cannot export: the project folder is not an absolute path", 0);
  }
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new PortalError("Cannot export: refusing to write into the filesystem root", 0);
  }
  return resolved;
}

export interface ExportPlan {
  /** relative path with forward slashes, as shown to the user */
  relPath: string;
  absPath: string;
}

const bad = (why: string) => new PortalError(`Cannot export to that path: ${why}`, 0);

// planExport checks a requested path BEFORE anything is fetched or written: it must be
// relative, stay inside root, and end in the extension of the format.
export function planExport(
  root: string,
  requested: string | undefined,
  slug: string,
  format: "svg" | "png",
): ExportPlan {
  const rel = requested ?? `diagrams/${slug}.${format}`;
  if (!rel) throw bad("the path is empty");
  if (rel.includes("\0")) throw bad("the path contains a NUL byte");
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("\\")) {
    throw bad("the path must be relative to the project folder");
  }
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) throw bad("the path must stay inside the project folder");
  if (parts[parts.length - 1] === "") throw bad("the path names a folder, not a file");
  if (path.extname(rel).toLowerCase() !== `.${format}`) throw bad(`the file name must end in .${format}`);
  const absPath = path.resolve(root, ...parts);
  const inside = path.relative(root, absPath);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw bad("the path must stay inside the project folder");
  }
  return { relPath: parts.filter(Boolean).join("/"), absPath };
}

// writeExport writes bytes to the planned file. It walks the folders one by one and
// refuses a symlink anywhere on the way (a link could lead out of the project), never
// replaces a folder or a link, and swaps the file in with a rename so a half-written
// file is never left behind.
export async function writeExport(
  root: string,
  requested: string | undefined,
  slug: string,
  format: "svg" | "png",
  bytes: Buffer,
): Promise<ExportPlan & { bytes: number }> {
  const plan = planExport(root, requested, slug, format);

  let cur = root;
  const dirParts = path.relative(root, path.dirname(plan.absPath)).split(path.sep).filter(Boolean);
  for (const part of dirParts) {
    cur = path.join(cur, part);
    const st = await fs.lstat(cur).catch(() => null);
    if (!st) {
      await fs.mkdir(cur);
    } else if (st.isSymbolicLink()) {
      throw bad(`"${part}" is a symbolic link`);
    } else if (!st.isDirectory()) {
      throw bad(`"${part}" is not a folder`);
    }
  }

  const existing = await fs.lstat(plan.absPath).catch(() => null);
  if (existing && (existing.isSymbolicLink() || existing.isDirectory())) {
    throw bad("a folder or link is already there");
  }

  const tmp = path.join(path.dirname(plan.absPath), `.${path.basename(plan.absPath)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    await fs.rename(tmp, plan.absPath);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new PortalError(`Could not write the file: ${(e as NodeJS.ErrnoException).code ?? "error"}`, 0);
  }
  return { ...plan, bytes: bytes.length };
}
