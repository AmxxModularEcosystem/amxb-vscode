/**
 * Pure error classification for the repos/dependencies suggestion feature.
 *
 * Maps an RpcError (from `src/serve/client.ts`, where `data` is `unknown`)
 * into user-facing messages. Kept deliberately dependency-free: no vscode, no
 * serve layer, no other feature modules — feed it any thrown value and get a
 * message back.
 *
 * Serve contract this encodes (verified against amxb serve):
 *  - `repos.*` methods return `{ exists: false }` as a SUCCESS result (no
 *    error thrown); providers route that through `existsFalseMessage()`.
 *  - `releases.list` on a nonexistent repo THROWS an RpcError with
 *    `data.status === 404` → kind `"not_found"`.
 *  - `repos.structure` with a bad ref throws `data.status === 404` with a
 *    "Ref not found" message → kind `"ref_not_found"`.
 *  - `data.status === 403 | 429` (rate limiting) → kind `"rate_limited"`.
 */

export type RepoErrorKind = 'not_found' | 'rate_limited' | 'ref_not_found' | 'other';

export interface RepoErrorInfo {
  readonly kind: RepoErrorKind;
  readonly message: string;
}

/** Shape of the serve-layer error payload (`RpcError.data`). */
interface RepoErrorData {
  readonly status: number | null;
  readonly repo: string;
  readonly message: string;
}

/** RpcError-like: an object with a numeric `code` and a string `message`. */
interface RpcErrorLike {
  readonly code: number;
  readonly message: string;
  readonly data: unknown;
}

function isRpcErrorLike(err: unknown): err is RpcErrorLike {
  if (typeof err !== 'object' || err === null) return false;
  const obj = err as Record<string, unknown>;
  return typeof obj.code === 'number' && typeof obj.message === 'string';
}

function isRepoErrorData(value: unknown): value is RepoErrorData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (typeof obj.status === 'number' || obj.status === null) &&
    typeof obj.repo === 'string' &&
    typeof obj.message === 'string'
  );
}

/** The closest thing to an original message for any thrown value. */
function originalMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
  }
  return undefined;
}

export function classifyRepoError(err: unknown, repo: string): RepoErrorInfo {
  if (isRpcErrorLike(err) && isRepoErrorData(err.data)) {
    const data = err.data;
    if (data.status === 404 && /Ref not found/i.test(data.message)) {
      return { kind: 'ref_not_found', message: `ref не найден: ${repo}` };
    }
    if (data.status === 404) {
      return { kind: 'not_found', message: existsFalseMessage(repo) };
    }
    if (data.status === 403 || data.status === 429) {
      return { kind: 'rate_limited', message: 'GitHub rate limit — повторите позже' };
    }
    return { kind: 'other', message: data.message || String(err.message || err) };
  }
  return { kind: 'other', message: originalMessage(err) ?? String(err) };
}

export function existsFalseMessage(repo: string): string {
  return `не существует или нет доступа: ${repo}`;
}
