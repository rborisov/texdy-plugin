// A small line diff, for showing Claude what the user changed in a diagram since Claude last read it. Lines of both texts
// are compared exactly (line endings aside); two lines of context are kept around each change.

type Op = { t: " " | "-" | "+"; s: string };

const CONTEXT = 2;
// the longest stretch of differing lines compared line by line (the table is n*m cells)
const MAX_CELLS = 4_000_000;

// an empty text has no lines (not one empty line)
const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n"));

const tooLong = (maxLines: number) => `(the change is longer than ${maxLines} lines; read the new source)`;

/** The change from `oldText` to `newText`, null when there is none, or a one-line note when it is longer than `maxLines`. */
export function lineDiff(oldText: string, newText: string, maxLines = 200): string | null {
  const a = lines(oldText);
  const b = lines(newText);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return null;

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length * y.length > MAX_CELLS) return tooLong(maxLines);

  // longest common subsequence of the differing middle
  const w = y.length + 1;
  const table = new Int32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const ops: Op[] = a.slice(0, head).map((s) => ({ t: " ", s }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ t: " ", s: x[i++] }), j++;
    else if (i < x.length && (j === y.length || table[(i + 1) * w + j] >= table[i * w + j + 1])) ops.push({ t: "-", s: x[i++] });
    else ops.push({ t: "+", s: y[j++] });
  }
  for (const s of a.slice(a.length - tail)) ops.push({ t: " ", s });

  if (ops.filter((o) => o.t !== " ").length > maxLines) return tooLong(maxLines);

  // keep the changes and two lines around them; a gap between kept stretches is marked
  const keep = ops.map(() => false);
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    for (let c = Math.max(0, k - CONTEXT); c <= Math.min(ops.length - 1, k + CONTEXT); c++) keep[c] = true;
  });
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.t} ${o.s}`);
    else if (k > 0 && keep[k - 1] && keep.slice(k).some(Boolean)) out.push("  ...");
  });
  return out.join("\n");
}
