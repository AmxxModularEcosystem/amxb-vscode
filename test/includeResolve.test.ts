import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseIncludes,
  isUnderRoot,
  projectIncludeDirs,
  resolveIncludeLocal,
  repairDepGraph,
} from '../src/util/includeResolve';
import type { DepGraphResult } from '../src/serve/protocol';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-inc-'));
  fs.mkdirSync(path.join(root, 'amxmodx', 'scripting', 'include'), { recursive: true });
  fs.mkdirSync(path.join(root, 'amxmodx', 'scripting', 'Cwapi', 'Core'), { recursive: true });
  return root;
}

test('parseIncludes extracts angle and quoted includes', () => {
  const text = [
    '#include <amxmodx>',
    '#include "Cwapi/Utils"',
    '  #include <reapi>   // trailing comment',
    '// #include <commented>',
    '#include "already.inc"',
  ].join('\n');
  const result = parseIncludes(text);
  assert.deepEqual(result, [
    { name: 'amxmodx', isAngle: true },
    { name: 'Cwapi/Utils', isAngle: false },
    { name: 'reapi', isAngle: true },
    { name: 'already.inc', isAngle: false },
  ]);
});

test('isUnderRoot distinguishes project files from cache files', () => {
  const root = '/proj';
  assert.equal(isUnderRoot(root, '/proj/amxmodx/scripting/a.sma'), true);
  assert.equal(isUnderRoot(root, '/proj/amxmodx/scripting/include/x.inc'), true);
  assert.equal(isUnderRoot(root, '/home/cache/repos/x/a.inc'), false);
  assert.equal(isUnderRoot(root, '/proj'), false);
});

test('projectIncludeDirs returns scripting include and scripting dirs', () => {
  assert.deepEqual(projectIncludeDirs('/p'), [
    path.join('/p', 'amxmodx', 'scripting', 'include'),
    path.join('/p', 'amxmodx', 'scripting'),
  ]);
});

test('resolveIncludeLocal finds files with and without .inc extension', () => {
  const root = makeProject();
  const includeDir = path.join(root, 'amxmodx', 'scripting', 'include');
  const scripting = path.join(root, 'amxmodx', 'scripting');
  fs.writeFileSync(path.join(includeDir, 'cwapi.inc'), '');
  fs.writeFileSync(path.join(scripting, 'Cwapi', 'DebugMode.inc'), '');

  assert.equal(resolveIncludeLocal('cwapi', true, [includeDir]), path.join(includeDir, 'cwapi.inc'));
  assert.equal(resolveIncludeLocal('Cwapi/DebugMode', false, [scripting]), path.join(scripting, 'Cwapi', 'DebugMode.inc'));
  assert.equal(resolveIncludeLocal('nope', true, [includeDir]), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repairDepGraph resolves project-local angle includes and sma-relative quoted includes', () => {
  const root = makeProject();
  const scripting = path.join(root, 'amxmodx', 'scripting');
  const includeDir = path.join(scripting, 'include');
  const sma = path.join(scripting, 'Custom.sma');
  const utils = path.join(scripting, 'Cwapi', 'Utils.inc');
  const debugMode = path.join(scripting, 'Cwapi', 'DebugMode.inc');
  fs.writeFileSync(path.join(includeDir, 'cwapi.inc'), '#include "Cwapi/DebugMode"\n');
  fs.writeFileSync(sma, '#include <cwapi>\n');
  fs.writeFileSync(utils, '#include "Cwapi/DebugMode"\n');
  fs.writeFileSync(debugMode, '');

  const result: DepGraphResult = {
    sma_file: sma,
    version: '1.10.5428',
    include_dirs: [],
    files: [{ file: sma, isSma: true, includes: [] }],
    missing: [
      { file: sma, name: 'cwapi', isAngle: true },
      { file: utils, name: 'Cwapi/DebugMode', isAngle: false },
    ],
  };

  const repaired = repairDepGraph(result, sma, root);
  const smaEntry = repaired.files.find((f) => f.file === sma);
  assert.ok(smaEntry?.includes.includes(path.join(includeDir, 'cwapi.inc')));
  const utilsEntry = repaired.files.find((f) => f.file === utils);
  assert.ok(utilsEntry?.includes.includes(debugMode));
  assert.deepEqual(repaired.missing, []);
  const cwapiEntry = repaired.files.find((f) => f.file.endsWith('include/cwapi.inc'));
  assert.ok(cwapiEntry, 'newly discovered cwapi.inc must be parsed and added');
  assert.ok(cwapiEntry?.includes.includes(debugMode), 'cwapi.inc includes resolved sma-relative');
});

test('repairDepGraph keeps genuinely missing includes', () => {
  const root = makeProject();
  const scripting = path.join(root, 'amxmodx', 'scripting');
  const sma = path.join(scripting, 'Custom.sma');
  fs.writeFileSync(sma, '#include <does_not_exist>\n');

  const result: DepGraphResult = {
    sma_file: sma,
    version: '1.10.5428',
    include_dirs: [],
    files: [{ file: sma, isSma: true, includes: [] }],
    missing: [{ file: sma, name: 'does_not_exist', isAngle: true }],
  };

  const repaired = repairDepGraph(result, sma, root);
  assert.deepEqual(repaired.missing, [{ file: sma, name: 'does_not_exist', isAngle: true }]);
  fs.rmSync(root, { recursive: true, force: true });
});
