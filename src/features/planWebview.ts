import * as vscode from 'vscode';
import { buildPlan } from '../serve/methods';
import type { BuildPlanResult } from '../serve/protocol';
import type { FeatureDeps, Project } from '../core/types';
import { getClient, errMsg } from './depsTree';

/** build.plan webview — structured preview of what a build will produce. */

const panels = new Map<string, vscode.WebviewPanel>();
const lastJson = new Map<string, string>();

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function section(title: string, body: string): string {
  return `<details open><summary>${title}</summary>${body}</details>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="key">${esc(label)}</span><span class="val">${esc(value)}</span></div>`;
}

function renderPlan(plan: BuildPlanResult): string {
  const compiler = plan.compiler;
  const output = plan.output;
  const assets = plan.assets ?? [];

  const assetRows = assets
    .map((a) => {
      const asset = a as { type?: string; source?: string; from?: string; to?: string; repo?: string; ref?: string };
      const detail = [asset.source, asset.repo ? `${asset.repo}@${asset.ref ?? ''}` : '', asset.from ? `${asset.from} → ${asset.to ?? '.'}` : ''].filter(Boolean).join(' · ');
      return row(asset.type ?? 'asset', detail || '—');
    })
    .join('');

  return `
  <div class="actions">
    <button onclick="refresh()">Refresh</button>
    <button onclick="copy()">Copy JSON</button>
  </div>
  ${section('Project', row('name', plan.name) + row('version', plan.version ?? '—'))}
  ${section('Compiler', row('version', compiler.version) + row('dir', compiler.dir) + row('platform', compiler.platform ?? 'host') + row('defines', (compiler.defines ?? []).join(', ') || '—'))}
  ${section('Output', row('pack', String(output.pack)) + row('target', output.target ?? '—') + row('amxmodx_path', output.amxmodx_path) + row('generate_ini', String(output.generate_ini)) + row('on_conflict', output.on_conflict))}
  ${section(`Assets (${assets.length})`, assetRows || '<p>none</p>')}
  ${section('Dependencies (raw)', `<pre>${esc(JSON.stringify(plan.deps ?? [], null, 2).slice(0, 2000))}</pre>`)}
  ${section('Repos (raw)', `<pre>${esc(JSON.stringify(plan.repos ?? [], null, 2).slice(0, 2000))}</pre>`)}
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
  .actions { margin: 10px 0; display: flex; gap: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
  pre { white-space: pre-wrap; }
</style>
</head><body>
${body}
<script>
  const vscode = acquireVsCodeApi();
  function refresh() { vscode.postMessage({ type: 'refresh' }); }
  function copy() { vscode.postMessage({ type: 'copy' }); }
</script>
</body></html>`;
}

async function loadPlan(deps: FeatureDeps, project: Project): Promise<BuildPlanResult> {
  const client = await getClient(deps, project);
  if (!client) throw new Error('amxb serve unavailable');
  return buildPlan(client, { manifest: project.manifestPath, detailedAssets: true });
}

async function render(panel: vscode.WebviewPanel, deps: FeatureDeps, project: Project): Promise<void> {
  try {
    const plan = await loadPlan(deps, project);
    lastJson.set(project.manifestPath, JSON.stringify(plan, null, 2));
    panel.webview.html = pageHtml(renderPlan(plan));
  } catch (err) {
    panel.webview.html = pageHtml(`<p class="meta">Failed to load build plan</p><pre>${esc(errMsg(err))}</pre>`);
  }
}

async function showPlan(deps: FeatureDeps): Promise<void> {
  const project = deps.store.getCurrentProject() ?? deps.store.getRootProject();
  if (!project) {
    void vscode.window.showInformationMessage('No AMX Mod X project found in this workspace');
    return;
  }

  let panel = panels.get(project.manifestPath);
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel('amxb.buildPlan', `AMXB Plan: ${project.displayName}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
    });
    panels.set(project.manifestPath, panel);
    panel.onDidDispose(() => panels.delete(project.manifestPath));
    panel.webview.onDidReceiveMessage((msg) => {
      const message = msg as { type?: unknown };
      if (message.type === 'refresh') {
        void render(panel as vscode.WebviewPanel, deps, project);
      } else if (message.type === 'copy') {
        void vscode.env.clipboard.writeText(lastJson.get(project.manifestPath) ?? '{}').then(() => void vscode.window.showInformationMessage('Plan JSON copied'));
      }
    });
  }

  await render(panel, deps, project);
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('amxb.showBuildPlan', () => void showPlan(deps)),
  ];
}
