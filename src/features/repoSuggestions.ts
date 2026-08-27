/**
 * Completion suggestions for `repos:` / `deps:` manifest fields.
 *
 * The provider registers on the three manifest patterns and, based on the pure
 * cursor context from `repoSuggestContext`, offers:
 *
 *   - `ref:` value / `owner/repo@…` shorthand → `latest` + the repo's tags and branches
 *   - `asset:` (only under `source: release`) → release asset names
 *   - `amxmodx_dir:`                         → existing directories in the repo
 *   - `exclude:` / `exclude_files:`          → existing `.sma` files in the repo
 *   - `plugins[*].match`                     → the project's own `.sma` paths
 *                                              relative to `amxmodx/scripting/`
 *
 * All repo data comes from `amxb serve` (`releases.list`, `repos.branches`,
 * `repos.structure`) through the shared TTL cache (`repoSuggestCache`), so the
 * anonymous GitHub rate limit is respected. There is NO client-side GitHub
 * access in this module. The `plugins[*].match` suggestions are the sole
 * exception to "no local project data": they are client-side presentation glue
 * (a local `findFiles` glob, like `projectsTree.findPlugins`) with no serve
 * RPC involved.
 *
 * The diagnostics half adds existence warnings (`repos.info` results in
 * "не существует или нет доступа") and cache-only ref-not-found warnings,
 * reusing the same cache + fetch helpers via `register()` below.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FeatureDeps, Project } from '../core/types';
import type { ServeClient } from '../serve/client';
import { reposBranches, reposInfo, reposStructure, releasesList } from '../serve/methods';
import type { ReposStructureEntry } from '../serve/protocol';
import { detectContext, isRefVerifiable, listRepoEntries } from './repoSuggestContext';
import type { RepoEntryContext } from './repoSuggestContext';
import { createRepoCache, DYNAMIC_TTL_MS, INFO_TTL_MS } from './repoSuggestCache';
import type { RepoCache } from './repoSuggestCache';
import { classifyRepoError, existsFalseMessage } from './repoSuggestErrors';
import { sortRefsDesc } from './refSort';
import { isManifestFile } from '../manifest/detector';

/** Per-RPC timeout for repo data (same shape as includeHover's local helper). */
const RPC_TIMEOUT_MS = 10_000;
const TIMEOUT_MESSAGE = 'repo suggestion request timed out';

/** Debounce for text-change-triggered diagnostics (own timer, not the store/save debounce). */
const DIAGNOSTICS_DEBOUNCE_MS = 400;

/**
 * Module-level cache, created lazily from the extension context's
 * `workspaceState`. Kept at module scope so the diagnostics half (todo 10)
 * reuses the exact same instance and keys.
 */
let repoCache: RepoCache | undefined;

function getCache(ctx: vscode.ExtensionContext): RepoCache {
  if (repoCache === undefined) {
    const state = ctx.workspaceState;
    repoCache = createRepoCache({
      get: (key: string): string | undefined => state.get<string>(key),
      update: (key: string, value: string | undefined): void => {
        void state.update(key, value);
      },
    });
  }
  return repoCache;
}

/** Remember distinct messages so a repeated failure logs once, not on every keystroke. */
const loggedErrors = new Set<string>();

function logOnce(log: (message: string) => void, message: string): void {
  if (loggedErrors.has(message)) return;
  loggedErrors.add(message);
  log(message);
}

/**
 * Set by the diagnostics half of `register()`; invoked by the fetch helpers
 * after a successful `tags:`/`branches:` cache fill so the ref-not-found
 * diagnostics for the active manifest are recomputed (MINOR-10). Single slot
 * is enough: it re-runs the whole diagnostics for the last manifest handled.
 */
let onCacheFill: (() => void) | undefined;

/** fsPath of the manifest the diagnostics last ran for (the `onCacheFill` target). */
let lastDiagnosticsManifest: string | undefined;

let clientWarned = false;

/** Resolve the serve client for a project; `undefined` (and a single log) on failure. */
async function getClient(deps: FeatureDeps, project: Project): Promise<ServeClient | undefined> {
  try {
    return await deps.clientFor(project);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!clientWarned) {
      clientWarned = true;
      deps.output.log(`amxb serve unavailable: ${message}`);
    }
    return undefined;
  }
}

/** Copy of the includeHover.ts timeout pattern (local on purpose). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Everything a single repo-data fetch needs: cache, cancellation and logging. */
interface FetchContext {
  readonly cache: RepoCache;
  readonly token: vscode.CancellationToken;
  readonly log: (message: string) => void;
}

/**
 * Shared cache + in-flight dedupe + error-handling pattern for every repo RPC.
 *
 * `loader` returns `undefined` for the `{ exists: false }` success shape (repo
 * not found / no access) — such results are never cached. Thrown RpcErrors are
 * classified via `classifyRepoError`: `rate_limited`/`other` are logged once,
 * `not_found`/`ref_not_found` are silent (diagnostics report them). Returns
 * `undefined` on any failure or cancellation.
 */
async function fetchCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T | undefined>,
  repo: string,
  fc: FetchContext,
): Promise<T | undefined> {
  if (fc.token.isCancellationRequested) return undefined;

  const cached = fc.cache.get<T>(key);
  if (cached !== undefined) return cached;

  const inflight = fc.cache.pending(key);
  if (inflight !== undefined) {
    try {
      const value = (await inflight) as T | undefined;
      if (fc.token.isCancellationRequested) return undefined;
      return value;
    } catch {
      // A peer's attempt failed; fall through and retry with our own request.
    }
  }

  if (fc.token.isCancellationRequested) return undefined;

  const promise = withTimeout(loader(), RPC_TIMEOUT_MS);
  fc.cache.track(key, promise);
  let value: T | undefined;
  try {
    value = await promise;
  } catch (err) {
    if (fc.token.isCancellationRequested) return undefined;
    const info = classifyRepoError(err, repo);
    if (info.kind === 'rate_limited' || info.kind === 'other') {
      logOnce(fc.log, `${repo}: ${info.message}`);
    }
    return undefined;
  }

  if (fc.token.isCancellationRequested) return undefined;
  if (value === undefined) return undefined; // exists:false → nothing to cache
  fc.cache.set(key, value, ttlMs);
  if (key.startsWith('tags:') || key.startsWith('branches:')) {
    // MINOR-10: a fresh tags/branches fill may add or clear ref-not-found warnings.
    onCacheFill?.();
  }
  return value;
}

/** Tag names of a repo via `releases.list` (tags mode → entries are `{ name, commitSha }`). */
async function fetchTags(
  client: ServeClient,
  repo: string,
  manifest: string,
  token: string | undefined,
  fc: FetchContext,
): Promise<readonly string[] | undefined> {
  return fetchCached(
    `tags:${repo}`,
    DYNAMIC_TTL_MS,
    async () => {
      const releases = await releasesList(client, {
        repo,
        tags: true,
        limit: 100,
        manifest,
        ...(token !== undefined ? { token } : {}),
      });
      const names: string[] = [];
      for (const entry of releases) {
        const name = entry.name;
        if (name !== undefined && name.length > 0) names.push(name);
      }
      return names;
    },
    repo,
    fc,
  );
}

/** Branch names of a repo via `repos.branches`. */
async function fetchBranches(
  client: ServeClient,
  repo: string,
  manifest: string,
  token: string | undefined,
  fc: FetchContext,
): Promise<readonly string[] | undefined> {
  return fetchCached(
    `branches:${repo}`,
    DYNAMIC_TTL_MS,
    async () => {
      const result = await reposBranches(client, {
        repo,
        limit: 100,
        manifest,
        ...(token !== undefined ? { token } : {}),
      });
      if (!('branches' in result)) return undefined; // exists:false
      return result.branches.map((entry) => entry.name);
    },
    repo,
    fc,
  );
}

/** Release asset names via `releases.list` with `includeAssets: true`. */
async function fetchReleaseAssets(
  client: ServeClient,
  repo: string,
  manifest: string,
  token: string | undefined,
  fc: FetchContext,
): Promise<readonly string[] | undefined> {
  return fetchCached(
    `releases:${repo}`,
    DYNAMIC_TTL_MS,
    async () => {
      const releases = await releasesList(client, {
        repo,
        includeAssets: true,
        limit: 10,
        manifest,
        ...(token !== undefined ? { token } : {}),
      });
      const assets: string[] = [];
      for (const release of releases) {
        const list = release.assets;
        if (list === undefined) continue; // optional and often absent (MAJOR-7)
        for (const asset of list) {
          const name = asset.name;
          if (name !== undefined && name.length > 0) assets.push(name);
        }
      }
      return assets;
    },
    repo,
    fc,
  );
}

/**
 * Repo file-tree entries via `repos.structure`. Cache key follows the shared
 * scheme `structure:<repo>:<ref>:<dirsOnly>:<ext-joined>`.
 */
async function fetchStructure(
  client: ServeClient,
  repo: string,
  options: { readonly ref?: string; readonly dirsOnly?: boolean; readonly depth?: number; readonly ext?: ReadonlyArray<string> },
  manifest: string,
  token: string | undefined,
  fc: FetchContext,
): Promise<readonly ReposStructureEntry[] | undefined> {
  const extJoined = options.ext !== undefined ? options.ext.join(',') : '';
  const key = `structure:${repo}:${options.ref ?? ''}:${String(options.dirsOnly ?? false)}:${extJoined}`;
  return fetchCached(
    key,
    DYNAMIC_TTL_MS,
    async () => {
      const result = await reposStructure(client, {
        repo,
        manifest,
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.dirsOnly !== undefined ? { dirsOnly: options.dirsOnly } : {}),
        ...(options.depth !== undefined ? { depth: options.depth } : {}),
        ...(options.ext !== undefined ? { ext: options.ext } : {}),
        ...(token !== undefined ? { token } : {}),
      });
      if (!('entries' in result)) return undefined; // exists:false
      return result.entries;
    },
    repo,
    fc,
  );
}

// ─── pure item builders (exported for unit-testing) ──────────────────────────

/**
 * `latest` (sortText "0") + tags ("1…") + branches ("2…") for a `ref` position.
 *
 * Tags are version-sorted newest-first via `sortRefsDesc` (semver-aware, with
 * unparseable/unknown refs LAST). Each item's sortText embeds a zero-padded
 * index (`'1' + '000'`, `'1' + '001'`, …), so VS Code's lexical sortText
 * ordering matches that version order exactly instead of falling back to a
 * label sort. Branches keep their server order under a separate "2" prefix.
 */
export function buildRefItems(tags: readonly string[], branches: readonly string[]): vscode.CompletionItem[] {
  const items: vscode.CompletionItem[] = [];
  const latest = new vscode.CompletionItem('latest', vscode.CompletionItemKind.Value);
  latest.detail = 'последний GitHub release';
  latest.sortText = '0';
  items.push(latest);
  const sortedTags = sortRefsDesc(tags);
  let i = 0;
  for (const tag of sortedTags) {
    const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Reference);
    item.sortText = `1${String(i).padStart(3, '0')}`;
    items.push(item);
    i++;
  }
  let j = 0;
  for (const branch of branches) {
    const item = new vscode.CompletionItem(branch, vscode.CompletionItemKind.Reference);
    item.sortText = `2${String(j).padStart(3, '0')}`;
    items.push(item);
    j++;
  }
  return items;
}

/** Release asset names for an `asset:` position. */
export function buildAssetItems(assets: readonly string[]): vscode.CompletionItem[] {
  return assets.map((asset) => new vscode.CompletionItem(asset, vscode.CompletionItemKind.File));
}

/** Existing repo directories for an `amxmodx_dir:` position. */
export function buildDirItems(dirs: readonly string[]): vscode.CompletionItem[] {
  return dirs.map((dir) => new vscode.CompletionItem(dir, vscode.CompletionItemKind.Folder));
}

/** Existing `.sma` paths for an `exclude:` / `exclude_files:` position. */
export function buildFileItems(files: readonly string[]): vscode.CompletionItem[] {
  return files.map((file) => new vscode.CompletionItem(file, vscode.CompletionItemKind.File));
}

// ─── range helpers ────────────────────────────────────────────────────────────

/**
 * Character range the picked item should replace.
 *
 * For every kind but `shorthand` this is exactly `context.range` — the value
 * the cursor sits in. For shorthand (`- owner/repo[@ref[:path]]`) the context
 * range covers the whole scalar; replacing it with a bare ref would wipe the
 * `owner/repo@` prefix, so the range is narrowed to just the ref portion after
 * the `@` (zero-width when the user is still typing `@` live).
 */
function valueRange(context: RepoEntryContext): [number, number] {
  if (context.kind === 'shorthand' && context.ref !== undefined) {
    const start = context.range[0] + context.repo.length + 1;
    return [start, start + context.ref.length];
  }
  return context.range;
}

// ─── diagnostics (existence + ref-not-found warnings) ────────────────────────

/** A repo reference in the manifest whose existence can be checked against cached tags/branches. */
interface RepoRef {
  readonly repo: string;
  readonly ref: string;
  readonly refRange: [number, number];
}

/**
 * Every explicit ref in `repos:`/`deps:` entries: object-form `ref:` values
 * (located via a `ref:`-key line scan, then confirmed through `detectContext`,
 * which yields the exact content range) and shorthand `owner/repo@ref` (the
 * portion after `@`). Pure — no cache access, no I/O.
 */
function listRepoRefs(text: string): RepoRef[] {
  const refs: RepoRef[] = [];

  const refLine = /^[ \t]*ref[ \t]*:[ \t]*/gm;
  let match: RegExpExecArray | null;
  while ((match = refLine.exec(text)) !== null) {
    const whole = match[0];
    if (whole === undefined) continue;
    const valueStart = match.index + whole.length;
    const ctx = detectContext(text, valueStart);
    if (ctx === undefined || ctx.kind !== 'ref' || ctx.ref === undefined) continue;
    refs.push({ repo: ctx.repo, ref: ctx.ref, refRange: ctx.range });
  }

  for (const entry of listRepoEntries(text)) {
    const at = entry.range[1];
    if (text[at] !== '@') continue;
    const ctx = detectContext(text, at);
    if (ctx === undefined || ctx.kind !== 'shorthand' || ctx.ref === undefined) continue;
    refs.push({ repo: entry.repo, ref: ctx.ref, refRange: [at + 1, at + 1 + ctx.ref.length] });
  }

  return refs;
}

/**
 * Cache-only ref-not-found diagnostics (MINOR-10): for a verifiable ref, look
 * ONLY at the cached tags/branches for the repo. If neither list is cached no
 * diagnostic is produced and no RPC is fired; a ref absent from both cached
 * lists warns at the ref range.
 */
function buildRefNotFoundDiagnostics(refs: ReadonlyArray<RepoRef>, cache: RepoCache): Array<{ message: string; range: [number, number] }> {
  const out: Array<{ message: string; range: [number, number] }> = [];
  for (const item of refs) {
    if (!isRefVerifiable(item.ref)) continue;
    const tags = cache.get<readonly string[]>(`tags:${item.repo}`);
    const branches = cache.get<readonly string[]>(`branches:${item.repo}`);
    if (tags === undefined && branches === undefined) continue;
    if (tags?.includes(item.ref) === true) continue;
    if (branches?.includes(item.ref) === true) continue;
    out.push({ message: `ref не найден: ${item.repo}@${item.ref}`, range: item.refRange });
  }
  return out;
}

/**
 * Warning messages + ranges for repo entries whose `repos.info` result was
 * `missing` (`exists: false`). Pure, for unit-testing and the F1/F2 audit.
 */
export function buildExistenceDiagnostics(
  entries: ReadonlyArray<{ repo: string; range: [number, number] }>,
  infoResults: ReadonlyMap<string, 'exists' | 'missing' | 'error'>,
): Array<{ message: string; range: [number, number] }> {
  const out: Array<{ message: string; range: [number, number] }> = [];
  for (const entry of entries) {
    if (infoResults.get(entry.repo) !== 'missing') continue;
    out.push({ message: existsFalseMessage(entry.repo), range: entry.range });
  }
  return out;
}

/**
 * Full diagnostics for one manifest document: existence warnings from
 * `repos.info` (through the shared cache + dedupe) and cache-only
 * ref-not-found warnings. Warnings only — no info diagnostics.
 */
async function buildRepoDiagnostics(
  deps: FeatureDeps,
  client: ServeClient,
  text: string,
  project: Project,
  document: vscode.TextDocument,
  cache: RepoCache,
  token: vscode.CancellationToken,
): Promise<vscode.Diagnostic[]> {
  const diagnostics: vscode.Diagnostic[] = [];
  const entries = listRepoEntries(text);

  const configured = vscode.workspace.getConfiguration('amxb').get<string>('githubToken', '') ?? '';
  const githubToken = configured.length > 0 ? configured : undefined;
  const fc: FetchContext = { cache, token, log: deps.output.log };
  const manifest = project.manifestPath;

  const infoResults = new Map<string, 'exists' | 'missing' | 'error'>();
  await Promise.all(
    entries.map(async (entry) => {
      if (token.isCancellationRequested) return;
      const info = await fetchCached(
        `info:${entry.repo}`,
        INFO_TTL_MS,
        async () =>
          reposInfo(client, {
            repo: entry.repo,
            manifest,
            ...(githubToken !== undefined ? { token: githubToken } : {}),
          }),
        entry.repo,
        fc,
      );
      if (info === undefined) {
        infoResults.set(entry.repo, 'error');
        return;
      }
      infoResults.set(entry.repo, info.exists ? 'exists' : 'missing');
    }),
  );
  if (token.isCancellationRequested) return [];

  for (const item of buildExistenceDiagnostics(entries, infoResults)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(document.positionAt(item.range[0]), document.positionAt(item.range[1])),
        item.message,
        vscode.DiagnosticSeverity.Warning,
      ),
    );
  }

  for (const item of buildRefNotFoundDiagnostics(listRepoRefs(text), cache)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(document.positionAt(item.range[0]), document.positionAt(item.range[1])),
        item.message,
        vscode.DiagnosticSeverity.Warning,
      ),
    );
  }

  return diagnostics;
}

// ─── provider ─────────────────────────────────────────────────────────────────

/**
 * Project-local `.sma` paths relative to `amxmodx/scripting/`, for a
 * `plugins[*].match` position. Client-side presentation glue (no serve RPC)
 * mirroring `projectsTree.findPlugins`'s glob; `match` values are exactly
 * these relative paths (slash-separated).
 */
async function collectSmaMatchPaths(project: Project): Promise<string[]> {
  const pattern = new vscode.RelativePattern(project.rootPath, 'amxmodx/scripting/**/*.sma');
  const uris = await vscode.workspace.findFiles(pattern);
  const scriptingRoot = path.join(project.rootPath, 'amxmodx', 'scripting');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const uri of uris) {
    const rel = path.relative(scriptingRoot, uri.fsPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const norm = rel.split(path.sep).join('/');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort();
  return out;
}

async function collectCompletions(
  deps: FeatureDeps,
  ctx: vscode.ExtensionContext,
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
): Promise<vscode.CompletionItem[] | undefined> {
  const context = detectContext(document.getText(), document.offsetAt(position));
  if (context === undefined || context.kind === 'none' || context.kind === 'repo') return [];

  const project = deps.store.getProjectForUri(document.uri);
  if (!project) return [];

  if (context.kind === 'plugin_match') {
    const [rangeStart, rangeEnd] = valueRange(context);
    const range = new vscode.Range(document.positionAt(rangeStart), document.positionAt(rangeEnd));
    const files = await collectSmaMatchPaths(project);
    if (token.isCancellationRequested) return undefined;
    const items = buildFileItems(files);
    for (const item of items) item.range = range;
    return items;
  }

  const client = await getClient(deps, project);
  if (client === undefined) return [];

  if (token.isCancellationRequested) return undefined;

  const manifest = project.manifestPath;
  const configured = vscode.workspace.getConfiguration('amxb').get<string>('githubToken', '') ?? '';
  const githubToken = configured.length > 0 ? configured : undefined;

  const fc: FetchContext = { cache: getCache(ctx), token, log: deps.output.log };
  const [rangeStart, rangeEnd] = valueRange(context);
  const range = new vscode.Range(document.positionAt(rangeStart), document.positionAt(rangeEnd));
  const repo = context.repo;

  switch (context.kind) {
    case 'ref':
    case 'shorthand': {
      const tags = await fetchTags(client, repo, manifest, githubToken, fc);
      if (token.isCancellationRequested) return undefined;
      const branches = await fetchBranches(client, repo, manifest, githubToken, fc);
      if (token.isCancellationRequested) return undefined;
      const items = buildRefItems(tags ?? [], branches ?? []);
      for (const item of items) item.range = range;
      return items;
    }
    case 'asset': {
      if (context.source !== 'release') return [];
      const assets = await fetchReleaseAssets(client, repo, manifest, githubToken, fc);
      if (token.isCancellationRequested) return undefined;
      const items = buildAssetItems(assets ?? []);
      for (const item of items) item.range = range;
      return items;
    }
    case 'amxmodx_dir': {
      const dirs = await fetchStructure(client, repo, { dirsOnly: true, depth: 2 }, manifest, githubToken, fc);
      if (token.isCancellationRequested) return undefined;
      const items = buildDirItems((dirs ?? []).map((entry) => entry.path));
      for (const item of items) item.range = range;
      return items;
    }
    case 'exclude':
    case 'exclude_files': {
      const files = await fetchStructure(client, repo, { ext: ['sma'] }, manifest, githubToken, fc);
      if (token.isCancellationRequested) return undefined;
      const items = buildFileItems((files ?? []).map((entry) => entry.path));
      for (const item of items) item.range = range;
      return items;
    }
    default:
      return [];
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[] | undefined> {
      if (token.isCancellationRequested) return undefined;
      try {
        return await collectCompletions(deps, ctx, document, position, token);
      } catch (err) {
        // The provider must never throw to the editor.
        deps.output.log(`repo suggestions failed: ${String(err)}`);
        return [];
      }
    },
  };

  const completion = vscode.languages.registerCompletionItemProvider(
    [
      { scheme: 'file', pattern: '**/amxbuild.yml' },
      { scheme: 'file', pattern: '**/amxbuild.yaml' },
      { scheme: 'file', pattern: '**/manifest.yml' },
    ],
    provider,
    '@',
    '.',
    '-',
  );

  // ─── diagnostics half: existence + ref-not-found warnings ──────────────────

  const collection = vscode.languages.createDiagnosticCollection('amxb-repo');
  ctx.subscriptions.push(collection);

  let diagnosticsDebounce: NodeJS.Timeout | undefined;
  let diagnosticsCts: vscode.CancellationTokenSource | undefined;

  function clearDiagnosticsDebounce(): void {
    if (diagnosticsDebounce !== undefined) {
      clearTimeout(diagnosticsDebounce);
      diagnosticsDebounce = undefined;
    }
  }

  async function runDiagnostics(fsPath: string): Promise<void> {
    diagnosticsCts?.cancel();
    diagnosticsCts?.dispose();
    diagnosticsCts = new vscode.CancellationTokenSource();
    const token = diagnosticsCts.token;

    const uri = vscode.Uri.file(fsPath);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      collection.delete(uri);
      return;
    }

    const project = deps.store.getProjectForManifest(fsPath);
    if (!project) return;

    const client = await getClient(deps, project);
    if (client === undefined) {
      collection.delete(uri);
      return;
    }

    const diagnostics = await buildRepoDiagnostics(deps, client, document.getText(), project, document, getCache(ctx), token);
    if (token.isCancellationRequested) return;

    collection.set(uri, diagnostics);
    lastDiagnosticsManifest = fsPath;

    // Stale sweep: drop diagnostics for manifests that are no longer projects.
    const known = new Set(deps.store.getProjects().map((p) => p.manifestPath));
    for (const entry of collection) {
      if (!known.has(entry[0].fsPath)) collection.delete(entry[0]);
    }
  }

  function scheduleDiagnostics(fsPath: string): void {
    clearDiagnosticsDebounce();
    diagnosticsDebounce = setTimeout(() => {
      diagnosticsDebounce = undefined;
      void runDiagnostics(fsPath);
    }, DIAGNOSTICS_DEBOUNCE_MS);
  }

  // Recompute ref-not-found warnings once a tags/branches fill lands in the cache.
  onCacheFill = () => {
    if (lastDiagnosticsManifest !== undefined) scheduleDiagnostics(lastDiagnosticsManifest);
  };

  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    const doc = event.document;
    if (!isManifestFile(path.basename(doc.uri.fsPath))) return;
    if (!deps.store.getProjectForManifest(doc.uri.fsPath)) return;
    scheduleDiagnostics(doc.uri.fsPath);
  });

  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!isManifestFile(path.basename(doc.uri.fsPath))) return;
    if (!deps.store.getProjectForManifest(doc.uri.fsPath)) return;
    clearDiagnosticsDebounce();
    void runDiagnostics(doc.uri.fsPath);
  });

  return [
    completion,
    changeSub,
    saveSub,
    {
      dispose: () => {
        clearDiagnosticsDebounce();
        diagnosticsCts?.cancel();
        diagnosticsCts?.dispose();
        onCacheFill = undefined;
      },
    },
  ];
}
