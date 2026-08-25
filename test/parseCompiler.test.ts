import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCompilerOutput, outputIndicatesOk } from '../src/util/parseCompiler';

const SAMPLE_OK = `AMX Mod X Compiler 1.10.0.5428
Copyright (c) 1997-2006 ITB CompuPhase
Copyright (c) 2004-2013 AMX Mod X Team

/path/scripting/Cwapi/Core/CWeapons/Hooks.inc(126) : warning 217: loose indentation

Header size:          11380 bytes
Code size:           102520 bytes

Done.
`;

const SAMPLE_ERROR = `AMX Mod X Compiler 1.10.0.5428

/path/scripting/Broken.sma(12) : error 017: undefined symbol "foo"
/path/scripting/Broken.sma(20) : error 029: invalid expression, assumed zero

1 Error.
`;

const SAMPLE_MIXED_SUMMARY = `2 Errors, 5 Warnings.
`;

test('parseCompilerOutput parses warnings from a successful compile', () => {
  const result = parseCompilerOutput(SAMPLE_OK);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.length, 1);
  const diag = result.diagnostics[0];
  assert.equal(diag?.severity, 'warning');
  assert.equal(diag?.line, 126);
  assert.equal(diag?.code, 217);
  assert.equal(diag?.message, 'loose indentation');
});

test('parseCompilerOutput flags errors and extracts all diagnostics', () => {
  const result = parseCompilerOutput(SAMPLE_ERROR);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(
    result.diagnostics.map((d) => [d.severity, d.code, d.line]),
    [['error', 17, 12], ['error', 29, 20]],
  );
});

test('parseCompilerOutput handles Windows-style paths', () => {
  const output = String.raw`C:\servers\amxmodx\scripting\Foo.sma(4) : error 017: undefined symbol "x"
1 Error.
`;
  const result = parseCompilerOutput(output);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.file, String.raw`C:\servers\amxmodx\scripting\Foo.sma`);
});

test('parseCompilerOutput parses the errors/warnings trailer', () => {
  const result = parseCompilerOutput(SAMPLE_MIXED_SUMMARY);
  assert.deepEqual(result.summary, { errors: 2, warnings: 5 });
  assert.equal(result.ok, false);
});

test('parseCompilerOutput tolerates a lone summary without diagnostics', () => {
  const result = parseCompilerOutput('0 Errors.\n');
  assert.equal(result.summary?.errors, 0);
  assert.equal(result.ok, true);
});

test('outputIndicatesOk is true only for Done./error-free output', () => {
  assert.equal(outputIndicatesOk(SAMPLE_OK), true);
  assert.equal(outputIndicatesOk(SAMPLE_ERROR), false);
  assert.equal(outputIndicatesOk(''), false);
});
