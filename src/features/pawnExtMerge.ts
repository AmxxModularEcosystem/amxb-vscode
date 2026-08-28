import * as path from 'node:path';

/**
 * Pure helpers for the amxx-pawn-all-in include sync feature.
 *
 * This module deliberately imports no `vscode` so it stays unit-testable in
 * plain Node (tests run outside the extension host).
 */

/**
 * Comparison key for a path: `path.resolve` only (strips trailing separators
 * and resolves `.`/`..` segments), so spellings of the same directory compare
 * equal. Output values are always the original strings, untouched. This
 * matches how the target extension dedupes its include sources
 * (`path.resolve(...).replace(/\\/g, '/').toLowerCase()`).
 */
function normKey(p: string): string {
  return path.resolve(p);
}

/** Remove duplicate paths keeping the first occurrence (comparison is normalized). */
export function dedupePreservingOrder(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const key = normKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Merge the newly resolved include dirs (`ours`) into the current value of the
 * target setting, removing dirs written by a previous sync (`prevWritten`).
 *
 * - `ours` go FIRST — the target extension (amxx-pawn-all-in) resolves includes
 *   by walking its search paths in array order and takes the first match, so
 *   versioned dependency dirs must precede manually configured global paths.
 * - dirs the user configured themselves (not previously written by us) stay
 *   after `ours`, in their original order.
 * - a dir already present in the user list is not duplicated at the front (it
 *   keeps its user position — it is the same directory either way).
 * - `prevWritten` entries are stripped from `current` — this is what removes
 *   dirs of old dependency versions and of removed dependencies.
 */
export function mergeIncludeDirs(
  ours: readonly string[],
  current: readonly string[],
  prevWritten: readonly string[],
): string[] {
  const prevSet = new Set(prevWritten.map(normKey));
  const userDirs = current.filter((p) => !prevSet.has(normKey(p)));
  const userSet = new Set(userDirs.map(normKey));

  const merged: string[] = [];
  for (const dir of dedupePreservingOrder(ours)) {
    if (!userSet.has(normKey(dir))) merged.push(dir);
  }
  merged.push(...userDirs);
  return merged;
}
