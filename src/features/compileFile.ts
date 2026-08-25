import * as vscode from 'vscode';
import * as path from 'node:path';
import { compileSingle, deployFile } from '../serve/methods';
import type { ServeClient } from '../serve/client';
import { parseCompilerOutput } from '../util/parseCompiler';
import type { FeatureDeps, Project } from '../core/types';
import { applyCompilerDiagnostics } from './compileDiag';

/** Result of the last successful single-file compile (for the deploy commands). */
interface LastCompile {
  readonly project: Project;
  readonly manifest: string;
  readonly amxxName: string;
  readonly outputPath: string;
}

type CompileOutcome =
  | { readonly kind: 'ok'; readonly compiled: LastCompile }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'noop' };

let lastCompile: LastCompile | null = null;
let binaryWarned = false;

const COMPILE_TIMEOUT_MS = 300_000;

function handleClientError(deps: FeatureDeps, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.output.log(`amxb serve unavailable: ${message}`);
  if (!binaryWarned) {
    binaryWarned = true;
    void vscode.window.showWarningMessage(`AMXB: ${message}`);
  }
}

async function compileUri(
  deps: FeatureDeps,
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri | undefined,
): Promise<CompileOutcome> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showWarningMessage('No .sma file selected — open one or run from the explorer context menu');
    return { kind: 'noop' };
  }
  if (!target.path.toLowerCase().endsWith('.sma')) {
    void vscode.window.showWarningMessage('AMXB compile requires a .sma file');
    return { kind: 'noop' };
  }

  const project = deps.store.getProjectForUri(target) ?? deps.store.getCurrentProject() ?? deps.store.getRootProject();
  if (!project) {
    void vscode.window.showWarningMessage('No AMX Mod X project found in this workspace');
    return { kind: 'noop' };
  }

  let client: ServeClient;
  try {
    client = await deps.clientFor(project);
  } catch (err) {
    handleClientError(deps, err);
    return { kind: 'noop' };
  }

  deps.output.show();
  deps.output.line();
  deps.output.log(`── Compile ${path.basename(target.fsPath)} ──`);

  const result = await compileSingle(
    client,
    {
      sma_file: target.fsPath,
      manifest: project.manifestPath,
      scripting_root: path.join(project.rootPath, 'amxmodx', 'scripting'),
      noFetch: false,
    },
    { timeoutMs: COMPILE_TIMEOUT_MS },
  );

  const output = result.output ?? '';
  deps.output.append(output);
  const parsed = parseCompilerOutput(output);
  applyCompilerDiagnostics(collection, parsed.diagnostics, project.rootPath, vscode.workspace.workspaceFolders ?? []);

  if (!result.ok) {
    const message = `Compilation failed: ${result.amxxName ?? 'unknown'}`;
    deps.output.log(message);
    return { kind: 'failed', message };
  }
  if (!result.amxxName || !result.output_path) {
    const message = 'Compilation finished without a plugin path';
    deps.output.log(message);
    return { kind: 'failed', message };
  }

  const compiled: LastCompile = {
    project,
    manifest: project.manifestPath,
    amxxName: result.amxxName,
    outputPath: result.output_path,
  };
  lastCompile = compiled;
  return { kind: 'ok', compiled };
}

function reportFailure(deps: FeatureDeps, message: string): void {
  void vscode.window.showErrorMessage(message);
  deps.output.show();
}

/** output_path is .../amxmodx/plugins/<name>.amxx; buildDir is its grand-parent. */
function deriveBuildDir(outputPath: string): string {
  return path.dirname(path.dirname(path.dirname(outputPath)));
}

async function deployLast(deps: FeatureDeps): Promise<void> {
  const last = lastCompile;
  if (!last) {
    void vscode.window.showWarningMessage('Compile a file first');
    return;
  }

  let client: ServeClient;
  try {
    client = await deps.clientFor(last.project);
  } catch (err) {
    handleClientError(deps, err);
    return;
  }

  const result = await deployFile(client, {
    relPath: `plugins/${last.amxxName}`,
    section: 'amxmodx',
    manifest: last.manifest,
    buildDir: deriveBuildDir(last.outputPath),
  });

  if (result.ok && result.dest) {
    deps.output.log(`Deployed ${last.amxxName} → ${result.dest}`);
    void vscode.window.showInformationMessage(`Deployed to ${result.dest}`);
  } else {
    const message = result.message ?? 'Deploy failed';
    deps.output.log(`Deploy failed: ${message}`);
    void vscode.window.showErrorMessage(message);
  }
}

async function runCompile(
  deps: FeatureDeps,
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri | undefined,
): Promise<void> {
  const outcome = await compileUri(deps, collection, uri);
  if (outcome.kind === 'ok') {
    void vscode.window.showInformationMessage(`Compiled ${outcome.compiled.amxxName}`, 'Deploy', 'Open Output').then((action) => {
      if (action === 'Deploy') void vscode.commands.executeCommand('amxb.deployCompiledFile');
      if (action === 'Open Output') deps.output.show();
    });
  } else if (outcome.kind === 'failed') {
    reportFailure(deps, outcome.message);
  }
}

async function runCompileAndDeploy(
  deps: FeatureDeps,
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri | undefined,
): Promise<void> {
  const outcome = await compileUri(deps, collection, uri);
  if (outcome.kind === 'ok') {
    await deployLast(deps);
  } else if (outcome.kind === 'failed') {
    reportFailure(deps, outcome.message);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection('amxb-compile');
  ctx.subscriptions.push(collection);
  return [
    vscode.commands.registerCommand('amxb.compileFile', (uri?: vscode.Uri) => void runCompile(deps, collection, uri)),
    vscode.commands.registerCommand('amxb.compileFileAndDeploy', (uri?: vscode.Uri) => void runCompileAndDeploy(deps, collection, uri)),
    vscode.commands.registerCommand('amxb.deployCompiledFile', () => void deployLast(deps)),
  ];
}
