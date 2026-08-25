import type { FeatureDeps, Project } from '../core/types';
import { depsTree, includeList } from '../serve/methods';
import { clearDepNodes, registerDepNode } from './depRegistry';
import { clearIncludeNodes } from './treeLinks';
import { warmUpDepTree } from './depExpand';
import { clearNestContexts } from './includeNesting';
import { DepNode, ErrorNode, errMsg, getClient, type TreeNode } from './depNodes';

export async function buildDepsNodes(project: Project, deps: FeatureDeps): Promise<TreeNode[]> {
  const client = await getClient(deps, project);
  if (!client) return [new ErrorNode('Unable to load dependencies', 'amxb serve unavailable')];
  try {
    const result = await depsTree(client, { manifest: project.manifestPath, noFetch: true });
    clearDepNodes();
    clearIncludeNodes();
    clearNestContexts();
    const nodes = result.dependencies.map((dep) => new DepNode(project, dep, { direct: true }));
    nodes.forEach(registerDepNode);
    try {
      const list = await includeList(client, { manifest: project.manifestPath, noFetch: true });
      await warmUpDepTree(nodes, deps, list);
    } catch (err) {
      deps.output.log(`dependency preload failed: ${errMsg(err)}`);
    }
    return nodes;
  } catch (err) {
    return [new ErrorNode('Failed to load dependencies', errMsg(err))];
  }
}

export { getDepChildren } from './depExpand';
export { expandIncludeChildren } from './includeNesting';
export {
  type DepNodeOptions,
  DepNode,
  IncludeHeaderNode,
  IncludeNode,
  ExternalIncludeNode,
  CycleNode,
  HeaderNode,
  ErrorNode,
  DepsHeaderNode,
  getClient,
  errMsg,
  getIncludeChildren,
  parseIncludeRefs,
  type NestContext,
  type TreeNode,
} from './depNodes';
