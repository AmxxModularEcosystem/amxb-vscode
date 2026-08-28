import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { amxmodxIncludesList, includeList } from '../serve/methods';
import { errMsg, getClient } from './depNodes';
import { dedupePreservingOrder, mergeIncludeDirs } from './pawnExtMerge';

/**
 * Feed the include directories of the dependency versions resolved by `amxb
 * serve` into the `Faktor.amxx-pawn-all-in` extension so its IntelliSense and
 * diagnostics resolve `#include <>` against the exact versions this project
 * uses (that extension only knows statically configured paths).
 *
 * The resolved dirs are written at the BEGINNING of
 * `amxxPawnAllIn.globalIncludePaths` (workspace scope): that extension walks
 * its search paths in array order and takes the first match, so versioned
 * dependency dirs must precede manually configured global paths.
 *
 * Previously written dirs are tracked in workspaceState and removed again when
 * a dependency version changes, a dependency is removed, the feature is
 * disabled, or the target extension disappears.
 */

const TARGET_CONFIG = 'amxxPawnAllIn';
const TARGET_KEY = 'globalIncludePaths';
const ALL_IN_EXTENSION_ID = 'Faktor.amxx-pawn-all-in';
const MEMENTO_KEY = 'pawnExt.prevWritten';

const SYNC_SECTION = 'amxb.pawnExt';
const SYNC_KEY = 'syncIncludePaths';

function isSyncEnabled(): boolean {
  return vscode.workspace.getConfiguration(SYNC_SECTION).get<boolean>(SYNC_KEY, false);
}

function isTargetInstalled(): boolean {
  return vscode.extensions.getExtension(ALL_IN_EXTENSION_ID) !== undefined;
}

function currentProject(deps: FeatureDeps): Project | undefined {
  return deps.store.getCurrentProject() ?? deps.store.getRootProject();
}

/** Remove dirs we wrote in a previous sync from the setting (leave no trace). */
async function cleanup(ctx: vscode.ExtensionContext, deps: FeatureDeps): Promise<void> {
  const prevWritten = ctx.workspaceState.get<string[]>(MEMENTO_KEY, []);
  if (prevWritten.length === 0) return;

  const config = vscode.workspace.getConfiguration(TARGET_CONFIG);
  const current = config.get<string[]>(TARGET_KEY, []);
  const merged = mergeIncludeDirs([], current, prevWritten);
  try {
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      await config.update(TARGET_KEY, merged, vscode.ConfigurationTarget.Workspace);
    }
  } catch (err) {
    deps.output.log(`pawnExt include sync: config update failed: ${errMsg(err)}`);
    return;
  }
  await ctx.workspaceState.update(MEMENTO_KEY, []);
}

async function runSync(ctx: vscode.ExtensionContext, deps: FeatureDeps): Promise<void> {
  const hasWorkspace = (vscode.workspace.workspaceFolders ?? []).length > 0;
  const project = currentProject(deps);

  if (!isSyncEnabled() || !isTargetInstalled() || !hasWorkspace || !project) {
    await cleanup(ctx, deps);
    return;
  }

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

  const resolved = dedupePreservingOrder(ours);
  const config = vscode.workspace.getConfiguration(TARGET_CONFIG);
  const current = config.get<string[]>(TARGET_KEY, []);
  const prevWritten = ctx.workspaceState.get<string[]>(MEMENTO_KEY, []);
  const merged = mergeIncludeDirs(resolved, current, prevWritten);

  try {
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      await config.update(TARGET_KEY, merged, vscode.ConfigurationTarget.Workspace);
    }
  } catch (err) {
    deps.output.log(`pawnExt include sync: config update failed: ${errMsg(err)}`);
    return;
  }
  await ctx.workspaceState.update(MEMENTO_KEY, resolved);
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  let inflight: Promise<void> | null = null;
  let rerun = false;

  const sync = (): void => {
    if (inflight !== null) {
      rerun = true;
      return;
    }
    inflight = runSync(ctx, deps).finally(() => {
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
