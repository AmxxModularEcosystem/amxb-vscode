import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findManifestUp } from '../src/util/manifestSearch';

interface TestTree {
  readonly root: string;
  readonly includeDir: string;
}

function makeTree(): TestTree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-manifest-'));
  const includeDir = path.join(root, 'repo', 'amxmodx', 'scripting', 'include');
  fs.mkdirSync(includeDir, { recursive: true });
  return { root, includeDir };
}

test('findManifestUp finds amxbuild.yml walking up from include dir', () => {
  const { root, includeDir } = makeTree();
  fs.writeFileSync(path.join(root, 'repo', 'amxbuild.yml'), 'name: demo\n');
  const found = findManifestUp(includeDir);
  assert.equal(found, path.join(root, 'repo', 'amxbuild.yml'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('findManifestUp prefers amxbuild.yml over manifest.yml', () => {
  const { root, includeDir } = makeTree();
  fs.writeFileSync(path.join(root, 'repo', 'amxbuild.yml'), 'a: 1\n');
  fs.writeFileSync(path.join(root, 'repo', 'manifest.yml'), 'b: 2\n');
  const found = findManifestUp(includeDir);
  assert.equal(found, path.join(root, 'repo', 'amxbuild.yml'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('findManifestUp returns undefined for a repo without a manifest', () => {
  const { root, includeDir } = makeTree();
  const found = findManifestUp(includeDir);
  assert.equal(found, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findManifestUp respects maxLevels', () => {
  const { root, includeDir } = makeTree();
  fs.writeFileSync(path.join(root, 'repo', 'amxbuild.yml'), 'name: demo\n');
  const found = findManifestUp(includeDir, 1);
  assert.equal(found, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});
