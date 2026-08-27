/**
 * Response/param types for every `amxb serve` JSON-RPC method.
 *
 * Shapes verified live against amxb v1.5.2 (see docs/serve/INDEX.md in the
 * amxx-builder repository). JSON-RPC error responses are surfaced as RpcError
 * (see client.ts) and are NOT part of these result types.
 */

// ─── serve.ping ──────────────────────────────────────────────────────────────

export interface ServePingResult {
  readonly ok: true;
  readonly pid: number;
  readonly version: string;
  readonly node: string;
}

// ─── manifest.validate ────────────────────────────────────────────────────────

export interface ValidateIssue {
  /** JSON pointer path, e.g. `/name`, `/amxmodx/version`, `/deps/0`. */
  readonly path: string;
  readonly message: string;
}

export interface ManifestValidateResult {
  readonly valid: boolean;
  readonly errors: readonly ValidateIssue[];
  readonly warnings: readonly ValidateIssue[];
}

// ─── manifest.resolve ────────────────────────────────────────────────────────

export interface ResolvedManifest {
  readonly name: string;
  readonly version?: string;
  readonly platform?: string;
  readonly amxmodx: {
    readonly version?: string;
    readonly dir: string;
    readonly defines: readonly string[];
  };
  readonly github: {
    readonly token_env: string;
    readonly tokens: Readonly<Record<string, string>>;
    readonly ssh: boolean;
  };
  readonly globalDeps: ReadonlyArray<{
    readonly repo: string;
    readonly ref: string;
    readonly include_path: string | null;
    readonly source: 'git' | 'release';
    readonly asset: string | number | null;
  }>;
  readonly plugins?: ReadonlyArray<{
    readonly match: string;
    readonly enabled?: boolean;
    readonly ini?: string | false;
  }>;
  readonly repos?: unknown[];
  readonly deps?: unknown[];
  readonly assets?: unknown;
  readonly output?: {
    readonly dir: string;
    readonly archive_name: string;
    readonly amxmodx_path: string;
    readonly assets_path?: string;
    readonly readme?: boolean;
    readonly generate_ini?: boolean;
    readonly pack?: boolean;
    readonly on_conflict?: string;
  };
  readonly deploy?: {
    readonly path?: string;
    readonly amxmodx_path?: string;
    readonly assets_path?: string;
    readonly watch_debounce_ms?: number;
    readonly exclude?: readonly string[];
    readonly rcon?: {
      readonly host?: string;
      readonly port?: number;
      readonly password?: string;
      readonly command?: string;
    };
  };
  readonly _path: string;
}

// ─── deps.tree ───────────────────────────────────────────────────────────────

export interface DepTreeNode {
  readonly repo: string;
  readonly ref: string;
  readonly resolvedRef: string | null;
  readonly source?: 'git' | 'release';
  readonly include_path?: string | null;
  readonly asset?: string | number | null;
  readonly from: string;
  readonly error: string | null;
  readonly cycle: boolean;
  readonly shared: boolean;
  readonly dependencies: readonly DepTreeNode[];
}

export interface DepsTreeResult {
  readonly dependencies: readonly DepTreeNode[];
}

// ─── include.resolve / include.list / amxmodx.includes.list ──────────────────

export interface IncludeResolveResult {
  readonly found: boolean;
  readonly filename: string;
  readonly absPath?: string;
  readonly source?: string;
  readonly searched?: readonly string[];
  readonly errors?: readonly string[];
}

export interface DepIncludeInfo {
  readonly repo: string;
  readonly ref: string;
  readonly include_path: string | null;
  readonly include_dir?: string;
  readonly count: number;
  readonly files: ReadonlyArray<{ readonly rel: string; readonly abs: string }>;
  readonly error?: string;
}

export interface IncludeListResult {
  readonly manifest: string;
  readonly deps: readonly DepIncludeInfo[];
}

export interface AmxmodxIncludesListResult {
  readonly version: string;
  readonly includeDir: string | null;
  readonly pattern: string;
  readonly count: number;
  readonly files: readonly string[];
}

// ─── dep-graph.get ───────────────────────────────────────────────────────────

export interface DepGraphResult {
  readonly sma_file: string;
  readonly version: string;
  readonly include_dirs: readonly string[];
  readonly files: ReadonlyArray<{
    readonly file: string;
    readonly isSma: boolean;
    readonly includes: readonly string[];
  }>;
  readonly missing: ReadonlyArray<{
    readonly file: string;
    readonly name: string;
    readonly isAngle: boolean;
  }>;
  /** Present only when the `inc` param was passed. */
  readonly smas_depending_on?: readonly string[];
}

// ─── repos.info / repos.branches / repos.structure (GitHub) ──────────────────

export interface ReposErrorData {
  readonly status: number | null;
  readonly repo: string;
  readonly message: string;
}

export type ReposInfoResult =
  | { readonly repo: string; readonly exists: true; readonly private: boolean; readonly archived: boolean; readonly disabled: boolean; readonly defaultBranch: string | null; readonly description: string | null; readonly pushedAt: string | null }
  | { readonly repo: string; readonly exists: false; readonly reason: "not_found_or_no_access" };

export type ReposBranchesResult =
  | { readonly repo: string; readonly exists: false; readonly reason: "not_found_or_no_access" }
  | { readonly repo: string; readonly branches: ReadonlyArray<{ readonly name: string; readonly commitSha: string | null }> };

export interface ReposStructureEntry {
  readonly path: string;
  readonly type: "dir" | "file";
}

export type ReposStructureResult =
  | { readonly repo: string; readonly exists: false; readonly reason: "not_found_or_no_access" }
  | { readonly repo: string; readonly ref: string | null; readonly truncated: boolean; readonly entries: ReadonlyArray<ReposStructureEntry> };

// ─── releases.list ───────────────────────────────────────────────────────────

export interface ReleaseInfo {
  readonly tagName: string;
  readonly name?: string;
  readonly publishedAt?: string;
  readonly prerelease?: boolean;
  readonly commitSha?: string;
  readonly assets?: ReadonlyArray<{
    readonly name: string;
    readonly size?: number;
    readonly downloadCount?: number;
  }>;
}

// ─── cache.info / compiler.info ──────────────────────────────────────────────

export interface CacheInfoResult {
  readonly amxxpc?: { readonly version: string; readonly size?: number; readonly cached?: boolean };
  readonly repos?: Readonly<Record<string, unknown>>;
  readonly releaseDeps?: Readonly<Record<string, unknown>>;
  readonly local?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface CompilerInfoResult {
  readonly version: string;
  readonly platform?: string;
  readonly compilerPath: string | null;
  readonly includeDir: string | null;
  readonly cached: boolean;
}

// ─── build.plan ──────────────────────────────────────────────────────────────

export interface BuildPlanResult {
  readonly name: string;
  readonly version?: string;
  readonly compiler: {
    readonly version: string;
    readonly dir: string;
    readonly platform: string | null;
    readonly defines: readonly string[];
  };
  readonly repos?: readonly unknown[];
  readonly deps?: readonly unknown[];
  readonly assets?: readonly unknown[];
  readonly output: {
    readonly pack: boolean;
    readonly target?: string;
    readonly amxmodx_path: string;
    readonly assets_path?: string;
    readonly generate_ini: boolean;
    readonly on_conflict: string;
  };
  readonly [key: string]: unknown;
}

// ─── build.start / build.cancel ──────────────────────────────────────────────

export interface BuildStartResult {
  readonly ok: boolean;
  readonly elapsed?: string;
  readonly noArchive?: boolean;
  readonly cancelled?: boolean;
  readonly message?: string;
}

export interface BuildCancelResult {
  readonly ok: boolean;
  readonly error?: string;
}

// ─── compile.single ──────────────────────────────────────────────────────────

export interface CompileSingleResult {
  readonly ok: boolean;
  readonly amxxName: string | null;
  readonly output?: string;
  readonly output_path: string | null;
  readonly dep_errors?: readonly string[];
}

// ─── deploy ──────────────────────────────────────────────────────────────────

export interface DeployStartResult {
  readonly ok: boolean;
  readonly copied?: number;
  readonly message?: string;
}

export interface DeployFileResult {
  readonly ok: boolean;
  readonly dest: string | null;
  readonly message?: string;
}

// ─── rcon.send ───────────────────────────────────────────────────────────────

export interface RconSendResult {
  readonly ok: true;
  readonly response: string;
}

// ─── watch.start / watch.stop ────────────────────────────────────────────────

export interface WatchStartResult {
  readonly ok: boolean;
  readonly watching?: string;
  readonly error?: string;
}

export interface WatchStopResult {
  readonly ok: boolean;
  readonly error?: string;
}

// ─── Push notifications ──────────────────────────────────────────────────────

export interface BuildStageNotification {
  readonly stage: 'compiler' | 'repos' | 'deps' | 'collect' | 'assets' | 'compile' | 'ini' | 'archive';
  readonly message: string;
}

export interface BuildProgressNotification {
  readonly label: string;
  readonly current: number;
  readonly total: number;
}

export interface BuildCompiledNotification {
  readonly baseName: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly amxxName?: string;
  readonly repo?: string;
  readonly ref?: string;
}

export type WatchChangedKind = 'sma' | 'inc' | 'file' | 'delete' | 'manifest';

export interface WatchChangedNotification {
  readonly kind: WatchChangedKind;
  readonly path?: string;
  readonly rel?: string;
  readonly section?: string;
}
