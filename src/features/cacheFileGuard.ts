import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { cacheInfo } from '../serve/methods';
import { errMsg, getClient } from './depNodes';
import { dedupeRoots, isUnderAnyRoot } from './cacheGuardPaths';

const GUARD_SECTION = 'amxb.cacheEditGuard';
const ALLOW_COMMAND = 'amxb.allowCacheEdit';

const LENS_TITLE = '$(lock) Library file (amxb cache) — editing is not allowed';

function isGuardEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(GUARD_SECTION, true);
}

function currentProject(deps: FeatureDeps): Project | undefined {
  return deps.store.getCurrentProject() ?? deps.store.getRootProject();
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  let cacheRoots: string[] = [];
  const locked = new Map<string, string>();
  const allowed = new Set<string>();

  let inflight: Promise<void> | null = null;
  let rerun = false;

  const codeLensEmitter = new vscode.EventEmitter<void>();

  const isCacheFile = (uri: vscode.Uri): boolean => isUnderAnyRoot(uri.fsPath, cacheRoots);

  const lockIfClean = (doc: vscode.TextDocument): void => {
    const fsPath = doc.uri.fsPath;
    if (allowed.has(fsPath) || locked.has(fsPath) || !isCacheFile(doc.uri) || doc.isDirty) return;
    locked.set(fsPath, doc.getText());
  };

  const markOpenDocs = (): void => {
    for (const doc of vscode.workspace.textDocuments) {
      lockIfClean(doc);
    }
    codeLensEmitter.fire();
  };

  const refresh = (): void => {
    if (inflight !== null) {
      rerun = true;
      return;
    }
    inflight = (async () => {
      const project = currentProject(deps);
      if (!isGuardEnabled() || !project) {
        cacheRoots = [];
        locked.clear();
        markOpenDocs();
        return;
      }
      const client = await getClient(deps, project);
      if (!client) return;
      try {
        const info = await cacheInfo(client, project.manifestPath);
        const roots = info.cacheDir ? dedupeRoots([info.cacheDir]) : [];
        if (JSON.stringify(roots) !== JSON.stringify(cacheRoots)) {
          deps.output.log(`cache edit guard: cache root: ${roots.join(', ') || '(none)'}`);
        }
        cacheRoots = roots;
      } catch (err) {
        deps.output.log(`cache edit guard: cache.info failed: ${errMsg(err)}`);
        cacheRoots = [];
      }
      locked.clear();
      markOpenDocs();
    })().finally(() => {
      inflight = null;
      if (rerun) {
        rerun = false;
        refresh();
      }
    });
  };

  const allowEdit = (fsPath: string): void => {
    allowed.add(fsPath);
    locked.delete(fsPath);
    codeLensEmitter.fire();
  };

  const onDidChange = (event: vscode.TextDocumentChangeEvent): void => {
    if (!isGuardEnabled()) return;
    const doc = event.document;
    const fsPath = doc.uri.fsPath;
    const original = locked.get(fsPath);
    if (original === undefined || !isCacheFile(doc.uri)) return;
    if (doc.getText() === original) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange(doc), original);
    void vscode.workspace.applyEdit(edit).then((applied) => {
      if (!applied) deps.output.log(`cache edit guard: revert failed for ${fsPath}`);
    });
  };

  const codeLensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(doc): vscode.CodeLens[] {
      if (!isCacheFile(doc.uri) || !locked.has(doc.uri.fsPath)) return [];
      return [
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: `${LENS_TITLE} — Allow editing`,
          command: ALLOW_COMMAND,
          arguments: [doc.uri.fsPath],
        }),
      ];
    },
  };

  refresh();

  return [
    deps.store.onDidChange(refresh),
    deps.store.onDidChangeCurrentProject(refresh),
    deps.bus.onBuildStateChange((state) => {
      // A finished build may have created the cache for the first time.
      if (state.kind === 'idle') refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (deps.store.getProjects().some((p) => p.manifestPath === doc.uri.fsPath)) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(GUARD_SECTION)) refresh();
    }),
    vscode.workspace.onDidOpenTextDocument(lockIfClean),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      locked.delete(doc.uri.fsPath);
    }),
    vscode.workspace.onDidChangeTextDocument(onDidChange),
    vscode.commands.registerCommand(ALLOW_COMMAND, (fsPath?: unknown) => {
      if (typeof fsPath === 'string') allowEdit(fsPath);
    }),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    { dispose: () => void (inflight = null) },
  ];
}
