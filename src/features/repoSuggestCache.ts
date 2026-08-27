/**
 * Pure TTL cache for GitHub repo metadata (info / tags / branches / structure).
 *
 * The extension's anonymous GitHub rate limit is 60 requests per hour per IP,
 * so every repo fetch is cached here with a TTL. This module deliberately has
 * NO `vscode` import so it can be unit-tested in plain Node: the caller injects
 * a {@link CacheStorage} adapter (e.g. wrapping the `workspaceState` Memento)
 * and optionally a clock for testability.
 *
 * Key scheme (used by the repo-suggest feature):
 *   `info:<repo>`                            — repo metadata (owner/name/description/…)
 *   `tags:<repo>`                            — tag list
 *   `branches:<repo>`                        — branch list
 *   `structure:<repo>:<ref>:<dirsOnly>:<ext-joined>` — file-tree listing for a ref
 *
 * Persisted entry format: `JSON.stringify({ value, fetchedAt, ttlMs })`.
 *
 * Persistence is best-effort: `set` writes both the in-memory map and the
 * injected storage, swallowing any storage failure. Entries are hydrated
 * lazily from storage on the first `get` for a key and validated against the
 * clock — a persisted "24h" entry restored weeks later is stale and ignored
 * (this is the Memento-restore validation).
 */

export const INFO_TTL_MS = 24 * 60 * 60 * 1000;
export const DYNAMIC_TTL_MS = 60 * 60 * 1000;

/** Key/value persistence adapter injected by the caller (e.g. a Memento). */
export interface CacheStorage {
  get(key: string): string | undefined;
  /**
   * Persist `value` under `key`. Passing `undefined` removes the key — this
   * mirrors VS Code `workspaceState.update(key, undefined)` semantics and is
   * how stale/corrupt entries are dropped from storage.
   */
  update(key: string, value: string | undefined): void;
}

export interface RepoCache {
  /** Cached value for `key`, or `undefined` when missing/stale/not hydrated. */
  get<T>(key: string): T | undefined;
  /** Store `value` for `key` with the given TTL (memory + best-effort storage). */
  set<T>(key: string, value: T, ttlMs: number): void;
  /** The tracked in-flight fetch promise for `key`, if any (fetch dedupe). */
  pending(key: string): Promise<unknown> | undefined;
  /** Register an in-flight fetch promise; removed once it settles. */
  track(key: string, promise: Promise<unknown>): void;
  /** Forget every cached entry (memory and storage) whose key starts with `prefix`. */
  evictByPrefix(prefix: string): void;
}

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
  ttlMs: number;
}

export function createRepoCache(storage: CacheStorage | undefined, now?: () => number): RepoCache {
  const timeNow = now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();
  // Keys we have already attempted to hydrate from storage, so a miss stays a
  // miss instead of re-reading the Memento on every `get`.
  const storageAttempted = new Set<string>();

  function dropFromStorage(key: string): void {
    if (storage === undefined) return;
    try {
      storage.update(key, undefined);
    } catch {
      // best-effort persistence; dropping must never throw for callers
    }
  }

  /** Read + validate one key from storage, promoting fresh entries to memory. */
  function hydrate(key: string): unknown | undefined {
    if (storage === undefined) return undefined;
    let raw: string | undefined;
    try {
      raw = storage.get(key);
    } catch {
      return undefined;
    }
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      dropFromStorage(key); // corrupt entry: forget it
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      dropFromStorage(key);
      return undefined;
    }
    const entry = parsed as { value?: unknown; fetchedAt?: unknown; ttlMs?: unknown };
    if (typeof entry.fetchedAt !== 'number' || typeof entry.ttlMs !== 'number') {
      dropFromStorage(key);
      return undefined;
    }
    if (timeNow() - entry.fetchedAt >= entry.ttlMs) {
      dropFromStorage(key); // stale persisted entry (e.g. 24h TTL restored a week later)
      return undefined;
    }
    const fresh: CacheEntry = { value: entry.value, fetchedAt: entry.fetchedAt, ttlMs: entry.ttlMs };
    entries.set(key, fresh);
    return fresh.value;
  }

  return {
    get<T>(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry !== undefined) {
        if (timeNow() - entry.fetchedAt < entry.ttlMs) return entry.value as T;
        entries.delete(key); // expired in memory
        dropFromStorage(key);
        return undefined;
      }
      if (storage !== undefined && !storageAttempted.has(key)) {
        storageAttempted.add(key);
        return hydrate(key) as T | undefined;
      }
      return undefined;
    },
    set<T>(key: string, value: T, ttlMs: number): void {
      const entry: CacheEntry = { value, fetchedAt: timeNow(), ttlMs };
      entries.set(key, entry);
      if (storage !== undefined) {
        try {
          storage.update(key, JSON.stringify(entry));
        } catch {
          // best-effort persistence; a failing Memento must not break callers
        }
      }
    },
    pending(key: string): Promise<unknown> | undefined {
      return inflight.get(key);
    },
    track(key: string, promise: Promise<unknown>): void {
      inflight.set(key, promise);
      const clear = (): void => {
        if (inflight.get(key) === promise) inflight.delete(key);
      };
      // `.then(clear, clear)` (not `.finally`) so a rejected fetch cannot
      // surface as an unhandled rejection on the derived promise.
      promise.then(clear, clear);
    },
    evictByPrefix(prefix: string): void {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          dropFromStorage(key);
        }
      }
      for (const key of [...inflight.keys()]) {
        if (key.startsWith(prefix)) inflight.delete(key);
      }
    },
  };
}
