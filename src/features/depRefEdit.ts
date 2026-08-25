import * as vscode from 'vscode';
import type { DepNode } from './depsTree';
import type { FeatureDeps } from '../core/types';

/** Minimal in-place editing of a manifest's dependency refs (no YAML parser). */

function findTopLevelKey(lines: readonly string[], key: string): number {
  return lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
}

function indentOf(line: string): number {
  const m = /^\s*/.exec(line);
  return m?.[0]?.length ?? 0;
}

function replaceRefValue(line: string, ref: string): string {
  const m = /^(\s*ref:)(\s*)(["']?)(.*)$/.exec(line);
  if (!m) return line;
  const prefix = m[1] ?? '';
  const ws = m[2] ?? '';
  const quote = m[3] ?? '';
  const rest = m[4] ?? '';
  const closing = quote.length > 0 ? quote : '';
  const value = closing ? (rest.split(quote)[0] ?? '') : (rest.split(/\s/)[0] ?? '');
  const after = closing ? rest.slice(value.length + quote.length) : rest.slice(value.length);
  return `${prefix}${ws}${quote}${ref}${closing}${after}`;
}

function rewriteRef(text: string, repo: string, ref: string): string | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const depsStart = findTopLevelKey(lines, 'deps');
  const reposStart = findTopLevelKey(lines, 'repos');
  const blockEnd = reposStart > depsStart ? reposStart : lines.length;
  const from = depsStart >= 0 ? depsStart : 0;

  for (let i = from; i < blockEnd; i++) {
    const line = lines[i] ?? '';
    const item = /^(\s*)-\s*(.*)$/.exec(line);
    if (!item) continue;
    const itemIndent = item[1]!.length;
    const rest = item[2] ?? '';

    const object = /^repo:\s*([^\s#]+)/.exec(rest);
    if (object && object[1] === repo) {
      for (let j = i + 1; j < blockEnd; j++) {
        const child = lines[j] ?? '';
        if (/^(\s*)-\s*/.test(child) && indentOf(child) <= itemIndent) break;
        if (/^ref:/.test(child.trim()) && indentOf(child) > itemIndent) {
          lines[j] = replaceRefValue(child, ref);
          return lines.join(eol);
        }
      }
      lines.splice(i + 1, 0, `${' '.repeat(itemIndent + 2)}ref: ${ref}`);
      return lines.join(eol);
    }

    const shorthand = /^([^\s#@]+)(?:@([^\s#]+))?(\s*(?:#.*)?)$/.exec(rest);
    if (shorthand && shorthand[1] === repo) {
      const tail = (shorthand[3] ?? '').trim();
      lines[i] = `${item[1]}${repo}@${ref}${tail ? ` ${tail}` : ''}`;
      return lines.join(eol);
    }
  }
  return undefined;
}

export async function applyDepRef(deps: FeatureDeps, node: DepNode, ref: string): Promise<void> {
  const uri = vscode.Uri.file(node.project.manifestPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const original = doc.getText();
  const edited = rewriteRef(original, node.dep.repo, ref);
  if (edited === undefined) {
    void vscode.window.showWarningMessage(`AMXB: dependency entry for ${node.dep.repo} not found in the manifest`);
    return;
  }
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, fullRange, edited);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
  void vscode.window.showInformationMessage(`AMXB: ${node.dep.repo} ref → ${ref}`);
  void vscode.commands.executeCommand('amxb.refreshTree');
}
