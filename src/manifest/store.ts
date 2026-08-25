import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Project, ProjectStore, ProjectStoreFactoryOptions } from '../core/types';
import { manifestResolve } from '../serve/methods';

/** Store extended with the mutations only the detector needs. */
export interface ManifestProjectStore extends ProjectStore {
  readonly addProject: (project: Project) => void;
  readonly removeProject: (project: Project) => void;
}

function sameProjectState(a: Project, b: Project): boolean {
  return (
    a.displayName === b.displayName &&
    a.version === b.version &&
    JSON.stringify(a.validation) === JSON.stringify(b.validation)
  );
}

export function createProjectStore(options: ProjectStoreFactoryOptions): ManifestProjectStore {
  const changeEmitter = new vscode.EventEmitter<void>();
  const currentEmitter = new vscode.EventEmitter<Project | undefined>();

  let projects: Project[] = [];
  const byManifest = new Map<string, Project>();
  const enrichmentGen = new Map<string, number>();
  let current: Project | undefined;

  function rootPriority(project: Project): number {
    if (!project.isRoot) return 1;
    const idx = options.workspaceFolders.findIndex((f) => f.uri.fsPath === project.rootPath);
    return idx < 0 ? 0 : idx;
  }

  function sortProjects(): void {
    projects = [...projects].sort((a, b) => {
      const pa = rootPriority(a);
      const pb = rootPriority(b);
      if (pa !== pb) return pa - pb;
      return a.rootPath.localeCompare(b.rootPath);
    });
  }

  function defaultCurrent(): Project | undefined {
    return projects.find((p) => p.isRoot) ?? projects[0];
  }

  function enrich(project: Project): void {
    const gen = (enrichmentGen.get(project.manifestPath) ?? 0) + 1;
    enrichmentGen.set(project.manifestPath, gen);

    void options
      .clientFor(project)
      .then(async (client) => {
        if (enrichmentGen.get(project.manifestPath) !== gen) return;
        try {
          const resolved = await manifestResolve(client, project.manifestPath);
          if (enrichmentGen.get(project.manifestPath) !== gen) return;
          const target = byManifest.get(project.manifestPath);
          if (!target) return;
          updateProject(target, { displayName: resolved.name, version: resolved.version });
        } catch (err) {
          if (enrichmentGen.get(project.manifestPath) === gen) {
            options.log(`manifest.resolve failed for ${project.manifestPath}: ${String(err instanceof Error ? err.message : err)}`);
          }
        }
      })
      .catch((err: unknown) => {
        if (enrichmentGen.get(project.manifestPath) === gen) {
          options.log(`serve client unavailable for ${project.manifestPath}: ${String(err instanceof Error ? err.message : err)}`);
        }
      });
  }

  function addProject(project: Project): void {
    if (byManifest.has(project.manifestPath)) return;
    byManifest.set(project.manifestPath, project);
    projects.push(project);
    sortProjects();
    if (current === undefined) {
      current = defaultCurrent();
      currentEmitter.fire(current);
    }
    changeEmitter.fire();
    enrich(project);
  }

  function removeProject(project: Project): void {
    const existing = byManifest.get(project.manifestPath);
    if (!existing) return;
    byManifest.delete(project.manifestPath);
    enrichmentGen.delete(project.manifestPath);
    projects = projects.filter((p) => p !== existing);
    if (current === existing) {
      current = defaultCurrent();
      currentEmitter.fire(current);
    }
    changeEmitter.fire();
  }

  function updateProject(project: Project, patch: Partial<Project>): void {
    const existing = byManifest.get(project.manifestPath);
    if (!existing) return;
    const next: Project = { ...existing, ...patch };
    if (sameProjectState(existing, next)) return;
    byManifest.set(project.manifestPath, next);
    const idx = projects.indexOf(existing);
    if (idx >= 0) projects[idx] = next;
    if (current === existing) current = next;
    sortProjects();
    changeEmitter.fire();
  }

  function getProjectForUri(uri: vscode.Uri): Project | undefined {
    const fsPath = uri.fsPath;
    const direct = byManifest.get(fsPath);
    if (direct) return direct;
    let best: Project | undefined;
    for (const project of projects) {
      const rel = path.relative(project.rootPath, fsPath);
      const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (inside && (best === undefined || project.rootPath.length > best.rootPath.length)) {
        best = project;
      }
    }
    return best;
  }

  return {
    onDidChange: changeEmitter.event,
    onDidChangeCurrentProject: currentEmitter.event,
    getProjects: () => [...projects],
    getRootProject: () => projects.find((p) => p.isRoot),
    getProjectForManifest: (manifestPath: string) => byManifest.get(manifestPath),
    getProjectForUri,
    getCurrentProject: () => current,
    setCurrentProject: (project: Project | undefined) => {
      if (project === current) return;
      if (project !== undefined && !byManifest.has(project.manifestPath)) return;
      current = project;
      currentEmitter.fire(project);
    },
    updateProject,
    addProject,
    removeProject,
  };
}
