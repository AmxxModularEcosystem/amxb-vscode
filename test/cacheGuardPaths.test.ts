import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { dedupeRoots, isUnderAnyRoot } from '../src/features/cacheGuardPaths';

test('isUnderAnyRoot: file directly under root is inside', () => {
  const root = path.join('/cache', 'amxx-builder');
  assert.equal(isUnderAnyRoot(path.join(root, 'repos', 'a', 'x.inc'), [root]), true);
  assert.equal(isUnderAnyRoot(path.join(root, 'x.inc'), [root]), true);
});

test('isUnderAnyRoot: nested subdirectories are inside', () => {
  const root = '/cache/amxx-builder';
  assert.equal(isUnderAnyRoot(`${root}/repos/owner/repo/amxmodx/scripting/include/x.inc`, [root]), true);
});

test('isUnderAnyRoot: sibling and outside paths are not inside', () => {
  const root = '/cache/amxx-builder';
  assert.equal(isUnderAnyRoot('/cache/other/x.inc', [root]), false);
  assert.equal(isUnderAnyRoot('/cache/amxx-builder-backup/x.inc', [root]), false);
  assert.equal(isUnderAnyRoot('/home/user/project/scripting/include/x.inc', [root]), false);
});

test('isUnderAnyRoot: the root itself is not considered inside', () => {
  const root = '/cache/amxx-builder';
  assert.equal(isUnderAnyRoot(root, [root]), false);
});

test('isUnderAnyRoot: matches any of several roots', () => {
  assert.equal(isUnderAnyRoot('/b/x.inc', ['/a', '/b']), true);
  assert.equal(isUnderAnyRoot('/c/x.inc', ['/a', '/b']), false);
});

test('isUnderAnyRoot: empty roots or empty path', () => {
  assert.equal(isUnderAnyRoot('/a/x.inc', []), false);
  assert.equal(isUnderAnyRoot('', ['/a']), false);
});

test('isUnderAnyRoot: trailing-separator root spelling matches', () => {
  const root = '/cache/amxx-builder';
  assert.equal(isUnderAnyRoot(`${root}/x.inc`, [`${root}${path.sep}`]), true);
});

test('dedupeRoots drops empties and preserves order', () => {
  assert.deepEqual(dedupeRoots(['/a', '', '/b', '']), ['/a', '/b']);
});

test('dedupeRoots dedupes by resolved path (trailing separators)', () => {
  const trailing = `${path.join('/a', '')}${path.sep}`;
  assert.deepEqual(dedupeRoots(['/a', trailing, '/b']), ['/a', '/b']);
});
