import type { DepNode } from './depsTree';

const registry = new Map<string, DepNode>();

export function registerDepNode(node: DepNode): void {
  registry.set(node.dep.repo.toLowerCase(), node);
}

export function clearDepNodes(): void {
  registry.clear();
}

export function getDepNodeForRepo(repo: string): DepNode | undefined {
  return registry.get(repo.toLowerCase());
}
