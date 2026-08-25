import type { IncludeNode } from './depsTree';

const parents = new WeakMap<object, object>();

export function linkChild(child: object, parent: object): void {
  parents.set(child, parent);
}

export function getTreeParent(child: object): object | undefined {
  return parents.get(child);
}

const includeNodes = new Map<string, IncludeNode>();

export function registerIncludeNode(node: IncludeNode): void {
  includeNodes.set(node.absPath, node);
}

export function clearIncludeNodes(): void {
  includeNodes.clear();
}

export function getIncludeNodeForPath(absPath: string): IncludeNode | undefined {
  return includeNodes.get(absPath);
}
