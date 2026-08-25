import * as vscode from 'vscode';
import { manifestResolve, rconSend } from '../serve/methods';
import { RpcError } from '../serve/client';
import type { ServeClient } from '../serve/client';
import type { FeatureDeps, Project } from '../core/types';

const RCON_PRESETS = [
  { label: 'amxx list', description: 'List loaded plugins' },
  { label: 'amxx plugins', description: 'List plugin status' },
  { label: 'amxx version', description: 'AMX Mod X version' },
  { label: 'amxx status', description: 'Server and plugin status' },
  { label: 'amxx reload <plugin>', description: 'Reload a plugin by name' },
] satisfies readonly vscode.QuickPickItem[];

const CUSTOM_LABEL = 'Type a command...';
const RELOAD_LABEL = 'amxx reload <plugin>';

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

async function runRcon(deps: FeatureDeps): Promise<void> {
  const project = pickProject(deps);
  if (!project) {
    void vscode.window.showWarningMessage('No AMXB project selected.');
    return;
  }
  const client = await getClient(deps, project);
  if (!client) return;

  let resolved;
  try {
    resolved = await manifestResolve(client, project.manifestPath);
  } catch (err) {
    deps.output.log(`manifest.resolve failed: ${String(err)}`);
    void vscode.window.showErrorMessage(`Could not read RCON config: ${String(err)}`);
    return;
  }

  const rconConfig = resolved.deploy?.rcon;
  if (!rconConfig?.host && !rconConfig?.password) {
    void vscode.window.showWarningMessage(
      'RCON is not configured. Set deploy.rcon in amxbuild.yml or pass host/password explicitly.',
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [...RCON_PRESETS, { label: CUSTOM_LABEL, description: 'Enter a raw RCON command' }],
    { placeHolder: 'RCON command' },
  );
  if (!picked) return;

  let command: string;
  if (picked.label === CUSTOM_LABEL) {
    const input = await vscode.window.showInputBox({ prompt: 'RCON command' });
    if (!input || input.trim() === '') return;
    command = input.trim();
  } else if (picked.label === RELOAD_LABEL) {
    const plugin = await vscode.window.showInputBox({ prompt: 'Plugin name (without .amxx)' });
    if (!plugin || plugin.trim() === '') return;
    command = `amxx reload ${plugin.trim()}`;
  } else {
    command = picked.label;
  }

  try {
    const resp = await rconSend(client, { command, manifest: project.manifestPath });
    deps.output.show();
    deps.output.append(`RCON > ${command}\n${resp.response}\n`);
    void vscode.window.showInformationMessage(resp.response.slice(0, 200));
  } catch (err) {
    if (err instanceof RpcError) {
      if (err.code === -32602) {
        void vscode.window.showWarningMessage(err.message);
      } else if (err.code === -32603) {
        void vscode.window.showErrorMessage('RCON timeout — server unreachable');
      } else {
        void vscode.window.showErrorMessage(err.message);
      }
    } else {
      void vscode.window.showErrorMessage(String(err));
    }
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const command = vscode.commands.registerCommand('amxb.rcon', () => {
    void runRcon(deps);
  });
  return [command];
}
