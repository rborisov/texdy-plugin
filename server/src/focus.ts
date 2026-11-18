import { lineDiff } from "./diff.ts";

// What the plugin remembers while the server runs: the diagram this conversation works on, and the last source it showed
// of each diagram it has read, so that "review my changes" can say what changed. Memory only: nothing is written to disk.

const MAX_REMEMBERED = 20;
const MAX_SOURCE_BYTES = 200 * 1024;

export interface Focused {
  slug: string;
  title: string;
  version: number;
}

export class Focus {
  private focused: Focused | null = null;
  // insertion order is age: the first key is the oldest
  private seen = new Map<string, { version: number; source: string }>();

  get(): Focused | null {
    return this.focused;
  }

  set(d: Focused): void {
    this.focused = { slug: d.slug, title: d.title, version: d.version };
  }

  clear(): void {
    this.focused = null;
  }

  /** Remember the source that was just shown (a source over 200 KB is not kept, and replaces an older one). */
  saw(slug: string, version: number, source: string): void {
    this.seen.delete(slug);
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return;
    this.seen.set(slug, { version, source });
    while (this.seen.size > MAX_REMEMBERED) this.seen.delete(this.seen.keys().next().value as string);
  }

  /** What changed since the last time this diagram was shown, when a higher version now has a different source. */
  changeSince(slug: string, version: number, source: string): { fromVersion: number; diff: string } | null {
    const before = this.seen.get(slug);
    if (!before || version <= before.version) return null;
    const diff = lineDiff(before.source, source);
    return diff === null ? null : { fromVersion: before.version, diff };
  }
}
