import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { dedupePreservingOrder, mergeIncludeDirs } from '../src/features/pawnExtMerge';

test('mergeIncludeDirs prepends ours and keeps user dirs after, order preserved', () => {
  const merged = mergeIncludeDirs(['/cache/a', '/cache/b'], ['/user/x', '/user/y'], []);
  assert.deepEqual(merged, ['/cache/a', '/cache/b', '/user/x', '/user/y']);
});

test('mergeIncludeDirs strips previously written dirs from current (stale version cleanup)', () => {
  const merged = mergeIncludeDirs(['/cache/b'], ['/user/x', '/cache/a', '/user/y'], ['/cache/a']);
  assert.deepEqual(merged, ['/cache/b', '/user/x', '/user/y']);
});

test('mergeIncludeDirs does not duplicate ours already present in user dirs', () => {
  const merged = mergeIncludeDirs(['/user/x', '/cache/a'], ['/user/x'], []);
  assert.deepEqual(merged, ['/cache/a', '/user/x']);
});

test('mergeIncludeDirs with empty ours strips prevWritten (pure cleanup)', () => {
  const merged = mergeIncludeDirs([], ['/user/x', '/cache/a', '/user/y'], ['/cache/a']);
  assert.deepEqual(merged, ['/user/x', '/user/y']);
});

test('mergeIncludeDirs empty inputs return empty', () => {
  assert.deepEqual(mergeIncludeDirs([], [], []), []);
});

test('mergeIncludeDirs compares with normalized keys but keeps output verbatim', () => {
  const ours = [path.join('/cache', 'a')];
  const userEntry = path.join('/cache', 'a') + path.sep;
  const merged = mergeIncludeDirs(ours, [userEntry], []);
  // Same directory: not duplicated at the front, user's own entry is kept as-is.
  assert.deepEqual(merged, [userEntry]);
});

test('mergeIncludeDirs treats dot segments and trailing slashes as equal keys', () => {
  const merged = mergeIncludeDirs([path.join('/cache', '.', 'a')], [path.join('/cache', 'a') + path.sep], []);
  assert.deepEqual(merged, [path.join('/cache', 'a') + path.sep]);
});

test('mergeIncludeDirs ignores empty strings in ours', () => {
  const merged = mergeIncludeDirs(['', '/cache/a', ''], [], []);
  assert.deepEqual(merged, ['/cache/a']);
});

test('dedupePreservingOrder keeps first occurrence with normalized comparison', () => {
  assert.deepEqual(dedupePreservingOrder(['/a', '/b', '/a', `${path.join('/b', '')}`]), ['/a', '/b']);
});

test('dedupePreservingOrder skips empty strings', () => {
  assert.deepEqual(dedupePreservingOrder(['', '/a', '']), ['/a']);
});
