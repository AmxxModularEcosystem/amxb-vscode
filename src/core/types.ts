import * as vscode from 'vscode';
import type { ServeClient } from '../serve/client';
import type { ServeManager } from '../serve/manager';
import type { AmxbOutput } from '../util/output';
import type { BuildBus, BuildState } from './events';

/**
 * Core contracts shared by every feature module.
 *
 * Feature modules live in src/features/*.ts and MUST export a single function:
 *
 *   export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[];
 *
 * extension.ts calls register() for every feature. Feature modules MUST NOT touch
 * extension.ts, package.json, src/core, src/serve, src/util or src/manifest.
 */

/** A detected AMX Mod X build project (one per manifest file). */
export interface Project {
  /** Absolute path of the project directory (the manifest's directory). */
  readonly rootPath: string;
  /** Absolute path of the manifest file. */
  readonly manifestPath: string;
  /** Manifest file basename: amxbuild.yml | amxbuild.yaml | manifest.yml. */
  readonly manifestFile: string;
  /** The workspace folder this project belongs to (undefined for folders outside the workspace). */
  readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  /** True when the manifest sits at the workspace root (the common case). */
  readonly isRoot: boolean;
  /** Display name: manifest `name` when resolved, else the directory basename. */
  displayName: string;
  /** Manifest `version` once resolved. */
  version: string | undefined;
  /** Last manifest.validate result (undefined until first validation). */
  validation: { valid: boolean; errors: ReadonlyArray<ValidateIssue>; warnings: ReadonlyArray<ValidateIssue> } | undefined;
}

/** A single manifest.validate issue ({ path, message } from the serve server). */
export interface ValidateIssue {
  readonly path: string;
  readonly message: string;
}

/** Registry of all detected projects and the user's current selection. */
export interface ProjectStore {
  /** Fires when the project list or any project metadata changes. */
  readonly onDidChange: vscode.Event<void>;
  /** Fires when the current project changes. */
  readonly onDidChangeCurrentProject: vscode.Event<Project | undefined>;
  readonly getProjects: () => readonly Project[];
  /** The root project of the first workspace folder (primary case), if any. */
  readonly getRootProject: () => Project | undefined;
  readonly getProjectForManifest: (manifestPath: string) => Project | undefined;
  readonly getProjectForUri: (uri: vscode.Uri) => Project | undefined;
  readonly getCurrentProject: () => Project | undefined;
  readonly setCurrentProject: (project: Project | undefined) => void;
  /** Apply a partial update to a project (displayName, version, validation) and fire onDidChange. */
  readonly updateProject: (project: Project, patch: Partial<Project>) => void;
}

/** Everything a feature module may depend on. */
export interface FeatureDeps {
  readonly ctx: vscode.ExtensionContext;
  readonly store: ProjectStore;
  readonly manager: ServeManager;
  readonly output: AmxbOutput;
  readonly bus: BuildBus;
  /** Convenience: bus.setBuildState bound (drives the status bar). */
  readonly setBuildState: (state: BuildState) => void;
  /** Resolve the serve client for a project (spawns amxb serve on first use). Throws a descriptive error when the binary is missing. */
  readonly clientFor: (project: Project) => Promise<ServeClient>;
}

/** Options for the ProjectStore factory (implemented in src/manifest/store.ts). */
export interface ProjectStoreFactoryOptions {
  /** Workspace folders to discover manifests in (empty in a single-file window). */
  readonly workspaceFolders: readonly vscode.WorkspaceFolder[];
  /** Resolve a serve client for a project; used to enrich displayName/version. */
  readonly clientFor: (project: Project) => Promise<ServeClient>;
  readonly log: (message: string) => void;
}
