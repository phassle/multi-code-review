// Runs tasks that share a key one at a time, and tasks with different keys
// side by side. The gateway keys analyzers by tool: the four semgrep (or five
// PMD, five Roslyn) containers do the same heavy work for different
// categories, so they take turns instead of holding that memory at once. Pure.

export type Turns = <T>(key: string | undefined, task: () => Promise<T>) => Promise<T>;

/** A fresh queue per review. An undefined key runs at once; a failed task does not stop the next. */
export function takeTurns(): Turns {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string | undefined, task: () => Promise<T>): Promise<T> => {
    if (key === undefined) return task();
    const next = (tails.get(key) ?? Promise.resolve()).then(task, task);
    tails.set(key, next.catch(() => undefined));
    return next;
  };
}
