import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DepGraphResult } from '../serve/protocol';

export interface ParsedInclude {
  readonly name: string;
  readonly isAngle: boolean;
}

const INCLUDE_RE = /^\s*#\s*include\s*([<"])([^>"]+)([>"])/gm;

export function parseIncludes(text: string): ParsedInclude[] {
  const out: ParsedInclude[] = [];
  INCLUDE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INCLUDE_RE.exec(text)) !== null) {
    const open = match[1];
    const name = match[2];
    const close = match[3];
    if (open === undefined || name === undefined || close === undefined) continue;
    if ((open === '<') !== (close === '>')) continue;
    out.push({ name, isAngle: open === '<' });
  }
  return out;
}

export function isUnderRoot(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Project-local include directories the compiler searches for `<name>`. */
export function projectIncludeDirs(projectRoot: string): string[] {
  return [path.join(projectRoot, 'amxmodx', 'scripting', 'include'), path.join(projectRoot, 'amxmodx', 'scripting')];
}

/** First existing file matching the include name across the ordered search dirs. */
export function resolveIncludeLocal(name: string, isAngle: boolean, searchDirs: readonly string[]): string | undefined {
  const withExt = /\.inc$/i.test(name) ? name : `${name}.inc`;
  for (const dir of searchDirs) {
    const candidate = path.join(dir, withExt);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Patch a dep-graph.get result so it matches what the real compiler does:
 * - quoted includes resolve relative to the root .sma (the server resolves them
 *   relative to the including file, producing false "missing" entries);
 * - angle includes also search the project's own scripting/include directories
 *   (the server only searches dep include dirs and the AMXX stdlib).
 * Returns a new result; the input is not mutated.
 */
export function repairDepGraph(result: DepGraphResult, smaFile: string, projectRoot: string): DepGraphResult {
  const searchDirs: string[] = [path.dirname(smaFile), ...projectIncludeDirs(projectRoot), ...result.include_dirs];

  const files = new Map<string, { readonly isSma: boolean; includes: string[] }>();
  for (const file of result.files) files.set(file.file, { isSma: file.isSma, includes: [...file.includes] });

  const missing: Array<{ readonly file: string; readonly name: string; readonly isAngle: boolean }> = [];
  const visited = new Set<string>([smaFile]);

  function resolveOne(fromFile: string, name: string, isAngle: boolean): string | undefined {
    const dirs = isAngle ? searchDirs : [...searchDirs, path.dirname(fromFile)];
    return resolveIncludeLocal(name, isAngle, dirs);
  }

  function addFile(file: string): void {
    if (visited.has(file) || files.has(file)) return;
    visited.add(file);
    const text = readText(file);
    if (text === undefined) return;
    const entry = { isSma: /\.sma$/i.test(file), includes: [] as string[] };
    files.set(file, entry);
    for (const inc of parseIncludes(text)) {
      const resolved = resolveOne(file, inc.name, inc.isAngle);
      if (resolved) {
        if (!entry.includes.includes(resolved)) entry.includes.push(resolved);
        if (!files.has(resolved)) addFile(resolved);
      } else {
        missing.push({ file, name: inc.name, isAngle: inc.isAngle });
      }
    }
  }

  const kept: Array<{ readonly file: string; readonly name: string; readonly isAngle: boolean }> = [];
  for (const m of result.missing) {
    const resolved = resolveOne(m.file, m.name, m.isAngle);
    if (resolved) {
      if (!files.has(m.file)) addFile(m.file);
      const entry = files.get(m.file);
      if (entry && !entry.includes.includes(resolved)) entry.includes.push(resolved);
      if (!files.has(resolved)) addFile(resolved);
    } else {
      kept.push(m);
    }
  }

  return {
    ...result,
    files: [...files.entries()].map(([file, entry]) => ({ file, isSma: entry.isSma, includes: entry.includes })),
    missing: [...kept, ...missing],
  };
}
