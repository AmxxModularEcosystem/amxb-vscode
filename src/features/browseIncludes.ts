import * as path from 'node:path';
import * as vscode from 'vscode';
import { amxmodxIncludesList } from '../serve/methods';
import type { AmxmodxIncludesListResult } from '../serve/protocol';
import type { ServeClient } from '../serve/client';
import type { FeatureDeps, Project } from '../core/types';

const REFRESH_LABEL = '$(refresh) Refresh';

let warnedBinary = false;

function pickProject(deps: FeatureDeps): Project | undefined {
  return deps.store.getCurrentProject() ?? deps.store.getRootProject();
}

async function getClient(deps: FeatureDeps, project: Project): Promise<ServeClient | undefined> {
  try {
    return await deps.clientFor(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.output.log(`amxb serve unavailable: ${msg}`);
    if (!warnedBinary) {
      warnedBinary = true;
      void vscode.window.showWarningMessage(`AMXB: ${msg}`);
    }
    return undefined;
  }
}

async function browse(deps: FeatureDeps): Promise<void> {
  const project = pickProject(deps);
  if (!project) {
    void vscode.window.showWarningMessage('No AMXB project selected.');
    return;
  }
  const client = await getClient(deps, project);
  if (!client) return;

  let result: AmxmodxIncludesListResult;
  try {
    result = await amxmodxIncludesList(client, { manifest: project.manifestPath, pattern: '*.inc' });
  } catch (err) {
    deps.output.log(`amxmodx.includes.list failed: ${String(err)}`);
    void vscode.window.showErrorMessage(`Could not list AMXX includes: ${String(err)}`);
    return;
  }

  const includeDir = result.includeDir;
  if (includeDir === null) {
    void vscode.window.showErrorMessage(
      'AMXX compiler is not cached and could not be fetched. Run a build or compile first.',
    );
    return;
  }

  const refreshItem: vscode.QuickPickItem = {
    label: REFRESH_LABEL,
    description: 'Re-query the AMXX include list',
  };
  const items: vscode.QuickPickItem[] = [
    refreshItem,
    ...result.files.map((file) => ({ label: file, description: file, detail: file })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: 'AMXX includes (type to filter)',
  });
  if (!picked) return;
  if (picked === refreshItem) {
    void browse(deps);
    return;
  }

  try {
    const doc = await vscode.window.showTextDocument(vscode.Uri.file(path.join(includeDir, picked.label)));
    void doc;
  } catch (err) {
    void vscode.window.showWarningMessage(`Could not open include: ${String(err)}`);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const command = vscode.commands.registerCommand('amxb.browseIncludes', () => {
    void browse(deps);
  });
  return [command];
}
