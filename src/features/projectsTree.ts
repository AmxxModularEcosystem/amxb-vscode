import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Project, FeatureDeps } from '../core/types';
import {
  HeaderNode,
  DepsHeaderNode,
  buildDepsNodes,
  getDepChildren,
  getIncludeChildren,
  expandIncludeChildren,
  IncludeNode,
  CycleNode,
  ExternalIncludeNode,
  type TreeNode,
} from './depsTree';
import { getDepNodeForRepo } from './depRegistry';
import { buildSmaChildren, SmaIncludeNode, type GraphNode } from './smaGraph';
import {
  buildExternalIncludesNode,
  ExternalIncludesNode,
  ExtGroupNode,
  ExtFileNode,
  ExtNestedNode,
  DepJumpNode,
  getExtFileNode,
} from './externalIncludes';
import { getIncludeNodeForPath, getTreeParent, linkChild } from './treeLinks';

/** Activity-bar Projects tree: projects → dependencies, plugins, actions. */

class ProjectNode extends vscode.TreeItem {
  readonly kind = 'project' as const;

  constructor(readonly project: Project) {
    super(ProjectNode.labelFor(project), vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'project';
    this.iconPath = new vscode.ThemeIcon('package');
    this.description = project.isRoot ? 'root' : project.rootPath;
    this.tooltip = ProjectNode.tooltipFor(project);
  }

  private static labelFor(project: Project): string {
    return project.version ? `${project.displayName}@${project.version}` : project.displayName;
  }

  private static tooltipFor(project: Project): string {
    const lines = [project.manifestPath];
    const validation = project.validation;
    if (validation) {
      lines.push(validation.valid ? 'valid' : `${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`);
    }
    return lines.join('\n');
  }
}

class PluginsHeaderNode extends vscode.TreeItem {
  readonly kind = 'plugins' as const;

  constructor(readonly project: Project, count: number) {
    super(`Plugins (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'header';
    this.iconPath = new vscode.ThemeIcon('file-code');
  }
}

class PluginNode extends vscode.TreeItem {
  readonly kind = 'sma' as const;

  constructor(readonly project: Project, readonly filePath: string) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'sma';
    this.iconPath = new vscode.ThemeIcon('file');
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
  }
}

type ProjectsTreeNode =
  | ProjectNode
  | PluginsHeaderNode
  | PluginNode
  | TreeNode
  | GraphNode
  | ExternalIncludesNode
  | ExtGroupNode
  | ExtFileNode
  | ExtNestedNode
  | DepJumpNode;

class ProjectsProvider implements vscode.TreeDataProvider<ProjectsTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ProjectsTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: FeatureDeps) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ProjectsTreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: ProjectsTreeNode): ProjectsTreeNode | undefined {
    return getTreeParent(element) as ProjectsTreeNode | undefined;
  }

  private recordParents(element: ProjectsTreeNode | undefined, children: ProjectsTreeNode[]): void {
    if (!element) return;
    for (const child of children) linkChild(child, element);
  }

  async getChildren(element?: ProjectsTreeNode): Promise<ProjectsTreeNode[]> {
    let children: ProjectsTreeNode[];
    if (!element) {
      children = this.getRootNodes();
    } else {
      switch (element.kind) {
        case 'project':
          children = await this.getProjectChildren(element.project);
          break;
        case 'plugins':
          children = await this.getPluginChildren(element.project);
          break;
        case 'dep':
          children = await getDepChildren(element, this.deps);
          break;
        case 'inc-header':
          children = getIncludeChildren(element);
          break;
        case 'inc':
          children = await expandIncludeChildren(element);
          break;
        case 'deps-header':
          children = [...element.deps];
          break;
        case 'sma':
          children = await buildSmaChildren(element.project, element.filePath, this.deps);
          break;
        case 'graph-inc':
          children = [...element.children];
          break;
        case 'ext-header':
          if (element.groups.length === 0) children = [new HeaderNode('No external includes', 'Run a build or compile to fetch dependencies')];
          else children = [...element.groups];
          break;
        case 'ext-group':
          children = [...element.files];
          break;
        case 'ext-file':
          children = [...element.children];
          break;
        case 'ext-dep':
          children = [];
          break;
        case 'ext-inc':
          children = [];
          break;
        default:
          children = [];
          break;
      }
    }
    this.recordParents(element, children);
    return children;
  }

  private getRootNodes(): ProjectsTreeNode[] {
    const projects = this.deps.store.getProjects();
    if (projects.length === 0) {
      return [new HeaderNode('No AMX Mod X project found', 'Open a folder containing amxbuild.yml / amxbuild.yaml / manifest.yml')];
    }
    return projects.map((project) => new ProjectNode(project));
  }

  private async getProjectChildren(project: Project): Promise<ProjectsTreeNode[]> {
    const nodes: ProjectsTreeNode[] = [];
    const smas = await this.findPlugins(project);
    const pluginsHeader = new PluginsHeaderNode(project, smas.length);
    nodes.push(pluginsHeader);
    const extNode = await buildExternalIncludesNode(project, this.deps);
    nodes.push(extNode);
    for (const group of extNode.groups) {
      linkChild(group, extNode);
      for (const file of group.files) linkChild(file, group);
    }
    const depsNodes = await buildDepsNodes(project, this.deps);
    const depsHeader = new DepsHeaderNode(depsNodes);
    nodes.push(depsHeader);
    for (const dep of depsNodes) linkChild(dep, depsHeader);
    return nodes;
  }

  private async findPlugins(project: Project): Promise<string[]> {
    const pattern = new vscode.RelativePattern(project.rootPath, 'amxmodx/scripting/**/*.sma');
    const uris = await vscode.workspace.findFiles(pattern);
    return uris.map((uri) => uri.fsPath);
  }

  private async getPluginChildren(project: Project): Promise<ProjectsTreeNode[]> {
    const smas = await this.findPlugins(project);
    if (smas.length === 0) return [new HeaderNode('No plugins found', 'No .sma files under amxmodx/scripting/')];
    return smas.map((file) => new PluginNode(project, file));
  }
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  const provider = new ProjectsProvider(deps);
  const tree = vscode.window.createTreeView('amxbProjectsView', { treeDataProvider: provider, showCollapseAll: true });

  const selection = tree.onDidChangeSelection((event) => {
    const first = event.selection[0];
    if (first?.kind === 'project') deps.store.setCurrentProject(first.project);
  });

  const storeSub = deps.store.onDidChange(() => provider.refresh());
  const refreshCmd = vscode.commands.registerCommand('amxb.refreshTree', () => provider.refresh());

  const revealDep = vscode.commands.registerCommand('amxb.revealDep', (arg?: unknown) => {
    const repo = typeof arg === 'string' ? arg : (arg as { readonly repo?: unknown } | null | undefined)?.repo;
    if (typeof repo !== 'string') return;
    const node = getDepNodeForRepo(repo);
    if (node) void tree.reveal(node, { select: true, focus: true });
  });
  const revealInclude = vscode.commands.registerCommand('amxb.revealInclude', (arg?: unknown) => {
    let target: ProjectsTreeNode | undefined;
    if (arg instanceof SmaIncludeNode || arg instanceof IncludeNode) target = arg;
    else if (arg instanceof CycleNode && (arg.target instanceof IncludeNode || arg.target instanceof SmaIncludeNode)) {
      target = arg.target;
    }
    if (target) void tree.reveal(target, { select: true, focus: true });
  });
  const revealExtFile = vscode.commands.registerCommand('amxb.revealExtFile', (arg?: unknown) => {
    let target: ExtFileNode | undefined;
    if (arg instanceof ExtFileNode) target = arg;
    else if (arg instanceof ExtNestedNode) target = arg.revealTarget;
    else if (arg instanceof ExternalIncludeNode) target = getExtFileNode(arg.absPath);
    if (target) void tree.reveal(target, { select: true, focus: true });
  });
  const revealIncludeFile = vscode.commands.registerCommand('amxb.revealIncludeFile', (arg?: unknown) => {
    const absPath = typeof arg === 'string' ? arg : (arg as { readonly absPath?: unknown } | null | undefined)?.absPath;
    if (typeof absPath !== 'string') return;
    const target = getIncludeNodeForPath(absPath) ?? getExtFileNode(absPath);
    if (target) void tree.reveal(target, { select: true, focus: true });
  });

  return [tree, selection, storeSub, refreshCmd, revealDep, revealInclude, revealExtFile, revealIncludeFile];
}
