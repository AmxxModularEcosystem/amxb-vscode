/**
 * Pure cursor-context detection for `repos:` / `deps:` / `plugins:` manifest
 * entries.
 *
 * Given the raw manifest text and a character offset, `detectContext` reports
 * which field the cursor sits in so autocomplete providers and diagnostics can
 * decide what to suggest/highlight. The module is deliberately pure: no
 * vscode imports, no I/O — only `yaml`'s `parseDocument`, so it is unit-testable
 * in plain Node.
 *
 * Range semantics: `range` is `[start, valueEnd)` (both 0-based, exclusive
 * end). For scalar values the range covers the value's *content* (quotes are
 * stripped for quoted scalars); for sequence-valued fields (`exclude`,
 * `exclude_files`, list `asset`) the range covers the whole sequence value.
 *
 * Shorthand parsing (`- owner/repo[@ref[:path]]`): the repo is the part up to
 * the first `@` and must match `^[^/\s]+/[^/\s]+$`; the ref is the part between
 * `@` and `:` (empty when the user is typing `@` live — callers should combine
 * it with `isRefVerifiable`).
 *
 * Error tolerance (MANDATORY): whenever the document fails to parse
 * (`doc.errors.length > 0`) or the contents are not a top-level map, both
 * `detectContext` and `listRepoEntries` bail out (`undefined` / `[]`) — they
 * never throw.
 *
 * `kind` choices:
 * - A cursor inside a `repo:` *value* returns `undefined` (nothing can be
 *   suggested there). `kind: "repo"` stays in the type union for exhaustive
 *   pattern-matching, but `detectContext` never produces it.
 * - `kind: "none"` means the cursor is inside a `repos`/`deps` entry but not in
 *   a suggestion-bearing value (a key name, a comment inside the entry, a
 *   `source:`/`include_path:` value, …). Entry-level `repo`/`ref`/`source` are
 *   still populated for diagnostics.
 * - `kind: "plugin_match"` means the cursor is inside a `plugins[*].match`
 *   value. Plugin rules carry no repo, so `repo` is `''` for such contexts.
 */

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document, Scalar, YAMLMap, YAMLSeq } from 'yaml';

export interface RepoEntryContext {
  readonly block: 'repos' | 'deps' | 'plugins';
  readonly kind: 'repo' | 'ref' | 'asset' | 'amxmodx_dir' | 'exclude' | 'exclude_files' | 'shorthand' | 'none' | 'plugin_match';
  readonly repo: string; // the entry's "owner/repo"; '' for `plugins` contexts (plugin rules carry no repo)
  readonly ref?: string; // the entry's explicit ref value, if any (object form or shorthand after @)
  readonly source?: string; // the entry's "source:" value when present (git|release)
  readonly range: [number, number]; // [start, valueEnd) character offsets of the value the cursor is in
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
const HEX40_RE = /^[0-9a-fA-F]{40}$/;

const SUGGESTION_KINDS: Readonly<Record<string, 'ref' | 'asset' | 'amxmodx_dir' | 'exclude' | 'exclude_files'>> = {
  ref: 'ref',
  asset: 'asset',
  amxmodx_dir: 'amxmodx_dir',
  exclude: 'exclude',
  exclude_files: 'exclude_files',
};

/** Content range of a scalar value: `[start, valueEnd)`, quotes stripped. */
function scalarContentRange(node: Scalar): [number, number] {
  const r = node.range;
  if (!r) return [0, 0];
  const [start, valueEnd] = r;
  if (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE') {
    // Quoted scalars span `"content"`: range[0] is the opening quote and
    // range[1] sits just past the closing quote.
    return valueEnd - start >= 2 ? [start + 1, valueEnd - 1] : [start, valueEnd];
  }
  return [start, valueEnd];
}

/**
 * Whether `offset` falls on the scalar's value. End is inclusive so that a
 * cursor right after the last typed character (at the trailing newline or an
 * empty value position) still counts as "in the value".
 */
function scalarContains(node: Scalar, offset: number): boolean {
  const r = node.range;
  if (!r) return false;
  const [start, valueEnd] = r;
  return offset >= start && offset <= valueEnd;
}

/** Raw unquoted text of a parsed scalar (uses `source`, the true spelling). */
function scalarString(node: Scalar): string {
  if (typeof node.source === 'string') return node.source;
  return node.value == null ? '' : String(node.value);
}

function makeContext(
  block: 'repos' | 'deps' | 'plugins',
  kind: RepoEntryContext['kind'],
  repo: string,
  ref: string | undefined,
  source: string | undefined,
  range: [number, number],
): RepoEntryContext {
  return {
    block,
    kind,
    repo,
    range,
    ...(ref !== undefined ? { ref } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

function objectContext(item: YAMLMap, block: 'repos' | 'deps', offset: number): RepoEntryContext | undefined {
  const mapRange = item.range;
  if (!mapRange) return undefined;
  const [mapStart, mapEnd] = mapRange;
  if (offset < mapStart || offset > mapEnd) return undefined;

  let repoStr = '';
  let refStr: string | undefined;
  let sourceStr: string | undefined;

  for (const pair of item.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const keyName = pair.key.value;
    const value = pair.value;
    if (keyName === 'repo') {
      if (isScalar(value) && value.value !== null) repoStr = scalarString(value);
    } else if (keyName === 'ref') {
      if (isScalar(value)) refStr = scalarString(value);
    } else if (keyName === 'source') {
      if (isScalar(value) && value.value !== null) sourceStr = scalarString(value);
    }
  }

  for (const pair of item.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const keyName = pair.key.value;
    const value = pair.value;

    // A cursor in the `repo:` value has nothing to suggest → no context.
    if (keyName === 'repo') {
      if (isScalar(value) && scalarContains(value, offset)) return undefined;
      continue;
    }

    if (isScalar(value)) {
      if (!scalarContains(value, offset)) continue;
      return makeContext(block, SUGGESTION_KINDS[keyName] ?? 'none', repoStr, refStr, sourceStr, scalarContentRange(value));
    }
    if (isSeq(value)) {
      const r = value.range;
      if (!r || offset < r[0] || offset > r[1]) continue;
      return makeContext(block, SUGGESTION_KINDS[keyName] ?? 'none', repoStr, refStr, sourceStr, [r[0], r[1]]);
    }
  }

  // Inside the entry but not on a specific value (key names, comments, gaps).
  return makeContext(block, 'none', repoStr, refStr, sourceStr, [mapStart, mapEnd]);
}

/**
 * Context for a `plugins:` list entry. Only the `match:` value yields a
 * context (`kind: "plugin_match"`); every other position inside a plugin rule
 * (other keys such as `enabled:`, key names, gaps, comments) intentionally
 * returns `undefined`, so plugin entries never fall into the generic
 * `repos`/`deps` diagnostics.
 */
function pluginContext(item: YAMLMap, offset: number): RepoEntryContext | undefined {
  for (const pair of item.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value !== 'match') continue;
    const value = pair.value;
    if (!isScalar(value) || !scalarContains(value, offset)) continue;
    return makeContext('plugins', 'plugin_match', '', undefined, undefined, scalarContentRange(value));
  }
  return undefined;
}

function shorthandContext(node: Scalar, block: 'repos' | 'deps'): RepoEntryContext | undefined {
  const s = scalarString(node);
  const at = s.indexOf('@');
  const repoStr = at === -1 ? s : s.slice(0, at);
  if (!REPO_RE.test(repoStr)) return undefined;
  const range = scalarContentRange(node);
  let ref: string | undefined;
  if (at !== -1) {
    const after = s.slice(at + 1);
    const colon = after.indexOf(':');
    ref = colon === -1 ? after : after.slice(0, colon);
  }
  return {
    block,
    kind: 'shorthand',
    repo: repoStr,
    range,
    ...(ref !== undefined ? { ref } : {}),
  };
}

/** Map `offset` to the `repos`/`deps`/`plugins` field it sits in; `undefined` when none. */
export function detectContext(text: string, offset: number): RepoEntryContext | undefined {
  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  const contents = doc.contents;
  if (!isMap(contents)) return undefined;

  for (const pair of contents.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== 'string') continue;
    if (key.value === 'plugins') {
      const seq = pair.value;
      if (!isSeq(seq)) continue;
      for (const item of seq.items) {
        if (isMap(item)) {
          const ctx = pluginContext(item, offset);
          if (ctx) return ctx;
        }
      }
      continue;
    }
    if (key.value !== 'repos' && key.value !== 'deps') continue;
    const block = key.value;
    const seq = pair.value;
    if (!isSeq(seq)) continue;
    for (const item of seq.items) {
      if (isScalar(item)) {
        if (typeof item.value === 'string' && scalarContains(item, offset)) {
          const ctx = shorthandContext(item, block);
          if (ctx) return ctx;
        }
      } else if (isMap(item)) {
        const ctx = objectContext(item, block, offset);
        if (ctx) return ctx;
      }
    }
  }
  return undefined;
}

/**
 * Every repo value in the manifest (object-form `repo:` values and shorthand
 * `owner/repo` before `@`) with the character range of the repo value itself —
 * used for diagnostics.
 */
export function listRepoEntries(text: string): Array<{ repo: string; range: [number, number] }> {
  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) return [];
  const contents = doc.contents;
  if (!isMap(contents)) return [];

  const entries: Array<{ repo: string; range: [number, number] }> = [];
  for (const pair of contents.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== 'string') continue;
    if (key.value !== 'repos' && key.value !== 'deps') continue;
    const seq = pair.value;
    if (!isSeq(seq)) continue;
    for (const item of seq.items) {
      if (isScalar(item)) {
        if (typeof item.value !== 'string') continue;
        const at = item.value.indexOf('@');
        const repoStr = at === -1 ? item.value : item.value.slice(0, at);
        if (!REPO_RE.test(repoStr)) continue;
        const [start] = scalarContentRange(item);
        entries.push({ repo: repoStr, range: [start, start + repoStr.length] });
      } else if (isMap(item)) {
        const repoPair = item.items.find((p) => isScalar(p.key) && p.key.value === 'repo');
        if (!repoPair || !isScalar(repoPair.value) || repoPair.value.value === null) continue;
        entries.push({ repo: scalarString(repoPair.value), range: scalarContentRange(repoPair.value) });
      }
    }
  }
  return entries;
}

/** False for the special "latest", empty, and 40-hex (commit SHA) refs. */
export function isRefVerifiable(ref: string): boolean {
  if (ref === '' || ref === 'latest') return false;
  if (HEX40_RE.test(ref)) return false;
  return true;
}
