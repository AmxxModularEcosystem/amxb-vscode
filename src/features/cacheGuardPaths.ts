import * as path from 'node:path';

/**
 * Pure helpers for the amxb cache-edit guard feature.
 *
 * This module deliberately imports no `vscode` so it stays unit-testable in
 * plain Node (tests run outside the extension host).
 */

/** Drop empty entries and dedupe by resolved path, preserving order. */
export function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const key = path.resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/**
 * True when `filePath` is strictly inside any of the given root directories.
 * Same prefix semantics as `isUnderRoot` (src/util/includeResolve.ts): the root
 * itself is not considered "under" itself — irrelevant here, we only test files.
 */
export function isUnderAnyRoot(filePath: string, roots: readonly string[]): boolean {
  if (!filePath) return false;
  for (const root of roots) {
    if (!root) continue;
    const rel = path.relative(root, filePath);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}
