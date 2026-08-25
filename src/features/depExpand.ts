import type { DepTreeNode, IncludeListResult } from '../serve/protocol';
import type { FeatureDeps, Project } from '../core/types';
import { depsTree, includeList } from '../serve/methods';
import { findManifestUp } from '../util/manifestSearch';
import { registerDepNode } from './depRegistry';
import { linkChild } from './treeLinks';
import { buildNestContext } from './includeNesting';
import {
  DepNode,
  DepsHeaderNode,
  IncludeHeaderNode,
  HeaderNode,
  ErrorNode,
  errMsg,
  getClient,
  type TreeNode,
} from './depNodes';

function depChildNode(project: Project, dep: DepTreeNode, ancestors: ReadonlySet<string>): TreeNode {
  const key = `${dep.repo}@${dep.resolvedRef ?? dep.ref}`;
  if (ancestors.has(key)) return new HeaderNode(`⇄ ${key}`, 'dependency cycle');
  const node = new DepNode(project, dep, { ancestors: new Set(ancestors).add(key) });
  registerDepNode(node);
  return node;
}

function linkChildren(header: DepsHeaderNode, parent: DepNode): void {
  linkChild(header, parent);
  for (const child of header.deps) linkChild(child, header);
}

async function discoverDepManifest(node: DepNode, list: IncludeListResult | undefined): Promise<string | undefined> {
  if (node.manifest) return node.manifest;
  const info = list?.deps.find((d) => d.repo === node.dep.repo);
  const includeDir = info?.include_dir;
  if (!includeDir) return undefined;
  return findManifestUp(includeDir);
}

/**
 * Resolve a dep's children. `list`, when given, is the include list of the dep's
 * PARENT repo — it carries the dep's own include files + include_dir. Without it
 * (user expanded a node the warm-up could not fully resolve) the request is
 * re-issued: direct deps fall back to the project's list, everything else to the
 * dep's recorded parent list, then to its own include list as a degraded fallback.
 * Transient failures and degraded resolutions are NOT cached, so the next
 * expansion force-refetches instead of serving stale placeholders.
 */
export async function getDepChildren(node: DepNode, deps: FeatureDeps, list?: IncludeListResult): Promise<TreeNode[]> {
  if (node.children) return node.children;

  let parentList = list ?? node.parentList;
  let degraded = parentList === undefined;

  const client = await getClient(deps, node.project);
  if (!client) {
    return [new ErrorNode('Unable to load include files', 'amxb serve unavailable')];
  }

  if (!parentList) {
    try {
      parentList = await includeList(client, {
        manifest: node.direct ? node.project.manifestPath : (node.manifest ?? node.project.manifestPath),
        noFetch: true,
      });
      degraded = !node.direct;
    } catch (err) {
      return [new ErrorNode('Failed to load include files', errMsg(err))];
    }
  }

  const children: TreeNode[] = [];
  const hasServerDeps = node.dep.dependencies.length > 0;
  if (hasServerDeps) {
    const header = new DepsHeaderNode(node.dep.dependencies.map((d) => depChildNode(node.project, d, node.ancestors)));
    linkChildren(header, node);
    children.push(header);
  }

  if (!hasServerDeps) {
    const depManifest = await discoverDepManifest(node, parentList);
    if (depManifest) {
      node.manifest = depManifest;
      try {
        const nested = await depsTree(client, { manifest: depManifest, noFetch: true });
        const nestedNodes = nested.dependencies.map((d) => depChildNode(node.project, d, node.ancestors));
        if (nestedNodes.length > 0) {
          // Nested deps resolve against THIS dep's own include list; record it so the
          // warm-up recursion can fully resolve them without knowing this dep later.
          let own: IncludeListResult | undefined;
          try {
            own = await includeList(client, { manifest: depManifest, noFetch: true });
          } catch (err) {
            deps.output.log(`include.list for ${node.dep.repo} failed: ${errMsg(err)}`);
          }
          for (const c of nestedNodes) if (c instanceof DepNode) c.parentList = own;
          const header = new DepsHeaderNode(nestedNodes);
          linkChildren(header, node);
          children.push(header);
        }
      } catch (err) {
        children.push(new ErrorNode('Failed to load nested dependencies', errMsg(err)));
      }
    } else {
      children.push(new HeaderNode('No manifest', 'legacy repo without amxbuild.yml / manifest.yml'));
    }
  }

  if (!degraded) {
    const ctx = await buildNestContext(node.project, deps, client, parentList);
    const header = new IncludeHeaderNode(node.project, node.dep.repo, parentList, ctx);
    linkChild(header, node);
    children.push(header);
    node.parentList = parentList;
    node.children = children;
  }
  return children;
}

export async function warmUpDepTree(depNodes: readonly TreeNode[], deps: FeatureDeps, list?: IncludeListResult): Promise<void> {
  for (const node of depNodes) {
    if (!(node instanceof DepNode)) continue;
    const children = await getDepChildren(node, deps, list);
    const nested = children.find((c): c is DepsHeaderNode => c.kind === 'deps-header');
    if (nested) await warmUpDepTree(nested.deps, deps);
  }
}
