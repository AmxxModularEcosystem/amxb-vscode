/**
 * Semver-aware parsing and descending comparison of version-like refs (tags).
 *
 * Pure module: no `vscode` import, no I/O, no external deps — runs under
 * plain Node unit tests. Parsing is intentionally forgiving because GitHub
 * tags are arbitrary: anything that does not reduce to a numeric-dot core
 * (plus an optional dot-separated pre-release) is treated as an unknown ref
 * and sorts LAST, preserving its original relative order via the stable sort.
 */

export interface ParsedVersionRef {
  readonly core: readonly number[];
  readonly pre: ReadonlyArray<number | string>;
}

/**
 * Parse a version-like ref.
 *
 *  - Trim whitespace; empty → undefined.
 *  - Strip ONE leading `v`/`V` only when immediately followed by a digit.
 *  - Ignore build metadata: cut everything after the first `+`.
 *  - Pre-release: split at the FIRST `-`; the part after becomes dot-separated
 *    pre identifiers, the part before is the numeric core. If the pre part
 *    contains an empty identifier (`1.2.3-`, `1.2.3-a..b`) → undefined. If the
 *    core is empty after splitting (`-1.2.3`) → undefined.
 *  - Core: split on `.`; every segment must match `/^\d+$/` (converted with
 *    Number); any non-numeric segment (`1.2.x`, `1.2.3a`) → undefined.
 *  - Pre identifiers: numeric → number, else keep the string.
 *
 * `2024-01-01` parses as core `[2024]` pre `["01-01"]` — accepted as-is.
 */
export function parseVersionRef(ref: string): ParsedVersionRef | undefined {
  let s = ref.trim();
  if (s.length === 0) return undefined;

  s = s.replace(/^[vV](?=\d)/, '');

  const plus = s.indexOf('+');
  if (plus !== -1) s = s.slice(0, plus);

  let corePart = s;
  let prePart: string | undefined;
  const dash = s.indexOf('-');
  if (dash !== -1) {
    corePart = s.slice(0, dash);
    prePart = s.slice(dash + 1);
  }

  if (corePart.length === 0) return undefined;

  const core: number[] = [];
  for (const segment of corePart.split('.')) {
    if (!/^\d+$/.test(segment)) return undefined;
    core.push(Number(segment));
  }

  if (prePart === undefined) {
    return { core, pre: [] };
  }

  const pre: Array<number | string> = [];
  for (const identifier of prePart.split('.')) {
    if (identifier.length === 0) return undefined;
    pre.push(/^\d+$/.test(identifier) ? Number(identifier) : identifier);
  }
  return { core, pre };
}

/**
 * Descending comparison of two parsed refs.
 *
 * Core is compared segment-by-segment (missing segments count as 0, so
 * `1.2` == `1.2.0`). On a tie, no-pre-release ranks ABOVE pre-release. Then
 * pre identifiers compare in order: a missing identifier at position i ranks
 * LOWER (`alpha` < `alpha.1`); numeric identifiers rank BELOW alphanumeric
 * (semver rule); numeric vs numeric → numeric diff; string vs string →
 * lexicographic. The result is DESCENDING (newest first).
 */
function compareParsedDesc(a: ParsedVersionRef, b: ParsedVersionRef): number {
  const maxCore = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < maxCore; i++) {
    const ca = a.core[i] ?? 0;
    const cb = b.core[i] ?? 0;
    if (ca !== cb) return ca > cb ? -1 : 1;
  }

  const aHasPre = a.pre.length > 0;
  const bHasPre = b.pre.length > 0;
  if (aHasPre !== bHasPre) return aHasPre ? 1 : -1; // no-pre-release above pre-release
  if (!aHasPre && !bHasPre) return 0;

  const maxPre = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < maxPre; i++) {
    const pa = a.pre[i];
    const pb = b.pre[i];
    if (pa === undefined && pb === undefined) continue;
    if (pa === undefined) return 1; // missing identifier ranks lower → b first
    if (pb === undefined) return -1;
    if (typeof pa === 'number' && typeof pb === 'number') {
      if (pa !== pb) return pa > pb ? -1 : 1;
      continue;
    }
    if (typeof pa === 'number') return 1; // numeric ranks below alphanumeric
    if (typeof pb === 'number') return -1;
    if (pa !== pb) return pa < pb ? 1 : -1; // descending lexicographic
  }
  return 0;
}

/**
 * Descending ref order: a parsed version sorts BEFORE a non-version; two
 * parsed versions compare newest-first; two unknowns are stable (return 0).
 */
export function compareRefsDesc(a: string, b: string): number {
  const pa = parseVersionRef(a);
  const pb = parseVersionRef(b);
  if (pa !== undefined && pb !== undefined) return compareParsedDesc(pa, pb);
  if (pa !== undefined) return -1;
  if (pb !== undefined) return 1;
  return 0;
}

/**
 * Sort refs newest-first by version semantics. Returns a NEW array (the input
 * is never mutated) using `Array.prototype.sort` (stable in Node 18), so
 * unparseable/unknown refs keep their original relative order at the end.
 */
export function sortRefsDesc(refs: readonly string[]): string[] {
  return [...refs].sort(compareRefsDesc);
}
