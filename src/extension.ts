import * as vscode from 'vscode';
import * as path from 'node:path';
import { createBuildBus } from './core/events';
import type { FeatureDeps } from './core/types';
import { createBinaryResolver } from './serve/binary';
import { ServeManager } from './serve/manager';
import type { ServeClient } from './serve/client';
import { createAmxbOutput } from './util/output';
import { createProjectStore } from './manifest/store';
import { startDetection } from './manifest/detector';
import { register as registerManifestDiagnostics } from './features/manifestDiagnostics';
import { register as registerManifestWebview } from './features/manifestWebview';
import { register as registerStatusBar } from './features/statusBar';
import { register as registerBuild } from './features/build';
import { register as registerCompileFile } from './features/compileFile';
import { register as registerDeploy } from './features/deploy';
import { register as registerProjectsTree } from './features/projectsTree';
import { register as registerDepActions } from './features/depActions';
import { register as registerPlanWebview } from './features/planWebview';
import { register as registerIncludeHover } from './features/includeHover';
import { register as registerSmaDiagnostics } from './features/smaDiagnostics';
import { register as registerWatchMode } from './features/watchMode';
import { register as registerRcon } from './features/rcon';
import { register as registerCacheInfo } from './features/cacheInfo';
import { register as registerBrowseIncludes } from './features/browseIncludes';
import { register as registerRepoSuggestions } from './features/repoSuggestions';

interface ClientProject {
  readonly manifestPath: string;
  readonly rootPath: string;
}

export function activate(ctx: vscode.ExtensionContext): void {
  const output = createAmxbOutput();

  const getBinary = createBinaryResolver(() => vscode.workspace.getConfiguration('amxb').get<string>('servePath', ''));

  const manager = new ServeManager({
    getBinary,
    onStderr: (manifestPath, line) => {
      output.log(`[${path.basename(path.dirname(manifestPath))}] ${line}`);
    },
  });

  const store = createProjectStore({
    workspaceFolders: vscode.workspace.workspaceFolders ?? [],
    clientFor: (project) => manager.getForManifest(project.manifestPath, project.rootPath),
    log: (message) => output.log(message),
  });

  const clientFor = (project: ClientProject): Promise<ServeClient> =>
    manager.getForManifest(project.manifestPath, project.rootPath);

  const bus = createBuildBus();

  const deps: FeatureDeps = {
    ctx,
    store,
    manager,
    output,
    bus,
    setBuildState: (state) => bus.setBuildState(state),
    clientFor,
  };

  const detection = startDetection(store, { log: (m) => output.log(m) });

  const features = [
    registerManifestDiagnostics,
    registerManifestWebview,
    registerStatusBar,
    registerBuild,
    registerCompileFile,
    registerDeploy,
    registerProjectsTree,
    registerDepActions,
    registerPlanWebview,
    registerIncludeHover,
    registerSmaDiagnostics,
    registerWatchMode,
    registerRcon,
    registerCacheInfo,
    registerBrowseIncludes,
    registerRepoSuggestions,
  ];

  const disposables: vscode.Disposable[] = [...detection];
  for (const register of features) {
    disposables.push(...register(ctx, deps));
  }

  ctx.subscriptions.push(...disposables, { dispose: () => void manager.stopAll() });
}

export function deactivate(): void {
  /* serve processes are stopped via the context subscription in activate() */
}
