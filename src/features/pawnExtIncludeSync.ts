import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { amxmodxIncludesList, includeList } from '../serve/methods';
import { errMsg, getClient } from './depNodes';
import { dedupeRoots } from './cacheGuardPaths';

/**
 * Feed the include directories of the dependency versions resolved by `amxb
 * serve` to the `Faktor.amxx-pawn-all-in` extension through its programmatic
 * include-paths API (see PAWN_INCLUDE_PATHS_API.md): runtime-only, in-memory,
 * nothing written to settings or files.
 *
 * The API is exposed by that extension's `activate()` (implemented since
 * v1.13.0): `exports.setIncludePaths(contributorId, paths)`. If the installed
 * extension does not expose it yet, this feature stays dormant. The resolved
 * dirs are contributed under the `amxb-vscode` contributor id and the extension
 * re-scans live on change.
 */

const ALL_IN_EXTENSION_ID = 'Faktor.amxx-pawn-all-in';
const CONTRIBUTOR_ID = 'amxb-vscode';

const SYNC_SECTION = 'amxb.pawnExt';
const SYNC_KEY = 'syncIncludePaths';

interface IncludePathsApi {
  setIncludePaths(contributorId: string, paths: readonly string[]): void;
  clearIncludePaths(contributorId: string): void;
}

let lastContributedSignature: string | null = null;

function isSyncEnabled(): boolean {
  return vscode.workspace.getConfiguration(SYNC_SECTION).get<boolean>(SYNC_KEY, true);
}

function currentProject(deps: FeatureDeps): Project | undefined {
  return deps.store.getCurrentProject() ?? deps.store.getRootProject();
}

function readApi(): IncludePathsApi | undefined {
  const exports = vscode.extensions.getExtension(ALL_IN_EXTENSION_ID)?.exports as
    | Partial<IncludePathsApi>
    | null
    | undefined;
  if (
    exports &&
    typeof exports.setIncludePaths === 'function' &&
    typeof exports.clearIncludePaths === 'function'
  ) {
    return exports as IncludePathsApi;
  }
  return undefined;
}

async function ensureApi(deps: FeatureDeps): Promise<IncludePathsApi | undefined> {
  const ext = vscode.extensions.getExtension(ALL_IN_EXTENSION_ID);
  if (!ext) return undefined;
  try {
    await ext.activate();
  } catch (err) {
    deps.output.log(`pawnExt include sync: activation failed: ${errMsg(err)}`);
    return undefined;
  }
  return readApi();
}

async function runSync(ctx: vscode.ExtensionContext, deps: FeatureDeps): Promise<void> {
  const hasWorkspace = (vscode.workspace.workspaceFolders ?? []).length > 0;
  const project = currentProject(deps);

  if (!isSyncEnabled() || !hasWorkspace || !project) {
    const api = readApi();
    if (api) api.clearIncludePaths(CONTRIBUTOR_ID);
    return;
  }

  const api = await ensureApi(deps);
  if (!api) return;

  const client = await getClient(deps, project);
  if (!client) return;

  const ours: string[] = [];
  try {
    const list = await includeList(client, { manifest: project.manifestPath, noFetch: true });
    for (const dep of list.deps) {
      if (dep.error === undefined && dep.include_dir !== undefined) {
        ours.push(dep.include_dir);
      }
    }
  } catch (err) {
    deps.output.log(`pawnExt include sync: include.list failed: ${errMsg(err)}`);
    return;
  }

  try {
    const stdlib = await amxmodxIncludesList(client, { manifest: project.manifestPath, pattern: '*.inc' });
    if (stdlib.includeDir !== null && stdlib.files.length > 0) {
      ours.push(stdlib.includeDir);
    }
  } catch (err) {
    deps.output.log(`pawnExt include sync: amxmodx.includes.list failed: ${errMsg(err)}`);
  }

  const dirs = dedupeRoots(ours);
  api.setIncludePaths(CONTRIBUTOR_ID, dirs);
  const signature = JSON.stringify(dirs);
  if (signature !== lastContributedSignature) {
    lastContributedSignature = signature;
    deps.output.log(`pawnExt include sync: contributed ${dirs.length} include dir(s) to amxx-pawn-all-in`);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  let inflight: Promise<void> | null = null;
  let rerun = false;

  const sync = (): void => {
    if (inflight !== null) {
      rerun = true;
      return;
    }
    inflight = runSync(ctx, deps)
      .catch((err: unknown) => deps.output.log(`pawnExt include sync: ${errMsg(err)}`))
      .finally(() => {
        inflight = null;
        if (rerun) {
          rerun = false;
          sync();
        }
      });
  };

  sync();

  return [
    deps.store.onDidChange(sync),
    deps.store.onDidChangeCurrentProject(sync),
    deps.bus.onBuildStateChange((state) => {
      // A finished build may have fetched/materialized dependencies, making
      // include dirs that were absent available for the first time.
      if (state.kind === 'idle') sync();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Manifest saved → a dependency ref may have changed. getProjectForUri
      // matches ANY file inside a project root, so compare manifest paths.
      if (deps.store.getProjects().some((p) => p.manifestPath === doc.uri.fsPath)) sync();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SYNC_SECTION}.${SYNC_KEY}`)) sync();
    }),
    vscode.extensions.onDidChange(sync),
    { dispose: () => void (inflight = null) },
  ];
}
