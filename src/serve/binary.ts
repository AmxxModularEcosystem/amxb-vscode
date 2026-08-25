import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve the `amxb` binary used to spawn `amxb serve`.
 *
 * Resolution order:
 *   1. `amxb.servePath` setting — absolute path, bare name on PATH, or a
 *      `serve.js` path (run via `node`).
 *   2. `amxb` on PATH (on Windows also `amxb.cmd`, which needs a shell).
 */

export interface BinaryInfo {
  readonly command: string;
  readonly args: readonly string[];
  /** Spawn with shell:true (required for .cmd shims on Windows). */
  readonly needsShell: boolean;
  readonly source: 'setting' | 'path';
}

export interface BinaryLookup {
  readonly info?: BinaryInfo;
  /** Human-readable reason when resolution failed. */
  readonly reason?: string;
}

const isWindows = process.platform === 'win32';

function isJsFile(p: string): boolean {
  return /\.(?:c?js|mjs)$/.test(p);
}

async function accessExecutable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    // On Windows, X_OK semantics differ; fall back to existence.
    try {
      await fs.promises.access(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.trim(), name);
    if (await accessExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveServeBinary(configured: string | undefined): Promise<BinaryLookup> {
  const settingPath = configured?.trim();

  const serveArgs = (command: string): readonly string[] =>
    isJsFile(command) ? [command] : ['serve'];

  if (settingPath) {
    if (isJsFile(settingPath)) {
      return { info: { command: 'node', args: serveArgs(settingPath), needsShell: false, source: 'setting' } };
    }
    if (path.isAbsolute(settingPath)) {
      if (await accessExecutable(settingPath)) {
        return {
          info: { command: settingPath, args: serveArgs(settingPath), needsShell: isWindows && /\.(?:cmd|bat)$/i.test(settingPath), source: 'setting' },
        };
      }
      return { reason: `amxb.servePath is set but the file was not found: ${settingPath}` };
    }
    const onPath = await findOnPath(settingPath);
    if (onPath) {
      return { info: { command: onPath, args: serveArgs(onPath), needsShell: isWindows && /\.(?:cmd|bat)$/i.test(onPath), source: 'setting' } };
    }
    return { reason: `amxb.servePath "${settingPath}" was not found on PATH` };
  }

  const names = isWindows ? ['amxb.cmd', 'amxb'] : ['amxb'];
  for (const name of names) {
    const found = await findOnPath(name);
    if (found) {
      return { info: { command: found, args: serveArgs(found), needsShell: isWindows && /\.(?:cmd|bat)$/i.test(found), source: 'path' } };
    }
  }

  return {
    reason: 'amxb binary was not found on PATH. Install amxx-builder globally (npm install -g amxx-builder) or set the amxb.servePath setting.',
  };
}

/** Memoized resolver: caches the first successful lookup, retries on failure. */
export function createBinaryResolver(getConfigured: () => string | undefined): () => Promise<BinaryInfo> {
  let cached: BinaryInfo | undefined;

  return async () => {
    if (cached) return cached;
    const lookup = await resolveServeBinary(getConfigured());
    if (lookup.info) {
      cached = lookup.info;
      return lookup.info;
    }
    throw new Error(lookup.reason ?? 'amxb binary was not found');
  };
}
