import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRepoCache, INFO_TTL_MS, DYNAMIC_TTL_MS } from '../src/features/repoSuggestCache';
import type { CacheStorage } from '../src/features/repoSuggestCache';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Plain-object fake storage: `update(k, undefined)` deletes the key. */
function makeFakeStorage(): CacheStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key),
    update: (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  };
}

test('set + get within TTL returns the value (round-trip through fake storage)', () => {
  const storage = makeFakeStorage();
  const cache = createRepoCache(storage);
  const repo = { owner: 'owner', name: 'repo', description: 'x', stars: 42 };
  cache.set('info:owner/repo', repo, INFO_TTL_MS);
  assert.deepEqual(cache.get<typeof repo>('info:owner/repo'), repo);
  assert.notEqual(storage.get('info:owner/repo'), undefined, 'entry persisted to storage');
});

test('get after TTL expiry returns undefined and drops the storage entry', () => {
  let clock = 1_000_000_000;
  const storage = makeFakeStorage();
  const cache = createRepoCache(storage, () => clock);
  cache.set('branches:owner/repo', ['main', 'dev'], DYNAMIC_TTL_MS);
  assert.deepEqual(cache.get<string[]>('branches:owner/repo'), ['main', 'dev']);

  clock += DYNAMIC_TTL_MS; // exactly at the boundary: now - fetchedAt >= ttlMs → stale
  assert.equal(cache.get<string[]>('branches:owner/repo'), undefined);
  assert.equal(storage.get('branches:owner/repo'), undefined, 'stale storage entry dropped');
});

test('stale-restore: pre-seeded storage entry older than TTL is ignored on first get', () => {
  const nowMs = 2_000_000_000_000;
  const storage = makeFakeStorage();
  storage.update(
    'info:owner/repo',
    JSON.stringify({ value: { stale: true }, fetchedAt: nowMs - 7 * DAY_MS, ttlMs: INFO_TTL_MS }),
  );
  const cache = createRepoCache(storage, () => nowMs);
  assert.equal(cache.get<{ stale: boolean }>('info:owner/repo'), undefined);
  assert.equal(storage.get('info:owner/repo'), undefined, 'stale restored entry dropped');
});

test('valid persisted entry is hydrated from storage on first get', () => {
  const nowMs = 3_000_000_000_000;
  const storage = makeFakeStorage();
  storage.update(
    'tags:owner/repo',
    JSON.stringify({ value: ['v1.0.0', 'v1.1.0'], fetchedAt: nowMs - 1_000, ttlMs: DYNAMIC_TTL_MS }),
  );
  const cache = createRepoCache(storage, () => nowMs);
  assert.deepEqual(cache.get<string[]>('tags:owner/repo'), ['v1.0.0', 'v1.1.0']);
});

test('hydrated entry is TTL-checked like a set entry', () => {
  let clock = 4_000_000_000_000;
  const storage = makeFakeStorage();
  storage.update('branches:owner/repo', JSON.stringify({ value: ['main'], fetchedAt: clock, ttlMs: DYNAMIC_TTL_MS }));
  const cache = createRepoCache(storage, () => clock);
  assert.deepEqual(cache.get<string[]>('branches:owner/repo'), ['main']);
  clock += DYNAMIC_TTL_MS;
  assert.equal(cache.get<string[]>('branches:owner/repo'), undefined);
});

test('invalid JSON in storage yields undefined without throwing', () => {
  const storage = makeFakeStorage();
  storage.update('info:owner/repo', 'not json {{{');
  const cache = createRepoCache(storage);
  assert.doesNotThrow(() => cache.get<unknown>('info:owner/repo'));
  assert.equal(cache.get<unknown>('info:owner/repo'), undefined);
});

test('track/pending dedupe concurrent fetches and clears on settle', async () => {
  const cache = createRepoCache(undefined);
  let resolveFetch!: (value: string) => void;
  const p1 = new Promise<unknown>((resolve) => {
    resolveFetch = (value) => resolve(value);
  });
  cache.track('info:owner/repo', p1);
  assert.equal(cache.pending('info:owner/repo'), p1, 'pending returns the tracked promise');

  resolveFetch('done');
  await p1;
  assert.equal(cache.pending('info:owner/repo'), undefined, 'tracked promise cleared after settle');
});

test('track clears the promise when the fetch rejects', async () => {
  const cache = createRepoCache(undefined);
  let failFetch!: (error: Error) => void;
  const p1 = new Promise<unknown>((_, reject) => {
    failFetch = (error) => reject(error);
  });
  cache.track('tags:owner/repo', p1);
  assert.equal(cache.pending('tags:owner/repo'), p1);

  failFetch(new Error('boom'));
  await assert.rejects(p1, /boom/);
  assert.equal(cache.pending('tags:owner/repo'), undefined);
});

test('evictByPrefix removes only keys with the prefix (memory and storage)', () => {
  const storage = makeFakeStorage();
  const cache = createRepoCache(storage);
  cache.set('info:owner/repo', { stars: 42 }, INFO_TTL_MS);
  cache.set('structure:owner/repo/main/false/', ['src/x.sma'], DYNAMIC_TTL_MS);
  cache.set('structure:owner/repo/dev/false/', ['src/y.sma'], DYNAMIC_TTL_MS);
  cache.set('tags:owner/repo', ['v1'], DYNAMIC_TTL_MS);

  cache.evictByPrefix('structure:');

  assert.equal(cache.get<unknown>('structure:owner/repo/main/false/'), undefined);
  assert.equal(cache.get<unknown>('structure:owner/repo/dev/false/'), undefined);
  assert.equal(storage.get('structure:owner/repo/main/false/'), undefined, 'evicted storage entry dropped');
  assert.deepEqual(cache.get<{ stars: number }>('info:owner/repo'), { stars: 42 });
  assert.deepEqual(cache.get<string[]>('tags:owner/repo'), ['v1']);
});

test('works in-memory with no storage injected', () => {
  const cache = createRepoCache(undefined);
  cache.set('info:owner/repo', { owner: 'owner' }, INFO_TTL_MS);
  assert.deepEqual(cache.get<{ owner: string }>('info:owner/repo'), { owner: 'owner' });
});

test('set tolerates storage failures (best-effort persistence)', () => {
  const failingStorage: CacheStorage = {
    get: () => undefined,
    update: () => {
      throw new Error('memento write failed');
    },
  };
  const cache = createRepoCache(failingStorage);
  assert.doesNotThrow(() => cache.set('info:owner/repo', { ok: true }, INFO_TTL_MS));
  assert.deepEqual(cache.get<{ ok: boolean }>('info:owner/repo'), { ok: true });
});

test('default TTL constants match the documented windows', () => {
  assert.equal(INFO_TTL_MS, DAY_MS);
  assert.equal(DYNAMIC_TTL_MS, 60 * 60 * 1000);
});
