import * as path from 'node:path';
import type { FeatureDeps, Project } from '../core/types';
import { amxmodxIncludesList } from '../serve/methods';
import type { IncludeListResult } from '../serve/protocol';
import type { ServeClient } from '../serve/client';
import { isUnderRoot, projectIncludeDirs, resolveIncludeLocal } from '../util/includeResolve';
import {
  CycleNode,
  ErrorNode,
  ExternalIncludeNode,
  IncludeNode,
  parseIncludeRefs,
  type NestContext,
  type TreeNode,
} from './depNodes';
import { getIncludeNodeForPath, linkChild } from './treeLinks';

const contexts = new Map<string, NestContext>();

export function clearNestContexts(): void {
  contexts.clear();
}

export async function buildNestContext(
  project: Project,
  deps: FeatureDeps,
  client: ServeClient,
  list: IncludeListResult,
): Promise<NestContext> {
  const cached = contexts.get(project.rootPath);
  if (cached) return cached;
  const dirs = [...projectIncludeDirs(project.rootPath)];
  const repoByDir: Array<readonly [string, string]> = [];
  for (const dep of list.deps) {
    if (dep.error !== undefined || dep.include_dir === undefined) continue;
    dirs.push(dep.include_dir);
    repoByDir.push([dep.include_dir, dep.repo]);
  }
  let stdlibDir: string | undefined;
  try {
    const stdlib = await amxmodxIncludesList(client, { manifest: project.manifestPath, pattern: '*.inc' });
    if (stdlib.includeDir !== null) {
      stdlibDir = stdlib.includeDir;
      dirs.push(stdlibDir);
    }
  } catch (err) {
    deps.output.log(`amxmodx.includes.list failed for include nesting: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ctx = { rootPath: project.rootPath, dirs, stdlibDir, repoByDir };
  contexts.set(project.rootPath, ctx);
  return ctx;
}

function repoForFile(file: string, repoByDir: ReadonlyArray<readonly [string, string]>): string | undefined {
  for (const [dir, repo] of repoByDir) {
    if (file.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`)) return repo;
  }
  return undefined;
}

function labelFor(homeDir: string, absPath: string): string {
  const rel = path.relative(homeDir, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(absPath).replace(/\.inc$/i, '');
  return rel.replace(/\.inc$/i, '');
}

function isLocal(rootPath: string, homeDir: string, file: string): boolean {
  if (isUnderRoot(rootPath, file)) return true;
  return file === homeDir || file.startsWith(homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`);
}

/** Lazily expand an include file into its own #include closure (cached, cycle-guarded). */
export async function expandIncludeChildren(node: IncludeNode): Promise<TreeNode[]> {
  if (node.children) return node.children;
  const children: TreeNode[] = [];
  for (const inc of node.refs ?? []) {
    const dirs = inc.isAngle ? node.ctx.dirs : [path.dirname(node.absPath), ...node.ctx.dirs];
    const resolved = resolveIncludeLocal(inc.name, inc.isAngle, dirs);
    if (!resolved) {
      children.push(new ErrorNode(`Missing include: ${inc.isAngle ? '<' : '"'}${inc.name}${inc.isAngle ? '>' : '"'}`, `referenced from ${node.absPath}`));
      continue;
    }
    if (node.chain.has(resolved)) {
      children.push(new CycleNode(node, resolved));
      continue;
    }
    const chain = new Set(node.chain);
    chain.add(resolved);
    let child: TreeNode;
    if (isLocal(node.ctx.rootPath, node.homeDir, resolved)) {
      // A file with a canonical entry in a dep's include list is a terminal
      // reference: its button reveals the source, where deeper nesting is explored.
      const refs = getIncludeNodeForPath(resolved) ? undefined : parseIncludeRefs(resolved);
      child = new IncludeNode(resolved, labelFor(node.homeDir, resolved), refs, node.ctx, node.homeDir, chain, true);
    } else {
      const repo = repoForFile(resolved, node.ctx.repoByDir);
      const source = repo ?? (node.ctx.stdlibDir !== undefined && resolved.startsWith(node.ctx.stdlibDir) ? 'stdlib' : 'external');
      child = new ExternalIncludeNode(resolved, repo, source);
    }
    linkChild(child, node);
    children.push(child);
  }
  node.children = children;
  return children;
}
