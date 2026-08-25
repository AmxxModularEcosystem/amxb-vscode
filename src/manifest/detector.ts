import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Project } from '../core/types';
import type { ManifestProjectStore } from './store';

/**
 * Manifest discovery: root manifests of every workspace folder (primary) plus
 * a recursive scan for subdirectory manifests. Keeps the ProjectStore in sync
 * via file-system watchers.
 */

const MANIFEST_NAMES = ['amxbuild.yml', 'amxbuild.yaml', 'manifest.yml'] as const;
const SUBDIR_PATTERNS = ['**/amxbuild.{yml,yaml}', '**/manifest.yml'] as const;
const EXCLUDE_PATTERN = '**/{node_modules,.git}/**';

export function isManifestFile(fileName: string): boolean {
  return (MANIFEST_NAMES as readonly string[]).includes(fileName);
}

interface DetectionDeps {
  readonly log: (message: string) => void;
}

function createProject(manifestPath: string, folder: vscode.WorkspaceFolder | undefined, isRoot: boolean): Project {
  const rootPath = path.dirname(manifestPath);
  return {
    rootPath,
    manifestPath,
    manifestFile: path.basename(manifestPath),
    workspaceFolder: folder,
    isRoot,
    displayName: path.basename(rootPath),
    version: undefined,
    validation: undefined,
  };
}

async function findRootManifest(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  for (const name of MANIFEST_NAMES) {
    const uri = vscode.Uri.joinPath(folder.uri, name);
    try {
      await vscode.workspace.fs.stat(uri);
      return uri.fsPath;
    } catch {
      /* not present */
    }
  }
  return undefined;
}

async function reconcile(store: ManifestProjectStore, log: (message: string) => void): Promise<void> {
  const desired = new Map<string, Project>();

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const rootManifest = await findRootManifest(folder);
    if (rootManifest) {
      desired.set(rootManifest, createProject(rootManifest, folder, true));
    }
  }

  for (const pattern of SUBDIR_PATTERNS) {
    const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_PATTERN);
    for (const uri of uris) {
      const manifestPath = uri.fsPath;
      if (desired.has(manifestPath)) continue;
      desired.set(manifestPath, createProject(manifestPath, vscode.workspace.getWorkspaceFolder(uri), false));
    }
  }

  for (const existing of store.getProjects()) {
    if (!desired.has(existing.manifestPath)) {
      store.removeProject(existing);
    }
  }
  for (const [manifestPath, project] of desired) {
    if (!store.getProjectForManifest(manifestPath)) {
      store.addProject(project);
    }
  }
}

export function startDetection(store: ManifestProjectStore, deps: DetectionDeps): vscode.Disposable[] {
  const watcher1 = vscode.workspace.createFileSystemWatcher('**/amxbuild.{yml,yaml}');
  const watcher2 = vscode.workspace.createFileSystemWatcher('**/manifest.yml');

  const onCreated = (uri: vscode.Uri): void => {
    if (!store.getProjectForManifest(uri.fsPath)) {
      void reconcile(store, deps.log);
    }
  };
  const onDeleted = (uri: vscode.Uri): void => {
    const project = store.getProjectForManifest(uri.fsPath);
    if (project) {
      store.removeProject(project);
    }
  };
  const onChanged = (uri: vscode.Uri): void => {
    const project = store.getProjectForManifest(uri.fsPath);
    if (project) {
      // Invalidates cached validation; the diagnostics feature revalidates.
      store.updateProject(project, { validation: undefined });
    }
  };

  watcher1.onDidCreate(onCreated);
  watcher1.onDidDelete(onDeleted);
  watcher1.onDidChange(onChanged);
  watcher2.onDidCreate(onCreated);
  watcher2.onDidDelete(onDeleted);
  watcher2.onDidChange(onChanged);

  const folderChange = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void reconcile(store, deps.log);
  });

  void reconcile(store, deps.log);

  return [watcher1, watcher2, folderChange];
}
