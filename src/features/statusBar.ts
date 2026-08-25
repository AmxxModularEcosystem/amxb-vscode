import * as vscode from 'vscode';
import type { BuildState } from '../core/events';
import type { FeatureDeps, Project } from '../core/types';

/**
 * Status bar: left = project selector, right = build/watch state indicator.
 * Both created in register(); the right item is hidden while idle.
 */

function projectLabel(project: Project): string {
  return project.version ? `${project.displayName}@${project.version}` : project.displayName;
}

function projectTooltip(project: Project): string {
  const version = project.version ?? 'unknown';
  const validation = project.validation
    ? project.validation.valid
      ? 'valid'
      : `${project.validation.errors.length} error(s), ${project.validation.warnings.length} warning(s)`
    : 'not validated yet';
  return `${project.manifestPath}\nversion: ${version}\nvalidation: ${validation}`;
}

function currentProject(deps: FeatureDeps): Project | undefined {
  return deps.store.getCurrentProject() ?? deps.store.getRootProject();
}

async function openManifest(deps: FeatureDeps): Promise<void> {
  const project = currentProject(deps) ?? deps.store.getProjects()[0];
  if (!project) {
    void vscode.window.showWarningMessage('No AMX Mod X project found in this workspace');
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(project.manifestPath));
}

async function selectProject(deps: FeatureDeps): Promise<void> {
  const projects = deps.store.getProjects();
  const current = deps.store.getCurrentProject();

  type Entry = { readonly kind: 'project'; readonly project: Project } | { readonly kind: 'manifest' };
  const entries: Entry[] = [
    ...projects.map((project) => ({ kind: 'project' as const, project })),
    { kind: 'manifest' },
  ];

  const items: vscode.QuickPickItem[] = entries.map((entry) => {
    if (entry.kind === 'manifest') {
      return { label: '$(file-code) Open Manifest...' };
    }
    const project = entry.project;
    const item: vscode.QuickPickItem = {
      label: `${project === current ? '$(check) ' : ''}${projectLabel(project)}`,
      description: project.rootPath,
    };
    if (project.isRoot) item.detail = '$(home) root';
    return item;
  });

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select an AMX Mod X project' });
  if (!picked) return;
  const entry = entries[items.indexOf(picked)];
  if (!entry) return;
  if (entry.kind === 'project') {
    deps.store.setCurrentProject(entry.project);
  } else {
    await openManifest(deps);
  }
}

function renderRight(right: vscode.StatusBarItem, state: BuildState): void {
  if (state.kind === 'idle') {
    right.hide();
    return;
  }
  if (state.kind === 'building') {
    right.text = `$(sync~spin) ${state.stage}`;
    right.tooltip = `Building ${state.projectName} — click to cancel`;
    right.command = 'amxb.cancelBuild';
  } else if (state.kind === 'watching') {
    right.text = '$(eye) Watching';
    right.tooltip = `Watching ${state.projectName}`;
    right.command = 'amxb.stopWatch';
  } else {
    right.text = '$(error) AMXB error';
    right.tooltip = state.message;
  }
  right.show();
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const left = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const right = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  const renderLeft = (): void => {
    const project = deps.store.getCurrentProject() ?? deps.store.getRootProject();
    if (!project) {
      left.hide();
      return;
    }
    left.text = `$(package) AMXB: ${projectLabel(project)}`;
    left.tooltip = projectTooltip(project);
    left.command = 'amxb.selectProject';
    left.show();
  };

  renderLeft();
  renderRight(right, deps.bus.getBuildState());

  return [
    left,
    right,
    deps.store.onDidChange(renderLeft),
    deps.store.onDidChangeCurrentProject(renderLeft),
    deps.bus.onBuildStateChange((state) => renderRight(right, state)),
    vscode.commands.registerCommand('amxb.selectProject', () => void selectProject(deps)),
    vscode.commands.registerCommand('amxb.openManifest', () => void openManifest(deps)),
  ];
}
