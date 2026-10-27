// Which lines a change touched, from `git diff -U0`. Pure.

/** Inclusive line ranges in the new version of each file. */
export type ChangedLines = Map<string, Array<[number, number]>>;

export function parseUnifiedDiff(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let file: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      file = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
      if (file !== undefined && !changed.has(file)) changed.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file !== undefined) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) changed.get(file)?.push([start, start + count - 1]);
    }
  }
  return changed;
}

/** A finding is new when any line of it falls inside a changed range. */
export function touchesChange(ranges: Array<[number, number]> | 'all' | undefined, start: number, end = start): boolean {
  if (ranges === 'all') return true;
  if (!ranges) return false;
  return ranges.some(([from, to]) => start <= to && end >= from);
}
