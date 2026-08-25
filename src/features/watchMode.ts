import * as path from 'node:path';
import * as vscode from 'vscode';
import { compileSingle, depGraph, deployFile, deployRemove, manifestResolve, rconSend, watchStart, watchStop } from '../serve/methods';
import { parseCompilerOutput, type ParseCompilerResult } from '../util/parseCompiler';
import type { ServeClient } from '../serve/client';
import type { FeatureDeps, Project } from '../core/types';
import type { CompileSingleResult } from '../serve/protocol';

interface WatchingState {
  readonly project: Project;
  readonly client: ServeClient;
  readonly unsubscribe: () => void;
  rconCommand: string | undefined;
  rconResolved: boolean;
}

let watching: WatchingState | null = null;
let warnedBinary = false;
const debounces = new Map<string, NodeJS.Timeout>();
const watchDiags = vscode.languages.createDiagnosticCollection('amxb-watch');
const watchDiagUris = new Map<string, string[]>();

function pickProject(deps: FeatureDeps): Project | undefined {
  return deps.store.getCurrentProject() ?? deps.store.getRootProject();
}

function isUnderRoot(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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

function deriveBuildDir(outputPath: string | null): string | undefined {
  if (!outputPath) return undefined;
  const norm = outputPath.split(path.sep).join('/');
  const marker = norm.indexOf('/amxmodx/plugins/');
  return marker >= 0 ? norm.slice(0, marker) : undefined;
}

function setWatchDiagnostics(project: Project, smaPath: string, parsed: ParseCompilerResult): void {
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const d of parsed.diagnostics) {
    if (!isUnderRoot(project.rootPath, d.file)) continue;
    const line = d.line !== null && d.line > 0 ? d.line - 1 : 0;
    const diag = new vscode.Diagnostic(new vscode.Range(line, 0, line, 0), d.message, d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    diag.code = d.code;
    const list = byUri.get(d.file);
    if (list) list.push(diag);
    else byUri.set(d.file, [diag]);
  }
  for (const uri of watchDiagUris.get(smaPath) ?? []) if (!byUri.has(uri)) watchDiags.delete(vscode.Uri.file(uri));
  for (const [uri, diags] of byUri) watchDiags.set(vscode.Uri.file(uri), diags);
  watchDiagUris.set(smaPath, [...byUri.keys()]);
}

async function maybeSendRcon(deps: FeatureDeps, client: ServeClient, project: Project, amxxName: string): Promise<void> {
  const state = watching;
  if (!state) return;
  try {
    if (!state.rconResolved) {
      state.rconResolved = true;
      state.rconCommand = (await manifestResolve(client, project.manifestPath)).deploy?.rcon?.command;
    }
    const template = state.rconCommand;
    if (template === undefined || template.trim() === '') return;
    const command = template.replace(/\{plugin\}/g, amxxName.replace(/\.amxx$/i, ''));
    const resp = await rconSend(client, { command, manifest: project.manifestPath });
    deps.output.log(`RCON > ${command}: ${resp.response}`);
  } catch (err) {
    deps.output.log(`RCON step failed: ${String(err)}`);
  }
}

async function recompileAndDeploy(deps: FeatureDeps, project: Project, client: ServeClient, smaPath: string): Promise<void> {
  const result = await compileSingle(client, { sma_file: smaPath, manifest: project.manifestPath, noFetch: false }, { timeoutMs: 120_000 }).catch((err) => {
    deps.output.log(`compile.single failed (${smaPath}): ${String(err)}`);
    return null;
  });
  if (!result) return;
  const parsed = parseCompilerOutput(result.output ?? '');
  setWatchDiagnostics(project, smaPath, parsed);
  if (!result.ok || result.amxxName === null) {
    deps.output.log(`compile reported errors (${smaPath}) — not deploying`);
    return;
  }
  const buildDir = deriveBuildDir(result.output_path);
  const deployed = await deployFile(client, { relPath: `plugins/${result.amxxName}`, section: 'amxmodx', manifest: project.manifestPath, ...(buildDir !== undefined ? { buildDir } : {}) }).catch((err) => {
    deps.output.log(`deploy.file failed (${smaPath}): ${String(err)}`);
    return null;
  });
  if (!deployed) return;
  deps.output.log(`Deployed plugins/${result.amxxName}${deployed.dest !== null ? ` → ${deployed.dest}` : ''}`);
  await maybeSendRcon(deps, client, project, result.amxxName);
}

async function findFirstSma(root: string): Promise<string | undefined> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
    const file = entries.find(([name, type]) => type === vscode.FileType.File && /\.sma$/i.test(name));
    if (file) return path.join(root, file[0] ?? '');
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory || name === 'node_modules' || name.startsWith('.')) continue;
      const found = await findFirstSma(path.join(root, name));
      if (found) return found;
    }
  } catch {
    /* unreadable directory */
  }
  return undefined;
}

async function recompileDepending(deps: FeatureDeps, project: Project, client: ServeClient, incPath: string): Promise<void> {
  const firstSma = await findFirstSma(project.rootPath);
  if (!firstSma) {
    deps.output.log(`No .sma under ${project.rootPath} to build the reverse include graph`);
    return;
  }
  try {
    const smas = (await depGraph(client, { sma_file: firstSma, manifest: project.manifestPath, inc: incPath, noFetch: true })).smas_depending_on ?? [];
    if (smas.length === 0) {
      deps.output.log(`No .sma depends on ${incPath}`);
      return;
    }
    for (const sma of new Set(smas)) scheduleCompile(deps, project, client, sma);
  } catch (err) {
    deps.output.log(`dep-graph.get reverse lookup failed: ${String(err)}`);
  }
}

function scheduleCompile(deps: FeatureDeps, project: Project, client: ServeClient, smaPath: string): void {
  const ms = vscode.workspace.getConfiguration('amxb').get<number>('watch.debounceMs', 1000);
  const prev = debounces.get(smaPath);
  if (prev) clearTimeout(prev);
  debounces.set(smaPath, setTimeout(() => {
    debounces.delete(smaPath);
    void recompileAndDeploy(deps, project, client, smaPath).catch((err) => {
      deps.output.log(`recompile loop error (${smaPath}): ${String(err)}`);
    });
  }, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function deployPath(deps: FeatureDeps, client: ServeClient, project: Project, rel: string, section: string | undefined, remove: boolean): Promise<void> {
  const sectionTyped: 'amxmodx' | 'assets' = section === 'assets' ? 'assets' : 'amxmodx';
  const result = remove
    ? await deployRemove(client, { relPath: rel, section: sectionTyped, manifest: project.manifestPath }).catch((err) => { deps.output.log(`deploy.remove failed (${rel}): ${String(err)}`); return null; })
    : await deployFile(client, { relPath: rel, section: sectionTyped, manifest: project.manifestPath }).catch((err) => { deps.output.log(`deploy.file failed (${rel}): ${String(err)}`); return null; });
  if (result) deps.output.log(`${remove ? 'Removed' : 'Deployed'} ${rel}${result.dest !== null ? ` → ${result.dest}` : ''}`);
}

async function handleWatchEvent(deps: FeatureDeps, project: Project, client: ServeClient, params: unknown): Promise<void> {
  try {
    if (!isRecord(params)) return;
    const kind = params.kind;
    const eventPath = typeof params.path === 'string' ? params.path : undefined;
    const rel = typeof params.rel === 'string' ? params.rel : undefined;
    const section = typeof params.section === 'string' ? params.section : undefined;
    const autoRecompile = vscode.workspace.getConfiguration('amxb').get<boolean>('watch.autoRecompile', true);
    if (kind === 'manifest') {
      deps.output.log('Watch: manifest changed');
      void vscode.window.showInformationMessage('Manifest changed — validation will refresh');
      return;
    }
    if (kind === 'sma' || kind === 'inc') {
      if (eventPath === undefined) return;
      deps.output.log(`Watch: ${kind} changed ${eventPath}`);
      if (autoRecompile) {
        if (kind === 'sma') scheduleCompile(deps, project, client, eventPath);
        else await recompileDepending(deps, project, client, eventPath);
      }
      return;
    }
    if (rel === undefined) return;
    if (kind === 'file' || kind === 'delete') {
      deps.output.log(`Watch: ${kind} ${rel} (${section ?? 'assets'})`);
      if (kind === 'delete') await deployPath(deps, client, project, rel, section, true);
      else if (autoRecompile && !(section === 'amxmodx' && /\.(?:sma|inc)$/i.test(rel))) await deployPath(deps, client, project, rel, section, false);
      return;
    }
    deps.output.log(`Watch: unknown event kind ${String(kind)}`);
  } catch (err) {
    deps.output.log(`watch.changed handling failed: ${String(err)}`);
  }
}

async function startWatch(deps: FeatureDeps): Promise<void> {
  if (watching) { void vscode.window.showInformationMessage('Watch is already running.'); return; }
  const project = pickProject(deps);
  if (!project) { void vscode.window.showWarningMessage('No AMXB project selected.'); return; }
  const client = await getClient(deps, project);
  if (!client) return;
  const unsubscribe = client.onNotify((method, params) => {
    if (method === 'watch.changed') void handleWatchEvent(deps, project, client, params);
  });
  try {
    const start = await watchStart(client, project.manifestPath);
    if (start.ok) {
      watching = { project, client, unsubscribe, rconCommand: undefined, rconResolved: false };
      deps.setBuildState({ kind: 'watching', projectName: project.displayName });
      deps.output.log(`Watch started (${project.displayName})`);
      return;
    }
    unsubscribe();
    if (start.error?.toLowerCase().includes('already running')) {
      void vscode.window.showInformationMessage('Watch is already running on the serve server.');
    } else {
      void vscode.window.showWarningMessage(`Failed to start watch: ${start.error ?? 'unknown error'}`);
    }
  } catch (err) {
    unsubscribe();
    deps.output.log(`watch.start failed: ${String(err)}`);
    void vscode.window.showWarningMessage(`Failed to start watch: ${String(err)}`);
  }
}

async function stopWatch(deps: FeatureDeps): Promise<void> {
  const state = watching;
  if (!state) return;
  watching = null;
  state.unsubscribe();
  for (const timer of debounces.values()) clearTimeout(timer);
  debounces.clear();
  try { await watchStop(state.client); } catch (err) { deps.output.log(`watch.stop failed: ${String(err)}`); }
  deps.setBuildState({ kind: 'idle' });
  deps.output.log(`Watch stopped (${state.project.displayName})`);
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const toggle = vscode.commands.registerCommand('amxb.toggleWatch', () => {
    if (watching) void stopWatch(deps);
    else void startWatch(deps);
  });
  const start = vscode.commands.registerCommand('amxb.startWatch', () => { void startWatch(deps); });
  const stop = vscode.commands.registerCommand('amxb.stopWatch', () => { void stopWatch(deps); });
  return [toggle, start, stop, new vscode.Disposable(() => { void stopWatch(deps); watchDiags.dispose(); })];
}
