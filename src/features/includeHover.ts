import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { includeResolve } from '../serve/methods';
import type { IncludeResolveResult } from '../serve/protocol';
import { projectIncludeDirs, resolveIncludeLocal } from '../util/includeResolve';
import type { ServeClient } from '../serve/client';

const RESOLVE_TIMEOUT_MS = 8_000;
const TIMEOUT_MESSAGE = 'resolution timed out';
const INCLUDE_RE = /#include\s*([<"])([^>"]+)([>"])/;

let warnedBinary = false;

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function toHover(result: IncludeResolveResult): vscode.Hover {
  const absPath = result.absPath;
  if (result.found && absPath !== undefined) {
    const md = new vscode.MarkdownString(
      `**Resolved:** \`${absPath}\`\n\n*Source:* ${result.source ?? 'unknown'}\n\n[Open file](command:amxb.openFile?${encodeURIComponent(JSON.stringify([absPath]))})`,
    );
    md.isTrusted = true;
    return new vscode.Hover(md);
  }

  const lines = [`**Not found:** \`${result.filename}\``];
  const searched = result.searched;
  if (searched !== undefined && searched.length > 0) {
    lines.push('', 'Searched:');
    for (const label of searched) lines.push(`- ${label}`);
  }
  const errors = result.errors;
  if (errors !== undefined && errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of errors) lines.push(`- *${error}*`);
  }
  return new vscode.Hover(new vscode.MarkdownString(lines.join('\n')));
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const provider: vscode.HoverProvider = {
    async provideHover(document, position, token): Promise<vscode.Hover | undefined> {
      if (token.isCancellationRequested) return undefined;

      const text = document.lineAt(position.line).text;
      const match = INCLUDE_RE.exec(text);
      if (!match) return undefined;
      const open = match[1];
      const name = match[2];
      const close = match[3];
      const matched = match[0];
      if (open === undefined || name === undefined || close === undefined || matched === undefined) {
        return undefined;
      }
      if ((open === '<') !== (close === '>')) return undefined;

      const startCol = match.index;
      const endCol = startCol + matched.length;
      if (position.character < startCol || position.character > endCol) return undefined;

      const project = deps.store.getProjectForUri(document.uri);
      if (!project) return undefined;

      const client = await getClient(deps, project);
      if (!client) return undefined;

      let result: IncludeResolveResult;
      try {
        result = await withTimeout(
          includeResolve(client, {
            directive: name,
            manifest: project.manifestPath,
            sma_file: document.uri.fsPath,
            noFetch: true,
          }),
          RESOLVE_TIMEOUT_MS,
        );
      } catch (err) {
        if (token.isCancellationRequested) return undefined;
        deps.output.log(`include.resolve failed (${name}): ${String(err)}`);
        const message =
          err instanceof Error && err.message === TIMEOUT_MESSAGE
            ? `_${TIMEOUT_MESSAGE} for \`${name}\`_`
            : `_could not resolve \`${name}\`_`;
        return new vscode.Hover(new vscode.MarkdownString(message));
      }

      if (token.isCancellationRequested) return undefined;

      const local = resolveIncludeLocal(name, open === '<', [
        ...projectIncludeDirs(project.rootPath),
        path.dirname(document.uri.fsPath),
      ]);
      if (local) {
        const md = new vscode.MarkdownString(
          `**Resolved locally:** \`${local}\`\n\n*Source:* project (amxb include.resolve missed it)\n\n[Open file](command:amxb.openFile?${encodeURIComponent(JSON.stringify([local]))})`,
        );
        md.isTrusted = true;
        return new vscode.Hover(md);
      }

      return toHover(result);
    },
  };

  const hover = vscode.languages.registerHoverProvider(
    [
      { scheme: 'file', pattern: '**/*.sma' },
      { scheme: 'file', pattern: '**/*.inc' },
    ],
    provider,
  );

  const openFile = vscode.commands.registerCommand('amxb.openFile', async (arg: unknown) => {
    if (typeof arg !== 'string') return;
    try {
      const doc = await vscode.window.showTextDocument(vscode.Uri.file(arg));
      void doc;
    } catch {
      void vscode.window.showWarningMessage(`Could not open file: ${arg}`);
    }
  });

  return [hover, openFile];
}
