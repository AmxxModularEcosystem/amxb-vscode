import type { ServeClient } from './client';
import type {
  AmxmodxIncludesListResult,
  BuildCancelResult,
  BuildPlanResult,
  BuildStartResult,
  CacheInfoResult,
  CompileSingleResult,
  CompilerInfoResult,
  DepsTreeResult,
  DepGraphResult,
  DeployFileResult,
  DeployStartResult,
  IncludeListResult,
  IncludeResolveResult,
  ManifestValidateResult,
  ReleaseInfo,
  ResolvedManifest,
  RconSendResult,
  ReposBranchesResult,
  ReposInfoResult,
  ReposStructureResult,
  ServePingResult,
  WatchStartResult,
  WatchStopResult,
} from './protocol';

/** Default request timeout for non-build requests. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface RequestOptions {
  /** Timeout in ms; 0 disables the timeout (use for build.start). */
  readonly timeoutMs?: number;
}

/**
 * Typed wrappers over ServeClient.request. Params are passed straight through;
 * the serve server resolves the manifest from `cwd` when omitted, but callers
 * should always pass the absolute `manifest` path.
 */

export function ping(client: ServeClient): Promise<ServePingResult> {
  return client.request<ServePingResult>('serve.ping', undefined, { timeoutMs: 5_000 });
}

export function manifestValidate(
  client: ServeClient,
  manifest: string,
): Promise<ManifestValidateResult> {
  return client.request<ManifestValidateResult>('manifest.validate', { manifest });
}

export function manifestResolve(
  client: ServeClient,
  manifest: string,
  params?: { readonly set?: readonly string[]; readonly define?: readonly string[] },
): Promise<ResolvedManifest> {
  return client.request<ResolvedManifest>('manifest.resolve', { manifest, ...params });
}

export function depsTree(
  client: ServeClient,
  params: { readonly manifest: string; readonly depth?: number; readonly noFetch?: boolean },
): Promise<DepsTreeResult> {
  return client.request<DepsTreeResult>('deps.tree', params);
}

export function includeResolve(
  client: ServeClient,
  params: {
    readonly directive: string;
    readonly manifest: string;
    readonly sma_file?: string;
    readonly noFetch?: boolean;
  },
): Promise<IncludeResolveResult> {
  return client.request<IncludeResolveResult>('include.resolve', params);
}

export function includeList(
  client: ServeClient,
  params: { readonly manifest: string; readonly noFetch?: boolean },
): Promise<IncludeListResult> {
  return client.request<IncludeListResult>('include.list', params);
}

export function amxmodxIncludesList(
  client: ServeClient,
  params: { readonly manifest: string; readonly pattern?: string },
): Promise<AmxmodxIncludesListResult> {
  return client.request<AmxmodxIncludesListResult>('amxmodx.includes.list', params);
}

export function depGraph(
  client: ServeClient,
  params: {
    readonly sma_file: string;
    readonly manifest?: string;
    readonly noFetch?: boolean;
    readonly inc?: string;
  },
): Promise<DepGraphResult> {
  return client.request<DepGraphResult>('dep-graph.get', params);
}

export function releasesList(
  client: ServeClient,
  params: {
    readonly repo: string;
    readonly tags?: boolean;
    readonly limit?: number;
    readonly includeAssets?: boolean;
    readonly manifest?: string;
    readonly token?: string;
  },
): Promise<readonly ReleaseInfo[]> {
  return client.request<readonly ReleaseInfo[]>('releases.list', params);
}

export function reposInfo(
  client: ServeClient,
  params: { readonly repo: string; readonly manifest?: string; readonly token?: string },
): Promise<ReposInfoResult> {
  return client.request<ReposInfoResult>('repos.info', params);
}

export function reposBranches(
  client: ServeClient,
  params: {
    readonly repo: string;
    readonly manifest?: string;
    readonly token?: string;
    readonly limit?: number;
    readonly page?: number;
  },
): Promise<ReposBranchesResult> {
  return client.request<ReposBranchesResult>('repos.branches', params);
}

export function reposStructure(
  client: ServeClient,
  params: {
    readonly repo: string;
    readonly ref?: string;
    readonly manifest?: string;
    readonly token?: string;
    readonly depth?: number;
    readonly dirsOnly?: boolean;
    readonly ext?: ReadonlyArray<string>;
    readonly maxEntries?: number;
  },
): Promise<ReposStructureResult> {
  return client.request<ReposStructureResult>('repos.structure', params);
}

export function cacheInfo(client: ServeClient, manifest?: string): Promise<CacheInfoResult> {
  return client.request<CacheInfoResult>('cache.info', manifest ? { manifest } : undefined);
}

export function compilerInfo(
  client: ServeClient,
  params: { readonly manifest: string; readonly noFetch?: boolean },
): Promise<CompilerInfoResult> {
  return client.request<CompilerInfoResult>('compiler.info', params);
}

export function buildPlan(
  client: ServeClient,
  params: {
    readonly manifest: string;
    readonly set?: readonly string[];
    readonly define?: readonly string[];
    readonly detailedAssets?: boolean;
    readonly listLocal?: boolean;
  },
): Promise<BuildPlanResult> {
  return client.request<BuildPlanResult>('build.plan', params);
}

export function buildStart(
  client: ServeClient,
  params: {
    readonly manifest: string;
    readonly set?: readonly string[];
    readonly define?: readonly string[];
    readonly buildDir?: string;
    readonly fetch?: boolean;
    readonly archive?: boolean;
  },
): Promise<BuildStartResult> {
  // build.start answers only when the build finishes — no client-side timeout.
  return client.request<BuildStartResult>('build.start', params, { timeoutMs: 0 });
}

export function buildCancel(client: ServeClient): Promise<BuildCancelResult> {
  return client.request<BuildCancelResult>('build.cancel', undefined, { timeoutMs: 10_000 });
}

export function compileSingle(
  client: ServeClient,
  params: {
    readonly sma_file: string;
    readonly manifest?: string;
    readonly include_dirs?: readonly string[];
    readonly scripting_root?: string;
    readonly noFetch?: boolean;
  },
  options?: RequestOptions,
): Promise<CompileSingleResult> {
  return client.request<CompileSingleResult>('compile.single', params, {
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

export function deployStart(
  client: ServeClient,
  params: {
    readonly manifest: string;
    readonly incremental?: boolean;
    readonly buildDir?: string;
  },
): Promise<DeployStartResult> {
  return client.request<DeployStartResult>('deploy.start', params, { timeoutMs: 0 });
}

export function deployFile(
  client: ServeClient,
  params: {
    readonly relPath: string;
    readonly section?: 'amxmodx' | 'assets';
    readonly manifest: string;
    readonly buildDir?: string;
  },
): Promise<DeployFileResult> {
  return client.request<DeployFileResult>('deploy.file', params, { timeoutMs: 0 });
}

export function deployRemove(
  client: ServeClient,
  params: {
    readonly relPath: string;
    readonly section?: 'amxmodx' | 'assets';
    readonly manifest: string;
  },
): Promise<DeployFileResult> {
  return client.request<DeployFileResult>('deploy.remove', params);
}

export function rconSend(
  client: ServeClient,
  params: {
    readonly command: string;
    readonly manifest: string;
    readonly host?: string;
    readonly port?: number;
    readonly password?: string;
  },
): Promise<RconSendResult> {
  return client.request<RconSendResult>('rcon.send', params, { timeoutMs: 20_000 });
}

export function watchStart(client: ServeClient, manifest: string): Promise<WatchStartResult> {
  return client.request<WatchStartResult>('watch.start', { manifest });
}

export function watchStop(client: ServeClient): Promise<WatchStopResult> {
  return client.request<WatchStopResult>('watch.stop', undefined, { timeoutMs: 10_000 });
}
