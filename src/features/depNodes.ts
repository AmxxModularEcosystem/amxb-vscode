import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DepTreeNode, IncludeListResult } from '../serve/protocol';
import type { ServeClient } from '../serve/client';
import type { FeatureDeps, Project } from '../core/types';
import { parseIncludes, type ParsedInclude } from '../util/includeResolve';
import { linkChild, registerIncludeNode } from './treeLinks';

export interface DepNodeOptions {
  /** Manifest path of this dep's own repository (discovered lazily). */
  readonly manifest?: string;
  /** Repo keys already present in the current expansion chain (cycle guard). */
  readonly ancestors?: ReadonlySet<string>;
  /** True when this dep is declared directly in the project's manifest. */
  readonly direct?: boolean;
}

export class DepNode extends vscode.TreeItem {
  readonly kind = 'dep' as const;
  readonly ancestors: ReadonlySet<string>;
  readonly direct: boolean;
  manifest: string | undefined;
  /** Include list of the PARENT repo (carries this dep's own files + include_dir). */
  parentList: IncludeListResult | undefined = undefined;
  children: TreeNode[] | undefined = undefined;

  constructor(readonly project: Project, readonly dep: DepTreeNode, opts: DepNodeOptions = {}) {
    const resolved = dep.resolvedRef ?? dep.ref;
    const badges = [
      dep.cycle ? '⚠ cycle' : '',
      dep.shared ? '⇄ shared' : '',
      dep.error ? '⚠ error' : '',
    ].filter(Boolean).join(' ');
    super(`${dep.repo}@${resolved}${badges ? ` ${badges}` : ''}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'dep';
    this.iconPath = new vscode.ThemeIcon('repo');
    if (dep.source === 'release') this.description = 'release';
    this.ancestors = opts.ancestors ?? new Set();
    this.direct = opts.direct ?? false;
    this.manifest = opts.manifest;
    const lines = [
      `repo: ${dep.repo}`,
      `ref: ${dep.ref}`,
      `resolved: ${dep.resolvedRef ?? '(unresolved — run a build to fetch)'}`,
      `source: ${dep.source ?? 'git'}`,
      `include_path: ${dep.include_path ?? '(none)'}`,
      `from: ${dep.from}`,
    ];
    if (dep.error) lines.push(`error: ${dep.error}`);
    if (dep.cycle) lines.push('⚠ cycle');
    if (dep.shared) lines.push('⇄ shared');
    this.tooltip = lines.join('\n');
  }
}

/** Search context for nested include resolution (project + dep dirs + stdlib). */
export interface NestContext {
  readonly rootPath: string;
  readonly dirs: readonly string[];
  readonly stdlibDir: string | undefined;
  readonly repoByDir: ReadonlyArray<readonly [string, string]>;
}

export function parseIncludeRefs(absPath: string): ReadonlyArray<ParsedInclude> | undefined {
  try {
    return parseIncludes(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
}

export class IncludeHeaderNode extends vscode.TreeItem {
  readonly kind = 'inc-header' as const;
  readonly nodes: readonly TreeNode[];

  constructor(
    readonly project: Project,
    readonly repo: string,
    readonly list: IncludeListResult | undefined,
    readonly ctx: NestContext,
  ) {
    const info = list?.deps.find((d) => d.repo === repo);
    const count = info?.count ?? 0;
    super(`Include files (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'header';
    this.iconPath = new vscode.ThemeIcon('file-code');
    if (info?.error) {
      this.description = '⚠';
      this.tooltip = info.error;
    }
    const homeDir = info?.include_dir ?? path.join(project.rootPath, 'amxmodx', 'scripting', 'include');
    const nodes = (info?.files ?? []).map((f) => {
      const node = new IncludeNode(f.abs, f.rel, parseIncludeRefs(f.abs), ctx, homeDir);
      registerIncludeNode(node);
      linkChild(node, this);
      return node;
    });
    this.nodes = nodes;
  }
}

export class IncludeNode extends vscode.TreeItem {
  readonly kind = 'inc' as const;
  /** #include directives of this file, parsed once at construction. */
  readonly refs: ReadonlyArray<ParsedInclude> | undefined;
  readonly ctx: NestContext;
  /** Include dir of the owning dep (labels for nested files). */
  readonly homeDir: string;
  /** Abs paths of all ancestors in the current expansion chain (cycle guard). */
  readonly chain: ReadonlySet<string>;
  children: TreeNode[] | undefined = undefined;

  constructor(
    readonly absPath: string,
    rel: string,
    refs: ReadonlyArray<ParsedInclude> | undefined,
    ctx: NestContext,
    homeDir: string,
    chain: ReadonlySet<string> = new Set(),
    nested = false,
  ) {
    super(
      rel.replace(/\.inc$/i, ''),
      refs !== undefined && refs.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = nested ? 'inc-nested' : 'inc';
    this.tooltip = absPath;
    this.description = path.basename(path.dirname(absPath));
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(absPath)] };
    this.refs = refs;
    this.ctx = ctx;
    this.homeDir = homeDir;
    this.chain = chain;
  }
}

export class ExternalIncludeNode extends vscode.TreeItem {
  readonly kind = 'ext-inc' as const;

  constructor(readonly absPath: string, readonly repo: string | undefined, readonly source = repo ?? 'external') {
    super(path.basename(absPath).replace(/\.inc$/i, ''), vscode.TreeItemCollapsibleState.None);
    this.contextValue = repo ? 'ext-inc' : 'ext-inc-std';
    this.tooltip = absPath;
    this.description = source;
    this.iconPath = new vscode.ThemeIcon('cloud');
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(absPath)] };
  }
}

export class CycleNode extends vscode.TreeItem {
  readonly kind = 'header' as const;

  constructor(readonly target: vscode.TreeItem, readonly absPath: string) {
    const label = typeof target.label === 'string' ? target.label : String(target.label?.label ?? 'include');
    super(`⇄ ${label}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'cycle';
    this.iconPath = new vscode.ThemeIcon('sync-ignored');
    this.tooltip = 'Include cycle — click to reveal the original node';
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(absPath)] };
  }
}

export class HeaderNode extends vscode.TreeItem {
  readonly kind = 'header' as const;

  constructor(label: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'header';
    if (tooltip !== undefined) this.tooltip = tooltip;
  }
}

export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;

  constructor(message: string, detail?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'header';
    this.iconPath = new vscode.ThemeIcon('error');
    if (detail !== undefined) this.tooltip = detail;
  }
}

export class DepsHeaderNode extends vscode.TreeItem {
  readonly kind = 'deps-header' as const;

  constructor(readonly deps: readonly TreeNode[]) {
    super(`Dependencies (${deps.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'header';
    this.iconPath = new vscode.ThemeIcon('hub');
  }
}

export type TreeNode =
  | DepNode
  | IncludeHeaderNode
  | IncludeNode
  | ExternalIncludeNode
  | CycleNode
  | HeaderNode
  | ErrorNode
  | DepsHeaderNode;

let binaryWarned = false;

export async function getClient(deps: FeatureDeps, project: Project): Promise<ServeClient | undefined> {
  try {
    return await deps.clientFor(project);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.output.log(`amxb client unavailable for ${project.manifestPath}: ${message}`);
    if (!binaryWarned) {
      binaryWarned = true;
      void vscode.window.showWarningMessage(`AMXB: ${message}`);
    }
    return undefined;
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getIncludeChildren(node: IncludeHeaderNode): TreeNode[] {
  return [...node.nodes];
}
