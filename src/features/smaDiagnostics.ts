import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { depGraph } from '../serve/methods';
import type { DepGraphResult } from '../serve/protocol';
import { isUnderRoot, repairDepGraph } from '../util/includeResolve';
import type { ServeClient } from '../serve/client';

const DEBOUNCE_MS = 1000;

let warnedBinary = false;
const timers = new Map<string, NodeJS.Timeout>();
/** smaUri -> containing file uri -> diagnostics contributed by that sma. */
const contributions = new Map<string, Map<string, vscode.Diagnostic[]>>();
let publishedUris = new Set<string>();

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('amxb').get<boolean>('smaDiagnostics', true);
}

function isSmaFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && /\.sma$/i.test(uri.fsPath);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function buildMissingDiagnostic(
  file: string,
  name: string,
  isAngle: boolean,
): Promise<vscode.Diagnostic | undefined> {
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    text = Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }

  const open = isAngle ? '<' : '"';
  const close = isAngle ? '>' : '"';
  const re = new RegExp(`^\\s*#include\\s*\\${open}\\s*${escapeRegExp(name)}\\s*\\${close}`);
  const lines = text.split(/\r?\n/);
  const lineIdx = lines.findIndex((line) => re.test(line));
  const message = `Missing include: ${open}${name}${close}`;

  if (lineIdx >= 0) {
    const length = lines[lineIdx]?.length ?? 0;
    return new vscode.Diagnostic(
      new vscode.Range(lineIdx, 0, lineIdx, length),
      message,
      vscode.DiagnosticSeverity.Warning,
    );
  }
  const firstLength = lines[0]?.length ?? 0;
  return new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, firstLength),
    message,
    vscode.DiagnosticSeverity.Warning,
  );
}

function publish(collection: vscode.DiagnosticCollection): void {
  const aggregated = new Map<string, vscode.Diagnostic[]>();
  for (const perFile of contributions.values()) {
    for (const [uri, diags] of perFile) {
      const existing = aggregated.get(uri);
      if (existing) existing.push(...diags);
      else aggregated.set(uri, [...diags]);
    }
  }
  for (const [uri, diags] of aggregated) collection.set(vscode.Uri.file(uri), diags);
  for (const uri of publishedUris) {
    if (!aggregated.has(uri)) collection.delete(vscode.Uri.file(uri));
  }
  publishedUris = new Set(aggregated.keys());
}

async function compute(
  deps: FeatureDeps,
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
): Promise<void> {
  if (!isEnabled()) {
    collection.delete(uri);
    return;
  }
  const project = deps.store.getProjectForUri(uri);
  if (!project) return;

  const client = await getClient(deps, project);
  if (!client) return;

  let result: DepGraphResult;
  try {
    result = await depGraph(client, {
      sma_file: uri.fsPath,
      manifest: project.manifestPath,
      noFetch: true,
    });
  } catch (err) {
    // Fetch of an uncached compiler can throw; keep the previous diagnostics.
    deps.output.log(`dep-graph.get failed for ${uri.fsPath}: ${String(err)}`);
    return;
  }

  result = repairDepGraph(result, uri.fsPath, project.rootPath);

  const perFile = new Map<string, vscode.Diagnostic[]>();
  for (const missing of result.missing) {
    if (!isUnderRoot(project.rootPath, missing.file)) continue;
    const diagnostic = await buildMissingDiagnostic(missing.file, missing.name, missing.isAngle);
    if (diagnostic === undefined) continue;
    const existing = perFile.get(missing.file);
    if (existing) existing.push(diagnostic);
    else perFile.set(missing.file, [diagnostic]);
  }
  contributions.set(uri.fsPath, perFile);
  publish(collection);
}

function schedule(
  deps: FeatureDeps,
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
): void {
  const key = uri.fsPath;
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void compute(deps, collection, uri);
    }, DEBOUNCE_MS),
  );
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection('amxb-sma');

  const open = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (isSmaFile(doc.uri)) schedule(deps, collection, doc.uri);
  });
  const save = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (isSmaFile(doc.uri)) schedule(deps, collection, doc.uri);
  });
  const close = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (!isSmaFile(doc.uri)) return;
    const key = doc.uri.fsPath;
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    contributions.delete(key);
    publish(collection);
  });
  const storeChange = deps.store.onDidChange(() => {
    for (const doc of vscode.workspace.textDocuments) {
      if (isSmaFile(doc.uri)) schedule(deps, collection, doc.uri);
    }
  });
  const configChange = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('amxb.smaDiagnostics')) return;
    if (!isEnabled()) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      contributions.clear();
      publishedUris = new Set();
      collection.clear();
      return;
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (isSmaFile(doc.uri)) schedule(deps, collection, doc.uri);
    }
  });

  for (const doc of vscode.workspace.textDocuments) {
    if (isSmaFile(doc.uri)) schedule(deps, collection, doc.uri);
  }

  const dispose = new vscode.Disposable(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    collection.dispose();
  });

  return [open, save, close, storeChange, configChange, dispose];
}
