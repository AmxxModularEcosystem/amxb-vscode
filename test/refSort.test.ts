import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseVersionRef, compareRefsDesc, sortRefsDesc } from '../src/features/refSort';

test('parseVersionRef parses a plain numeric core', () => {
  assert.deepEqual(parseVersionRef('1.2.3'), { core: [1, 2, 3], pre: [] });
});

test('parseVersionRef strips ONE leading v/V only before a digit', () => {
  assert.deepEqual(parseVersionRef('v1.12'), { core: [1, 12], pre: [] });
  assert.deepEqual(parseVersionRef('V2.0.1'), { core: [2, 0, 1], pre: [] });
  assert.equal(parseVersionRef('v'), undefined); // not followed by a digit
  assert.equal(parseVersionRef('vv1.2'), undefined); // only ONE leading v stripped → core invalid
});

test('parseVersionRef ignores build metadata after +', () => {
  assert.deepEqual(parseVersionRef('1.2.3+build.5'), { core: [1, 2, 3], pre: [] });
  assert.deepEqual(parseVersionRef('1.2.3-beta+meta.7'), { core: [1, 2, 3], pre: ['beta'] });
});

test('parseVersionRef splits pre-release at the FIRST dash', () => {
  assert.deepEqual(parseVersionRef('1.2.3-beta.1'), { core: [1, 2, 3], pre: ['beta', 1] });
  assert.deepEqual(parseVersionRef('1.2.3-beta.2'), { core: [1, 2, 3], pre: ['beta', 2] });
  assert.deepEqual(parseVersionRef('1.2.3-beta.10'), { core: [1, 2, 3], pre: ['beta', 10] });
  assert.deepEqual(parseVersionRef('1.2.3-alpha'), { core: [1, 2, 3], pre: ['alpha'] });
  assert.deepEqual(parseVersionRef('2024-01-01'), { core: [2024], pre: ['01-01'] });
});

test('parseVersionRef handles multi-segment numeric cores', () => {
  assert.deepEqual(parseVersionRef('5.29.0.358'), { core: [5, 29, 0, 358], pre: [] });
});

test('parseVersionRef rejects empty/invalid cores and pre-release identifiers', () => {
  assert.equal(parseVersionRef(''), undefined);
  assert.equal(parseVersionRef('   '), undefined);
  assert.equal(parseVersionRef('-1.2.3'), undefined); // empty core
  assert.equal(parseVersionRef('1.2.3-'), undefined); // empty pre identifier
  assert.equal(parseVersionRef('1.2.3-a..b'), undefined); // empty pre identifier
  assert.equal(parseVersionRef('1.2.x'), undefined);
  assert.equal(parseVersionRef('1.2.3a'), undefined);
  assert.equal(parseVersionRef('main'), undefined);
  assert.equal(parseVersionRef('dev'), undefined);
  assert.equal(parseVersionRef('some-feature'), undefined);
  assert.equal(parseVersionRef('a'.repeat(40)), undefined); // 40-hex commit SHA
});

test('1.12 sorts above 1.2', () => {
  assert.deepEqual(sortRefsDesc(['1.2', '1.12']), ['1.12', '1.2']);
});

test('v1.12 and 1.12 are equal precedence → stable original order preserved', () => {
  assert.deepEqual(sortRefsDesc(['1.12', 'v1.12']), ['1.12', 'v1.12']);
  assert.deepEqual(sortRefsDesc(['v1.12', '1.12']), ['v1.12', '1.12']);
  assert.equal(compareRefsDesc('v1.12', '1.12'), 0);
});

test('release sorts above pre-release: 1.2.3 above 1.2.3-beta', () => {
  assert.deepEqual(sortRefsDesc(['1.2.3', '1.2.3-beta']), ['1.2.3', '1.2.3-beta']);
  assert.deepEqual(sortRefsDesc(['1.2.3-beta', '1.2.3']), ['1.2.3', '1.2.3-beta']);
});

test('pre-release identifiers: beta.2 above beta.1, beta above alpha', () => {
  assert.deepEqual(sortRefsDesc(['1.2.3-beta.1', '1.2.3-beta.2']), ['1.2.3-beta.2', '1.2.3-beta.1']);
  assert.deepEqual(sortRefsDesc(['1.2.3-alpha', '1.2.3-beta']), ['1.2.3-beta', '1.2.3-alpha']);
});

test('numeric pre identifiers compare numerically: beta.10 above beta.9', () => {
  assert.deepEqual(sortRefsDesc(['1.2.3-beta.9', '1.2.3-beta.10']), ['1.2.3-beta.10', '1.2.3-beta.9']);
});

test('missing pre identifier ranks lower: beta above beta.1', () => {
  assert.deepEqual(sortRefsDesc(['1.2.3-beta', '1.2.3-beta.1']), ['1.2.3-beta.1', '1.2.3-beta']);
});

test('numeric pre identifier ranks below alphanumeric: beta.a above beta.1', () => {
  assert.deepEqual(sortRefsDesc(['1.2.3-beta.1', '1.2.3-beta.a']), ['1.2.3-beta.a', '1.2.3-beta.1']);
});

test('unknowns sort LAST preserving their original relative order', () => {
  const sha = 'a'.repeat(40);
  const refs = ['main', 'dev', sha, 'some-feature'];
  assert.deepEqual(sortRefsDesc(refs), refs);
});

test('full mixed assertion', () => {
  assert.deepEqual(sortRefsDesc(['1.2', 'v1.12', 'main', '1.2.3-beta.1', 'v1.2.3']), [
    'v1.12',
    'v1.2.3',
    '1.2.3-beta.1',
    '1.2',
    'main',
  ]);
});

test('build metadata is ignored for precedence', () => {
  assert.equal(compareRefsDesc('1.2.3+build.5', '1.2.3'), 0);
  assert.deepEqual(sortRefsDesc(['1.2.3', '1.2.3+build.5']), ['1.2.3', '1.2.3+build.5']);
  assert.deepEqual(sortRefsDesc(['1.2.3+build.5', '1.2.3']), ['1.2.3+build.5', '1.2.3']);
});

test('edge refs never throw and sort last', () => {
  const edge = ['', 'v', '-1.2.3', '1.2.3-', '1.2.x'];
  assert.doesNotThrow(() => sortRefsDesc(edge));
  for (const ref of edge) assert.equal(parseVersionRef(ref), undefined);
  assert.deepEqual(sortRefsDesc(['1.2.3', ...edge]), ['1.2.3', ...edge]);
});

test('compareRefsDesc: parsed before unknown, unknown vs unknown stable', () => {
  assert.ok(compareRefsDesc('1.2.3', 'main') < 0);
  assert.ok(compareRefsDesc('main', '1.2.3') > 0);
  assert.equal(compareRefsDesc('main', 'dev'), 0);
});

test('sortRefsDesc returns a new array and does not mutate its input', () => {
  const input = ['1.2', 'main', 'v1.12'];
  const copy = [...input];
  const out = sortRefsDesc(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, copy);
  assert.deepEqual(out, ['v1.12', '1.2', 'main']);
});
