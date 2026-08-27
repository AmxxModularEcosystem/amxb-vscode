import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectContext, isRefVerifiable, listRepoEntries } from '../src/features/repoSuggestContext';

// All fixtures below are exact strings; cursor offsets were computed against
// yaml@2.9 node `.range` values (0-based character offsets).

test('object form: cursor in the ref value → kind "ref" with entry context', () => {
  // repos:\n  - repo: A/B\n    ref: 1.4.2\n   (ref value at [30,35))
  const text = 'repos:\n  - repo: A/B\n    ref: 1.4.2\n';
  assert.deepEqual(detectContext(text, 32), {
    block: 'repos',
    kind: 'ref',
    repo: 'A/B',
    ref: '1.4.2',
    range: [30, 35],
  });
});

test('object form: empty ref value (live typing) still yields kind "ref"', () => {
  // repos:\n  - repo: A/B\n    ref:\n   (null value sits at offset 29)
  const text = 'repos:\n  - repo: A/B\n    ref:\n';
  assert.deepEqual(detectContext(text, 29), {
    block: 'repos',
    kind: 'ref',
    repo: 'A/B',
    ref: '',
    range: [29, 29],
  });
});

test('shorthand: cursor after `@` → kind "shorthand" with repo and empty ref', () => {
  // deps:\n  - A/B@\n   (scalar "A/B@" at [10,14))
  const text = 'deps:\n  - A/B@\n';
  assert.deepEqual(detectContext(text, 14), {
    block: 'deps',
    kind: 'shorthand',
    repo: 'A/B',
    ref: '',
    range: [10, 14],
  });
});

test('shorthand with explicit ref keeps ref between @ and :', () => {
  const text = 'deps:\n  - A/B@1.4.2:addons/scripting\n';
  const ctx = detectContext(text, 17);
  assert.equal(ctx?.kind, 'shorthand');
  assert.equal(ctx?.repo, 'A/B');
  assert.equal(ctx?.ref, '1.4.2');
});

test('quoted shorthand scalar strips the quotes from the range', () => {
  // repos: ["A/B@1.0"]\n   (quoted scalar content at [9,16))
  const text = 'repos: ["A/B@1.0"]\n';
  assert.deepEqual(detectContext(text, 10), {
    block: 'repos',
    kind: 'shorthand',
    repo: 'A/B',
    ref: '1.0',
    range: [9, 16],
  });
});

test('asset: under source: release → kind "asset" with source "release"', () => {
  const text = 'deps:\n  - repo: A/B\n    source: release\n    asset: x.amxx\n';
  assert.deepEqual(detectContext(text, 54), {
    block: 'deps',
    kind: 'asset',
    repo: 'A/B',
    source: 'release',
    range: [51, 57],
  });
});

test('asset: without a source key → kind "asset", source omitted', () => {
  const text = 'deps:\n  - repo: A/B\n    asset: x.amxx\n';
  assert.deepEqual(detectContext(text, 34), {
    block: 'deps',
    kind: 'asset',
    repo: 'A/B',
    range: [31, 37],
  });
});

test('asset: under source: git → kind "asset" with source "git" (caller decides)', () => {
  const text = 'deps:\n  - repo: A/B\n    source: git\n    asset: x.amxx\n';
  assert.deepEqual(detectContext(text, 50), {
    block: 'deps',
    kind: 'asset',
    repo: 'A/B',
    source: 'git',
    range: [47, 53],
  });
});

test('amxmodx_dir: value → kind "amxmodx_dir"', () => {
  const text = 'repos:\n  - repo: A/B\n    amxmodx_dir: scripting\n';
  assert.deepEqual(detectContext(text, 41), {
    block: 'repos',
    kind: 'amxmodx_dir',
    repo: 'A/B',
    range: [38, 47],
  });
});

test('exclude: cursor in a list item → kind "exclude" (range covers the whole list value)', () => {
  const text = 'repos:\n  - repo: A/B\n    exclude:\n      - foo.sma\n';
  assert.deepEqual(detectContext(text, 44), {
    block: 'repos',
    kind: 'exclude',
    repo: 'A/B',
    range: [40, 50],
  });
});

test('exclude_files: list value → kind "exclude_files"', () => {
  const text = 'repos:\n  - repo: A/B\n    exclude_files:\n      - z.sma\n';
  assert.deepEqual(detectContext(text, 51), {
    block: 'repos',
    kind: 'exclude_files',
    repo: 'A/B',
    range: [46, 54],
  });
});

test('quoted ref value: range excludes the quotes', () => {
  // ref: "1.0"  → quoted scalar at [30,35], content (range we report) is [31,34)
  const text = 'repos:\n  - repo: A/B\n    ref: "1.0"\n';
  assert.deepEqual(detectContext(text, 32), {
    block: 'repos',
    kind: 'ref',
    repo: 'A/B',
    ref: '1.0',
    range: [31, 34],
  });
});

test('non-suggestion fields (source: value) → kind "none" with entry context', () => {
  const text = 'deps:\n  - repo: A/B\n    source: release\n';
  assert.deepEqual(detectContext(text, 35), {
    block: 'deps',
    kind: 'none',
    repo: 'A/B',
    source: 'release',
    range: [32, 39],
  });
});

test('cursor on a key name inside an entry → kind "none"', () => {
  const text = 'repos:\n  - repo: A/B\n    ref: 1.4.2\n';
  assert.deepEqual(detectContext(text, 11), {
    block: 'repos',
    kind: 'none',
    repo: 'A/B',
    ref: '1.4.2',
    range: [11, 36],
  });
});

test('cursor in a repo: value → undefined (nothing to suggest there)', () => {
  const text = 'repos:\n  - repo: A/B\n    ref: 1.4.2\n';
  assert.equal(detectContext(text, 18), undefined);
});

test('cursor in a comment → undefined', () => {
  assert.equal(detectContext('# foo\nrepos:\n  - repo: A/B\n', 3), undefined);
  // comment inside the repos block, before the first item
  assert.equal(detectContext('repos:\n  # foo\n  - repo: A/B\n', 12), undefined);
});

test('malformed manifests return undefined and never throw', () => {
  // unbalanced quote → parse error
  assert.equal(detectContext('repos:\n  - repo: "A/B\n', 12), undefined);
  // repos: with no entries → value is not a sequence
  assert.equal(detectContext('repos:\n', 6), undefined);
  // bare trailing `@` → parse error
  assert.equal(detectContext('repos:\n  - @\n', 12), undefined);
  // trailing `@` on a non-repo scalar (no slash) → not a repo entry
  assert.equal(detectContext('repos:\n  - owner@\n', 13), undefined);
  // document that is not a map at all
  assert.equal(detectContext('@', 0), undefined);
  assert.equal(detectContext('', 0), undefined);
});

test('cursor outside repos/deps/plugins (other top-level keys) → undefined', () => {
  const text = 'name: foo\ndeploy:\n  - something\n';
  assert.equal(detectContext(text, 6), undefined);
});

test('plugins: cursor in the match value → kind "plugin_match" with empty repo', () => {
  // plugins:\n  - match: a.sma\n   (match value at [20,25))
  const text = 'plugins:\n  - match: a.sma\n';
  assert.deepEqual(detectContext(text, 22), {
    block: 'plugins',
    kind: 'plugin_match',
    repo: '',
    range: [20, 25],
  });
});

test('plugins: empty match value (live typing) → "plugin_match" with zero-width range', () => {
  // plugins:\n  - match:\n   (empty value sits at offset 19)
  const text = 'plugins:\n  - match:\n';
  assert.deepEqual(detectContext(text, 19), {
    block: 'plugins',
    kind: 'plugin_match',
    repo: '',
    range: [19, 19],
  });
});

test('plugins: quoted match value → range excludes the quotes', () => {
  // plugins:\n  - match: "a.sma"\n   (quoted scalar at [20,27), content [21,26))
  const text = 'plugins:\n  - match: "a.sma"\n';
  assert.deepEqual(detectContext(text, 23), {
    block: 'plugins',
    kind: 'plugin_match',
    repo: '',
    range: [21, 26],
  });
});

test('plugins: cursor on the enabled: value inside a plugin rule → undefined', () => {
  // plugins:\n  - match: a.sma\n    enabled: false\n   (enabled value at [39,44))
  const text = 'plugins:\n  - match: a.sma\n    enabled: false\n';
  assert.equal(detectContext(text, 40), undefined);
});

test('plugins: scalar value (not a list) → undefined', () => {
  // plugins: some.sma\n   (scalar at [9,17))
  const text = 'plugins: some.sma\n';
  assert.equal(detectContext(text, 10), undefined);
});

test('cursor in a name: value while a plugins block exists → undefined', () => {
  // name: foo\nplugins:\n  - match: a.sma\n    enabled: false\n   (name value at [6,9))
  const text = 'name: foo\nplugins:\n  - match: a.sma\n    enabled: false\n';
  assert.equal(detectContext(text, 7), undefined);
});

test('listRepoEntries: 2 object-form + 1 shorthand → 3 entries with correct ranges', () => {
  const text = 'repos:\n  - repo: A/B\n    ref: 1.0\n  - repo: C/D\n  - E/F@2.0\n';
  assert.deepEqual(listRepoEntries(text), [
    { repo: 'A/B', range: [17, 20] },
    { repo: 'C/D', range: [44, 47] },
    { repo: 'E/F', range: [52, 55] },
  ]);
});

test('listRepoEntries: malformed manifest → [] (no throw)', () => {
  assert.deepEqual(listRepoEntries('repos:\n  - repo: "A/B\n'), []);
  assert.deepEqual(listRepoEntries(''), []);
  assert.deepEqual(listRepoEntries('repos:\n'), []);
});

test('listRepoEntries: quoted repo values get the unquoted range', () => {
  const text = 'repos:\n  - repo: "A/B"\n';
  assert.deepEqual(listRepoEntries(text), [{ repo: 'A/B', range: [18, 21] }]);
});

test('isRefVerifiable', () => {
  assert.equal(isRefVerifiable('latest'), false);
  assert.equal(isRefVerifiable(''), false);
  assert.equal(isRefVerifiable('a'.repeat(40)), false);
  assert.equal(isRefVerifiable('A'.repeat(40)), false);
  assert.equal(isRefVerifiable('1.4.2'), true);
  assert.equal(isRefVerifiable('5.29.0.358'), true);
  assert.equal(isRefVerifiable('main'), true);
});
