import * as vscode from 'vscode';
import * as path from 'node:path';
import { buildCancel, buildStart } from '../serve/methods';
import type { ServeClient } from '../serve/client';
import type { BuildStartResult } from '../serve/protocol';
import { parseCompilerOutput } from '../util/parseCompiler';
import type { BuildEvent } from '../core/events';
import type { FeatureDeps, Project } from '../core/types';
import { applyCompilerDiagnostics } from './compileDiag';

/** The single in-flight build; the serve server allows at most one. */
let activeBuild: { readonly project: Project; readonly client: ServeClient } | null = null;
/** Last build.compiled payload, re-applied as diagnostics after the build ends. */
let lastCompiled: { readonly project: Project; readonly output: string } | null = null;
/** One-time friendly warning when the amxb binary is missing. */
let binaryWarned = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function handleClientError(deps: FeatureDeps, err: unknown, project: Project): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.output.log(`amxb serve unavailable: ${message}`);
  deps.setBuildState({ kind: 'error', message, projectName: project.displayName });
  if (!binaryWarned) {
    binaryWarned = true;
    void vscode.window.showWarningMessage(`AMXB: ${message}`);
  }
}

function logCompiled(
  deps: FeatureDeps,
  project: Project,
  collection: vscode.DiagnosticCollection,
  baseName: string,
  ok: boolean,
  output: string,
): void {
  deps.output.log(`${ok ? '✓' : '✗'} ${baseName}`);
  const parsed = parseCompilerOutput(output);
  const firstError = parsed.diagnostics.find((d) => d.severity === 'error');
  if (firstError) {
    const at = firstError.line !== null ? `(${firstError.line})` : '';
    deps.output.log(`  ${path.basename(firstError.file)}${at}: ${firstError.message}`);
  }
  applyCompilerDiagnostics(collection, parsed.diagnostics, project.rootPath, vscode.workspace.workspaceFolders ?? []);
}

function handleNotify(
  deps: FeatureDeps,
  project: Project,
  collection: vscode.DiagnosticCollection,
  method: string,
  params: unknown,
): void {
  switch (method) {
    case 'build.stage': {
      if (!isRecord(params)) return;
      const stage = asString(params.stage, 'unknown');
      const message = asString(params.message, '');
      deps.bus.emitBuildEvent({ kind: 'stage', stage, message });
      deps.setBuildState({ kind: 'building', stage, projectName: project.displayName });
      deps.output.log(`[${stage}] ${message}`);
      return;
    }
    case 'build.progress': {
      if (!isRecord(params)) return;
      deps.bus.emitBuildEvent({
        kind: 'progress',
        label: asString(params.label, ''),
        current: asNumber(params.current, 0),
        total: asNumber(params.total, 0),
      });
      return;
    }
    case 'build.compiled': {
      if (!isRecord(params)) return;
      const baseName = asString(params.baseName, 'unknown');
      const ok = params.ok === true;
      const output = asString(params.output, '');
      const event: BuildEvent = { kind: 'compiled', baseName, ok, ...(output !== '' ? { output } : {}) };
      deps.bus.emitBuildEvent(event);
      lastCompiled = { project, output };
      logCompiled(deps, project, collection, baseName, ok, output);
      return;
    }
    case 'build.done': {
      if (!isRecord(params)) return;
      const ok = params.ok === true;
      const elapsed = asString(params.elapsed, '');
      const message = asString(params.message, '');
      deps.bus.emitBuildEvent({
        kind: 'done',
        ok,
        ...(elapsed !== '' ? { elapsed } : {}),
        ...(message !== '' ? { message } : {}),
      });
      return;
    }
    case 'build.error': {
      if (!isRecord(params)) return;
      const message = asString(params.message, 'Build failed');
      deps.bus.emitBuildEvent({ kind: 'done', ok: false, message });
      deps.output.log(`Build error: ${message}`);
      return;
    }
    default:
      return;
  }
}

function refreshBuildDiagnostics(collection: vscode.DiagnosticCollection): void {
  const last = lastCompiled;
  if (!last) return;
  const parsed = parseCompilerOutput(last.output);
  applyCompilerDiagnostics(collection, parsed.diagnostics, last.project.rootPath, vscode.workspace.workspaceFolders ?? []);
}

async function runBuild(deps: FeatureDeps, collection: vscode.DiagnosticCollection): Promise<void> {
  if (activeBuild) {
    void vscode.window.showInformationMessage('Build already running');
    return;
  }
  const project = deps.store.getCurrentProject() ?? deps.store.getRootProject();
  if (!project) {
    void vscode.window.showWarningMessage('No AMX Mod X project found in this workspace');
    return;
  }

  const config = vscode.workspace.getConfiguration('amxb');
  const archive = config.get('build.archive', true);
  const fetch = config.get('build.fetch', true);

  deps.output.clear();
  deps.output.show();
  const label = project.version ? `${project.displayName}@${project.version}` : project.displayName;
  deps.output.log(`Building ${label} (archive=${archive}, fetch=${fetch})`);
  deps.setBuildState({ kind: 'building', stage: 'starting', projectName: project.displayName });

  let client: ServeClient;
  try {
    client = await deps.clientFor(project);
  } catch (err) {
    handleClientError(deps, err, project);
    return;
  }

  activeBuild = { project, client };
  lastCompiled = null;
  let reporter: ((value: { readonly message?: string; readonly increment?: number }) => void) | undefined;

  const unsubscribe = client.onNotify((method, params) => {
    if (method === 'build.progress' && isRecord(params)) {
      reporter?.({ message: `${asString(params.label, '')} ${asNumber(params.current, 0)}/${asNumber(params.total, 0)}` });
      return;
    }
    handleNotify(deps, project, collection, method, params);
  });

  let result: BuildStartResult;
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Building ${project.displayName}…`,
        cancellable: true,
      },
      async (progress, token) => {
        reporter = (value) => progress.report(value);
        token.onCancellationRequested(() => {
          deps.output.log('Cancellation requested');
          void buildCancel(client).catch((err) => deps.output.log(`Cancel failed: ${String(err)}`));
        });
        return buildStart(client, { manifest: project.manifestPath, archive, fetch });
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.output.log(`Build request failed: ${message}`);
    deps.setBuildState({ kind: 'error', message, projectName: project.displayName });
    return;
  } finally {
    unsubscribe();
    activeBuild = null;
    reporter = undefined;
  }

  refreshBuildDiagnostics(collection);
  handleResult(deps, project, result);
}

function handleResult(deps: FeatureDeps, project: Project, result: BuildStartResult): void {
  if (result.ok && result.cancelled !== true) {
    const elapsed = result.elapsed ?? '?';
    deps.output.log(`Build finished in ${elapsed}s`);
    deps.setBuildState({ kind: 'idle' });
    void vscode.window.showInformationMessage(`Build finished in ${elapsed}s`);
    return;
  }
  if (result.cancelled) {
    deps.output.log('Build cancelled');
    deps.setBuildState({ kind: 'idle' });
    void vscode.window.showInformationMessage('Build cancelled');
    return;
  }
  const message = result.message ?? 'Build failed';
  deps.output.log(`Build failed: ${message}`);
  deps.setBuildState({ kind: 'error', message, projectName: project.displayName });
  deps.output.show();
  void vscode.window.showErrorMessage(message);
}

async function cancelBuild(deps: FeatureDeps): Promise<void> {
  const build = activeBuild;
  if (!build) {
    void vscode.window.showInformationMessage('No build running');
    return;
  }
  deps.output.log('Cancellation requested');
  try {
    const result = await buildCancel(build.client);
    if (!result.ok) deps.output.log(`Cancel failed: ${result.error ?? 'unknown'}`);
  } catch (err) {
    deps.output.log(`Cancel failed: ${String(err)}`);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection('amxb-build');
  ctx.subscriptions.push(collection);
  return [
    vscode.commands.registerCommand('amxb.build', () => void runBuild(deps, collection)),
    vscode.commands.registerCommand('amxb.cancelBuild', () => void cancelBuild(deps)),
  ];
}
