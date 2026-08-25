import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { amxmodxIncludesList, includeList } from '../serve/methods';
import { parseIncludes, projectIncludeDirs, resolveIncludeLocal } from '../util/includeResolve';
import { ErrorNode, errMsg, getClient, type TreeNode } from './depsTree';

interface FileSpec {
  readonly abs: string;
  readonly source: string;
  readonly repo?: string;
}

interface GroupSpec {
  readonly label: string;
  readonly repo?: string;
  readonly deps?: readonly { readonly repo: string; readonly ref: string }[];
  readonly files?: readonly FileSpec[];
}

const extFileRegistry = new Map<string, ExtFileNode>();

export function getExtFileNode(absPath: string): ExtFileNode | undefined {
  return extFileRegistry.get(absPath);
}

export class ExtNestedNode extends vscode.TreeItem {
  readonly kind = 'ext-inc' as const;

  constructor(readonly absPath: string, readonly repo: string | undefined, readonly revealTarget: ExtFileNode | undefined) {
    super(path.basename(absPath).replace(/\.inc$/i, ''), vscode.TreeItemCollapsibleState.None);
    this.contextValue = repo ? 'ext-inc' : 'ext-inc-std';
    this.tooltip = absPath;
    this.description = repo ?? 'nested';
    this.iconPath = new vscode.ThemeIcon(repo ? 'cloud' : 'file-code');
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(absPath)] };
  }
}

export class ExtFileNode extends vscode.TreeItem {
  readonly kind = 'ext-file' as const;
  children: readonly (TreeNode | ExtNestedNode)[] = [];

  constructor(
    readonly absPath: string,
    readonly source: string,
    readonly repo: string | undefined,
    readonly expandable: boolean,
  ) {
    super(
      path.basename(absPath).replace(/\.inc$/i, ''),
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = 'inc';
    this.tooltip = absPath;
    this.description = source;
    this.iconPath = new vscode.ThemeIcon(repo ? 'cloud' : 'file-code');
    if (repo) {
      this.command = { command: 'amxb.revealIncludeFile', title: 'Reveal in Dependencies', arguments: [absPath] };
    } else {
      this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(absPath)] };
    }
  }
}

export class DepJumpNode extends vscode.TreeItem {
  readonly kind = 'ext-dep' as const;

  constructor(readonly repo: string, readonly ref: string) {
    super(repo, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'ext-dep';
    this.description = ref;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.tooltip = `Reveal ${repo} in the Dependencies tree`;
    this.command = { command: 'amxb.revealDep', title: 'Reveal in Dependencies', arguments: [repo] };
  }
}

export class ExtGroupNode extends vscode.TreeItem {
  readonly kind = 'ext-group' as const;
  files: readonly (ExtFileNode | DepJumpNode)[] = [];

  constructor(readonly labelText: string, readonly repo: string | undefined) {
    super(labelText, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'ext-group';
    this.iconPath = new vscode.ThemeIcon(repo ? 'repo' : 'file-code');
    if (repo) this.command = { command: 'amxb.revealDep', title: 'Reveal in Dependencies', arguments: [repo] };
  }
}

export class ExternalIncludesNode extends vscode.TreeItem {
  readonly kind = 'ext-header' as const;

  constructor(readonly groups: readonly ExtGroupNode[]) {
    const total = groups.reduce((sum, group) => sum + group.files.length, 0);
    super(
      `External includes (${total})`,
      total > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = 'header';
    this.iconPath = new vscode.ThemeIcon('library');
    this.tooltip = 'Public include files by source (dependencies, AMXX stdlib, project)';
  }
}

function listIncFiles(dir: string): string[] {
  try {
    return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.inc$/i.test(f)).sort();
  } catch {
    return [];
  }
}

function repoForFile(file: string, repoByDir: ReadonlyArray<readonly [string, string]>): string | undefined {
  for (const [dir, repo] of repoByDir) {
    if (file.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`)) return repo;
  }
  return undefined;
}

function buildNested(
  absPath: string,
  searchDirs: readonly string[],
  repoByDir: ReadonlyArray<readonly [string, string]>,
): Array<TreeNode | ExtNestedNode> {
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const out: Array<TreeNode | ExtNestedNode> = [];
  for (const inc of parseIncludes(text)) {
    const dirs = inc.isAngle ? searchDirs : [path.dirname(absPath), ...searchDirs];
    const resolved = resolveIncludeLocal(inc.name, inc.isAngle, dirs);
    if (!resolved) {
      out.push(new ErrorNode(`Missing include: ${inc.isAngle ? '<' : '"'}${inc.name}${inc.isAngle ? '>' : '"'}`, `referenced from ${absPath}`));
      continue;
    }
    const repo = repoForFile(resolved, repoByDir);
    out.push(new ExtNestedNode(resolved, repo, extFileRegistry.get(resolved)));
  }
  return out;
}

export async function buildExternalIncludesNode(project: Project, deps: FeatureDeps): Promise<ExternalIncludesNode> {
  const client = await getClient(deps, project);
  if (!client) return new ExternalIncludesNode([]);
  extFileRegistry.clear();

  const searchDirs: string[] = [...projectIncludeDirs(project.rootPath)];
  const repoByDir: Array<readonly [string, string]> = [];
  const groupSpecs: GroupSpec[] = [];

  try {
    const list = await includeList(client, { manifest: project.manifestPath, noFetch: true });
    const deps = list.deps.map((dep) => ({ repo: dep.repo, ref: dep.ref }));
    groupSpecs.push({ label: `Dependencies (${deps.length})`, deps });
    for (const dep of list.deps) {
      if (dep.error !== undefined || dep.include_dir === undefined) continue;
      searchDirs.push(dep.include_dir);
      repoByDir.push([dep.include_dir, dep.repo]);
    }
  } catch (err) {
    deps.output.log(`include.list failed for external includes: ${errMsg(err)}`);
  }

  try {
    const stdlib = await amxmodxIncludesList(client, { manifest: project.manifestPath, pattern: '*.inc' });
    const includeDir = stdlib.includeDir;
    if (includeDir !== null && stdlib.files.length > 0) {
      searchDirs.push(includeDir);
      groupSpecs.push({
        label: `AMXX stdlib ${stdlib.version} (${stdlib.files.length})`,
        files: stdlib.files.map((file) => ({ abs: path.join(includeDir, file), source: 'stdlib' })),
      });
    }
  } catch (err) {
    deps.output.log(`amxmodx.includes.list failed for external includes: ${errMsg(err)}`);
  }

  const projectIncludeDir = path.join(project.rootPath, 'amxmodx', 'scripting', 'include');
  const projectFiles = listIncFiles(projectIncludeDir);
  if (projectFiles.length > 0) {
    groupSpecs.push({
      label: `Project (public) (${projectFiles.length})`,
      files: projectFiles.map((file) => ({ abs: path.join(projectIncludeDir, file), source: file })),
    });
  }

  const groups = groupSpecs.map((spec) => new ExtGroupNode(spec.label, spec.repo));
  groupSpecs.forEach((spec, index) => {
    const group = groups[index];
    if (!group) return;
    if (spec.deps) {
      group.files = spec.deps.map((dep) => new DepJumpNode(dep.repo, dep.ref));
      return;
    }
    const expandable = group.labelText.startsWith('AMXX stdlib');
    const fileNodes = (spec.files ?? []).map((file) => new ExtFileNode(file.abs, file.source, file.repo, expandable));
    for (const node of fileNodes) extFileRegistry.set(node.absPath, node);
    group.files = fileNodes;
  });
  groupSpecs.forEach((spec, index) => {
    for (const node of groups[index]?.files ?? []) {
      if (!(node instanceof ExtFileNode) || !node.expandable) continue;
      node.children = buildNested(node.absPath, searchDirs, repoByDir);
      if (node.children.length > 0) node.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }
  });

  return new ExternalIncludesNode(groups);
}
