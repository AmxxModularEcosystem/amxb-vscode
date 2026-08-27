import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyRepoError, existsFalseMessage } from '../src/features/repoSuggestErrors';

test('releases.list 404 with "Ref not found" maps to ref_not_found', () => {
  const info = classifyRepoError(
    {
      code: -32603,
      message: 'Ref not found: nope',
      data: { status: 404, repo: 'A/B', message: 'Ref not found: nope' },
    },
    'A/B',
  );
  assert.equal(info.kind, 'ref_not_found');
  assert.equal(info.message, 'ref не найден: A/B');
});

test('releases.list 404 on a nonexistent repo maps to not_found', () => {
  const info = classifyRepoError(
    {
      code: -32603,
      message: 'Not Found',
      data: { status: 404, repo: 'X/Y', message: 'Not Found' },
    },
    'X/Y',
  );
  assert.equal(info.kind, 'not_found');
  assert.ok(info.message.includes('не существует или нет доступа'));
});

test('403 and 429 map to rate_limited', () => {
  const for403 = classifyRepoError(
    {
      code: -32603,
      message: '...',
      data: { status: 403, repo: 'X/Y', message: 'rate limit' },
    },
    'X/Y',
  );
  assert.equal(for403.kind, 'rate_limited');
  assert.equal(for403.message, 'GitHub rate limit — повторите позже');

  const for429 = classifyRepoError(
    {
      code: -32603,
      message: '...',
      data: { status: 429, repo: 'X/Y', message: 'rate limit' },
    },
    'X/Y',
  );
  assert.equal(for429.kind, 'rate_limited');
});

test('data.status null falls through to other', () => {
  const info = classifyRepoError(
    {
      code: -32603,
      message: 'boom',
      data: { status: null, repo: 'X/Y', message: 'boom' },
    },
    'X/Y',
  );
  assert.equal(info.kind, 'other');
  assert.equal(info.message, 'boom');
});

test('data absent (RpcError with only code + message) maps to other via err.message', () => {
  const info = classifyRepoError({ code: -32603, message: 'no data here' }, 'X/Y');
  assert.equal(info.kind, 'other');
  assert.equal(info.message, 'no data here');
});

test('plain Error maps to other with its message', () => {
  const info = classifyRepoError(new Error('network'), 'A/B');
  assert.equal(info.kind, 'other');
  assert.equal(info.message, 'network');
});

test('string errors map to other with the string as message', () => {
  const info = classifyRepoError('something went wrong', 'A/B');
  assert.equal(info.kind, 'other');
  assert.equal(info.message, 'something went wrong');
});

test('undefined never throws and maps to other', () => {
  assert.doesNotThrow(() => classifyRepoError(undefined, 'A/B'));
  const info = classifyRepoError(undefined, 'A/B');
  assert.equal(info.kind, 'other');
});

test('null maps to other without throwing', () => {
  const info = classifyRepoError(null, 'A/B');
  assert.equal(info.kind, 'other');
});

test('existsFalseMessage returns the fixed wording', () => {
  assert.equal(existsFalseMessage('A/B'), 'не существует или нет доступа: A/B');
});
