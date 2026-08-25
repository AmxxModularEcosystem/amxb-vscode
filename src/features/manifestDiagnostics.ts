import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RpcError } from '../serve/client';
import type { ServeClient } from '../serve/client';
import { manifestValidate } from '../serve/methods';
import type { ManifestValidateResult, ValidateIssue } from '../serve/protocol';
import { findLineForPointer } from '../util/yamlLine';
import { isManifestFile } from '../manifest/detector';
import type { FeatureDeps, Project } from '../core/types';

/** Maps manifest.validate issues to Problems-panel diagnostics. */

const VALIDATE_DEBOUNCE_MS = 300;
let binaryWarned = false;

function issueDiagnostic(lines: readonly string[], issue: ValidateIssue, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const text = lines.join('\n');
  const lineNo = Math.max(0, findLineForPointer(text, issue.path) - 1);
  const lineText = lines[lineNo] ?? '';
  const range = new vscode.Range(lineNo, 0, lineNo, lineText.length);
  return new vscode.Diagnostic(range, `[${issue.path}] ${issue.message}`, severity);
}

function buildDiagnostics(text: string, result: ManifestValidateResult): vscode.Diagnostic[] {
  const lines = text.split(/\r?\n/);
  const diagnostics: vscode.Diagnostic[] = [];
  for (const issue of result.errors) {
    diagnostics.push(issueDiagnostic(lines, issue, vscode.DiagnosticSeverity.Error));
  }
  for (const issue of result.warnings) {
    diagnostics.push(issueDiagnostic(lines, issue, vscode.DiagnosticSeverity.Warning));
  }
  if (result.valid) {
    diagnostics.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), 'Manifest is valid', vscode.DiagnosticSeverity.Information));
  }
  return diagnostics;
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection('amxb-manifest');
  ctx.subscriptions.push(collection);

  let debounceTimer: NodeJS.Timeout | undefined;

  async function validateProject(project: Project): Promise<void> {
    const manifestUri = vscode.Uri.file(project.manifestPath);

    let text: string;
    try {
      text = await fs.readFile(project.manifestPath, 'utf8');
    } catch {
      collection.delete(manifestUri);
      return;
    }

    let client: ServeClient;
    try {
      client = await deps.clientFor(project);
    } catch (err) {
      collection.delete(manifestUri);
      deps.output.log(`manifest.validate skipped for ${project.manifestPath}: ${String(err instanceof Error ? err.message : err)}`);
      if (!binaryWarned) {
        binaryWarned = true;
        void vscode.window.showWarningMessage(`AMXB: ${String(err instanceof Error ? err.message : err)}`);
      }
      return;
    }

    try {
      const result = await manifestValidate(client, project.manifestPath);
      collection.set(manifestUri, buildDiagnostics(text, result));
      deps.store.updateProject(project, { validation: result });
    } catch (err) {
      if (err instanceof RpcError) {
        collection.set(manifestUri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `Validation error: ${err.message}`, vscode.DiagnosticSeverity.Error)]);
      }
      deps.output.log(`manifest.validate failed for ${project.manifestPath}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  async function validateAll(): Promise<void> {
    const projects = deps.store.getProjects();

    const known = new Set(projects.map((p) => p.manifestPath));
    for (const entry of collection) {
      if (!known.has(entry[0].fsPath)) collection.delete(entry[0]);
    }

    await Promise.all(projects.map((project) => validateProject(project)));
  }

  function scheduleValidateAll(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void validateAll();
    }, VALIDATE_DEBOUNCE_MS);
  }

  const storeSub = deps.store.onDidChange(scheduleValidateAll);
  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!isManifestFile(path.basename(doc.uri.fsPath))) return;
    const project = deps.store.getProjectForManifest(doc.uri.fsPath);
    if (project) void validateProject(project);
  });

  const command = vscode.commands.registerCommand('amxb.validateManifest', () => {
    const current = deps.store.getCurrentProject();
    if (current) {
      void validateProject(current);
    } else {
      void validateAll();
    }
  });

  void validateAll();

  return [
    storeSub,
    saveSub,
    command,
    { dispose: () => { if (debounceTimer) clearTimeout(debounceTimer); } },
  ];
}
