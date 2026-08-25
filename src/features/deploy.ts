import * as vscode from 'vscode';
import { deployStart } from '../serve/methods';
import type { ServeClient } from '../serve/client';
import type { FeatureDeps } from '../core/types';

/** One-time friendly warning when the amxb binary is missing. */
let binaryWarned = false;

function handleClientError(deps: FeatureDeps, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.output.log(`amxb serve unavailable: ${message}`);
  if (!binaryWarned) {
    binaryWarned = true;
    void vscode.window.showWarningMessage(`AMXB: ${message}`);
  }
}

async function runDeploy(deps: FeatureDeps): Promise<void> {
  const project = deps.store.getCurrentProject() ?? deps.store.getRootProject();
  if (!project) {
    void vscode.window.showWarningMessage('No AMX Mod X project found in this workspace');
    return;
  }

  let client: ServeClient;
  try {
    client = await deps.clientFor(project);
  } catch (err) {
    handleClientError(deps, err);
    return;
  }

  const result = await deployStart(client, { manifest: project.manifestPath });
  if (result.ok) {
    const copied = result.copied ?? 0;
    deps.output.log(`Deploy complete: ${copied} file(s)`);
    void vscode.window.showInformationMessage(`Deploy complete: ${copied} file(s)`);
  } else {
    const message = result.message ?? 'Deploy failed';
    deps.output.log(`Deploy failed: ${message}`);
    void vscode.window.showErrorMessage(message);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  return [vscode.commands.registerCommand('amxb.deploy', () => void runDeploy(deps))];
}
