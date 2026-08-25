import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureDeps, Project } from '../core/types';
import { depGraph, includeList } from '../serve/methods';
import type { DepGraphResult } from '../serve/protocol';
import { isUnderRoot, repairDepGraph } from '../util/includeResolve';
import { CycleNode, ExternalIncludeNode, ErrorNode, HeaderNode, errMsg, getClient, type TreeNode } from './depsTree';

interface GraphEntry {
  readonly includes: readonly string[];
}

interface MissingEntry {
  readonly name: string;
  readonly isAngle: boolean;
}

export class SmaIncludeNode extends vscode.TreeItem {
  readonly kind = 'graph-inc' as const;
  readonly absPath: string;
  children: GraphNode[] = [];

  constructor(absPath: string, project: Project) {
    const scripting = path.join(project.rootPath, 'amxmodx', 'scripting');
    const relScripting = path.relative(scripting, absPath);
    const inScripting = relScripting !== '' && !relScripting.startsWith('..') && !path.isAbsolute(relScripting);
    super(path.basename(absPath).replace(/\.inc$/i, ''), vscode.TreeItemCollapsibleState.None);
    this.absPath = absPath;
    this.contextValue = 'inc';
    this.tooltip = absPath;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(absPath)] };
    const dir = inScripting ? path.dirname(relScripting) : path.basename(path.dirname(absPath));
    if (dir !== '.') this.description = dir;
  }
}

export type GraphNode = TreeNode | SmaIncludeNode;

function missingLabel(missing: MissingEntry): string {
  return `Missing include: ${missing.isAngle ? '<' : '"'}${missing.name}${missing.isAngle ? '>' : '"'}`;
}

function repoForFile(file: string, includeDirRepos: ReadonlyArray<readonly [string, string]>): string | undefined {
  for (const [dir, repo] of includeDirRepos) {
    if (file.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`)) return repo;
  }
  return undefined;
}

function buildNode(
  project: Project,
  byPath: ReadonlyMap<string, GraphEntry>,
  missingByFile: ReadonlyMap<string, readonly MissingEntry[]>,
  includeDirRepos: ReadonlyArray<readonly [string, string]>,
  file: string,
  chain: ReadonlyMap<string, SmaIncludeNode>,
): GraphNode {
  const ancestor = chain.get(file);
  if (ancestor) return new CycleNode(ancestor, file);
  const entry = byPath.get(file);
  if (!entry) return new SmaIncludeNode(file, project);
  if (!isUnderRoot(project.rootPath, file)) return new ExternalIncludeNode(file, repoForFile(file, includeDirRepos));

  const next = new Map(chain);
  const node = new SmaIncludeNode(file, project);
  next.set(file, node);
  const children: GraphNode[] = [];
  for (const inc of entry.includes) children.push(buildNode(project, byPath, missingByFile, includeDirRepos, inc, next));
  for (const missing of missingByFile.get(file) ?? []) {
    children.push(new ErrorNode(missingLabel(missing), `referenced from ${file}`));
  }
  node.children = children;
  if (children.length > 0) node.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  return node;
}

export async function buildSmaChildren(project: Project, smaFile: string, deps: FeatureDeps): Promise<GraphNode[]> {
  const client = await getClient(deps, project);
  if (!client) return [new ErrorNode('Unable to load include graph', 'amxb serve unavailable')];

  let result: DepGraphResult;
  let includeDirRepos: ReadonlyArray<readonly [string, string]> = [];
  try {
    const [graph, list] = await Promise.all([
      depGraph(client, { sma_file: smaFile, manifest: project.manifestPath, noFetch: true }),
      includeList(client, { manifest: project.manifestPath, noFetch: true }),
    ]);
    result = graph;
    includeDirRepos = list.deps
      .filter((d) => d.include_dir !== undefined)
      .map((d) => [d.include_dir as string, d.repo] as const);
  } catch (err) {
    return [new ErrorNode('Failed to load include graph', errMsg(err))];
  }

  result = repairDepGraph(result, smaFile, project.rootPath);

  const byPath = new Map<string, GraphEntry>();
  for (const file of result.files) byPath.set(file.file, { includes: file.includes });

  const missingByFile = new Map<string, MissingEntry[]>();
  for (const missing of result.missing) {
    const list = missingByFile.get(missing.file);
    if (list) list.push({ name: missing.name, isAngle: missing.isAngle });
    else missingByFile.set(missing.file, [{ name: missing.name, isAngle: missing.isAngle }]);
  }

  const root = byPath.get(smaFile);
  const out: GraphNode[] = [];
  if (root) {
    const chain = new Map<string, SmaIncludeNode>();
    for (const inc of root.includes) out.push(buildNode(project, byPath, missingByFile, includeDirRepos, inc, chain));
  }
  for (const missing of missingByFile.get(smaFile) ?? []) {
    out.push(new ErrorNode(missingLabel(missing), `referenced from ${smaFile}`));
  }
  if (out.length === 0) out.push(new HeaderNode('No includes', 'This file has no #include directives'));
  return out;
}
