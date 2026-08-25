import * as vscode from 'vscode';
import { cacheInfo, compilerInfo } from '../serve/methods';
import type { ServeClient } from '../serve/client';
import type { FeatureDeps, Project } from '../core/types';

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

async function showCacheInfo(deps: FeatureDeps): Promise<void> {
  const project = pickProject(deps);
  if (!project) {
    void vscode.window.showWarningMessage('No AMXB project selected.');
    return;
  }
  const client = await getClient(deps, project);
  if (!client) return;

  try {
    const info = await cacheInfo(client, project.manifestPath);
    deps.output.show();
    deps.output.append(`── Cache info (${project.displayName}) ──\n`);
    for (const key of Object.keys(info)) {
      deps.output.append(`\n[${key}]\n`);
      deps.output.append(JSON.stringify(info[key], null, 2) + '\n');
    }
    void vscode.window.showInformationMessage('Cache info written to output');
  } catch (err) {
    deps.output.log(`cache.info failed: ${String(err)}`);
    void vscode.window.showErrorMessage(`Could not fetch cache info: ${String(err)}`);
  }
}

async function showCompilerInfo(deps: FeatureDeps): Promise<void> {
  const project = pickProject(deps);
  if (!project) {
    void vscode.window.showWarningMessage('No AMXB project selected.');
    return;
  }
  const client = await getClient(deps, project);
  if (!client) return;

  try {
    const info = await compilerInfo(client, { manifest: project.manifestPath, noFetch: false });
    deps.output.show();
    deps.output.append(`── Compiler info (${project.displayName}) ──\n`);
    deps.output.append(`version:       ${info.version}\n`);
    deps.output.append(`platform:      ${info.platform ?? 'unknown'}\n`);
    deps.output.append(`compilerPath:  ${info.compilerPath ?? '(none)'}\n`);
    deps.output.append(`includeDir:    ${info.includeDir ?? '(none)'}\n`);
    deps.output.append(`cached:        ${info.cached ? 'yes' : 'no'}\n`);
    void vscode.window.showInformationMessage(`Compiler ${info.version} ${info.cached ? '(cached)' : '(fetched)'}`);
  } catch (err) {
    deps.output.log(`compiler.info failed: ${String(err)}`);
    void vscode.window.showErrorMessage(`Could not fetch compiler info: ${String(err)}`);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const cache = vscode.commands.registerCommand('amxb.cacheInfo', () => {
    void showCacheInfo(deps);
  });
  const compiler = vscode.commands.registerCommand('amxb.compilerInfo', () => {
    void showCompilerInfo(deps);
  });
  return [cache, compiler];
}
