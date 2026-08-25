import * as vscode from 'vscode';
import * as path from 'node:path';
import type { CompilerDiagnostic } from '../util/parseCompiler';

/**
 * Shared diagnostic mapper used by build.ts and compileFile.ts.
 * Applies parsed amxxpc diagnostics to a VS Code collection, keeping only
 * diagnostics whose file lives under the project root or any workspace folder.
 */

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function inScope(
  file: string,
  projectRoot: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): boolean {
  const abs = path.resolve(file);
  if (isInside(abs, projectRoot)) return true;
  return workspaceFolders.some((folder) => isInside(abs, folder.uri.fsPath));
}

/** Map parsed diagnostics onto the collection; out-of-scope files are dropped. */
export function applyCompilerDiagnostics(
  collection: vscode.DiagnosticCollection,
  diagnostics: readonly CompilerDiagnostic[],
  projectRoot: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): void {
  const perFile = new Map<string, vscode.Diagnostic[]>();

  for (const diag of diagnostics) {
    if (!inScope(diag.file, projectRoot, workspaceFolders)) continue;
    const severity =
      diag.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const line = diag.line !== null ? Math.max(0, diag.line - 1) : 0;
    const range = new vscode.Range(line, 0, line, 1024); // whole-line squiggle
    const entry = new vscode.Diagnostic(range, diag.message, severity);
    const uriKey = vscode.Uri.file(path.resolve(diag.file)).toString();
    const existing = perFile.get(uriKey);
    if (existing) existing.push(entry);
    else perFile.set(uriKey, [entry]);
  }

  collection.clear();
  for (const [uriKey, list] of perFile) {
    collection.set(vscode.Uri.parse(uriKey), list);
  }
}
