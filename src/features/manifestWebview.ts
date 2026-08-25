import * as vscode from 'vscode';
import { manifestResolve } from '../serve/methods';
import type { ResolvedManifest } from '../serve/protocol';
import type { FeatureDeps, Project } from '../core/types';

/** Resolved-manifest overview webview (manifest.resolve). */

const panels = new Map<string, vscode.WebviewPanel>();
const lastResolvedJson = new Map<string, string>();
const ALLOWED_ACTIONS = new Set(['amxb.build', 'amxb.showBuildPlan', 'amxb.validateManifest', 'amxb.deploy']);

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function section(title: string, body: string): string {
  return `<details open><summary>${title}</summary>${body}</details>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="key">${esc(label)}</span><span class="val">${esc(value)}</span></div>`;
}

function jsonBlock(value: unknown): string {
  return `<pre>${esc(JSON.stringify(value, null, 2).slice(0, 2000))}</pre>`;
}

function renderBody(resolved: ResolvedManifest, project: Project): string {
  const deps = (resolved.globalDeps ?? [])
    .map((d) => row(d.repo, `${d.ref} (${d.source})`))
    .join('');
  const plugins = (resolved.plugins ?? [])
    .map((p) => row(p.match, `enabled: ${p.enabled !== false}`))
    .join('');
  const defines = (resolved.amxmodx.defines ?? []).join(', ') || '—';
  const deploy = resolved.deploy;
  const rcon = deploy?.rcon;
  const output = resolved.output;

  const validation = project.validation
    ? project.validation.valid
      ? 'valid'
      : `${project.validation.errors.length} error(s)`
    : 'not validated';

  return `
  <p class="meta">${esc(project.manifestPath)} · ${esc(validation)}</p>
  <div class="actions">
    <button onclick="send('amxb.build')">Build</button>
    <button onclick="send('amxb.showBuildPlan')">Build Plan</button>
    <button onclick="send('amxb.validateManifest')">Validate</button>
    <button onclick="send('amxb.deploy')">Deploy</button>
    <button onclick="copy()">Copy JSON</button>
  </div>
  ${section('Project', row('name', resolved.name) + row('version', resolved.version ?? '—') + row('platform', resolved.platform ?? '—'))}
  ${section('AMX Mod X', row('version', resolved.amxmodx.version ?? 'latest') + row('dir', resolved.amxmodx.dir) + row('defines', defines))}
  ${section(`Dependencies (${(resolved.globalDeps ?? []).length})`, deps || '<p>none</p>')}
  ${section(`Plugins (${(resolved.plugins ?? []).length})`, plugins || '<p>no plugin rules</p>')}
  ${section('Output', row('archive', output?.archive_name ?? '—') + row('pack', String(output?.pack ?? true)) + row('amxmodx_path', output?.amxmodx_path ?? '—'))}
  ${section('Deploy', row('path', deploy?.path ?? '—') + row('amxmodx_path', deploy?.amxmodx_path ?? '—') + row('rcon', rcon?.host ? `${rcon.host}:${rcon.port ?? 27015}` : 'not configured'))}
  ${section('Assets (raw)', jsonBlock(resolved.assets))}
  `;
}

function pageHtml(body: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
  details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; }
  summary { cursor: pointer; font-weight: 600; }
  .row { display: flex; gap: 12px; margin: 2px 0; }
  .key { min-width: 140px; color: var(--vscode-descriptionForeground); }
  .actions { margin: 10px 0; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  pre { white-space: pre-wrap; }
</style>
</head><body>
${body}
<script>
  const vscode = acquireVsCodeApi();
  function send(id) { vscode.postMessage({ type: 'action', id }); }
  function copy() { vscode.postMessage({ type: 'copy' }); }
</script>
</body></html>`;
}

async function showOverview(deps: FeatureDeps): Promise<void> {
  const project = deps.store.getCurrentProject() ?? deps.store.getRootProject();
  if (!project) {
    void vscode.window.showInformationMessage('No AMX Mod X project found in this workspace');
    return;
  }

  let panel = panels.get(project.manifestPath);
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel('amxb.manifestOverview', `AMXB: ${project.displayName}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
    });
    panels.set(project.manifestPath, panel);
    panel.onDidDispose(() => panels.delete(project.manifestPath));
    panel.webview.onDidReceiveMessage((msg) => {
      const message = msg as { type?: unknown; id?: unknown };
      if (message.type === 'action' && typeof message.id === 'string' && ALLOWED_ACTIONS.has(message.id)) {
        void vscode.commands.executeCommand(message.id);
      } else if (message.type === 'copy') {
        const json = lastResolvedJson.get(project.manifestPath) ?? '{}';
        void vscode.env.clipboard.writeText(json).then(() => void vscode.window.showInformationMessage('Manifest JSON copied'));
      }
    });
  }

  try {
    const client = await deps.clientFor(project);
    const resolved = await manifestResolve(client, project.manifestPath);
    lastResolvedJson.set(project.manifestPath, JSON.stringify(resolved, null, 2));
    panel.webview.html = pageHtml(renderBody(resolved, project));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.webview.html = pageHtml(`<p class="meta">Failed to resolve manifest</p><pre>${esc(message)}</pre>`);
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('amxb.showManifestOverview', () => void showOverview(deps)),
  ];
}
