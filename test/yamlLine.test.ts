import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findLineForPointer } from '../src/util/yamlLine';

const SAMPLE = `name: MyProject
version: "1.0.0"

amxmodx:
  version: "1.10.5428"
  defines:
    - DEBUG
    - VERSION=1.2.3

deps:
  - AmxxModularEcosystem/ParamsController@1.4.2
  - repo: rehlds/ReAPI
    ref: 5.29.0.358
    source: release
    include_path: addons/amxmodx/scripting/include

plugins:
  - match: CWAPI-A-Test.sma
    enabled: false

deploy:
  exclude:
    - addons/amxmodx/configs/
`;

const LINES = SAMPLE.split('\n'); // 1-based: LINES[0] is line 1

function lineOf(pointer: string): number {
  return findLineForPointer(SAMPLE, pointer);
}

test('root pointer maps to line 1', () => {
  assert.equal(lineOf('(root)'), 1);
  assert.equal(lineOf(''), 1);
  assert.equal(lineOf('/'), 1);
});

test('top-level key maps to its line', () => {
  assert.equal(lineOf('/name'), 1);
  assert.equal(lineOf('/version'), 2);
  assert.equal(lineOf('/amxmodx'), 4);
});

test('nested key maps to its line', () => {
  assert.equal(lineOf('/amxmodx/version'), 5);
  assert.equal(lineOf('/amxmodx/defines'), 6);
});

test('array index maps to the item line', () => {
  assert.equal(lineOf('/deps/0'), 11);
  assert.equal(lineOf('/deps/1'), 12);
  assert.equal(lineOf('/plugins/0'), 18);
});

test('nested key inside array item maps to its own line', () => {
  assert.equal(lineOf('/deps/1/ref'), 13);
  assert.equal(lineOf('/deps/1/source'), 14);
  assert.equal(lineOf('/plugins/0/enabled'), 19);
});

test('missing segment falls back to the last found parent', () => {
  // /amxmodx/bogus is not present; fall back to the /amxmodx line (4).
  assert.equal(lineOf('/amxmodx/bogus'), 4);
  // /nothing is not present; fall back to line 1.
  assert.equal(lineOf('/nothing'), 1);
});

test('quoted keys and plain scalars in lists still map', () => {
  assert.equal(lineOf('/deploy/exclude/0'), 23);
});
