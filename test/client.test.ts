import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ServeClient, RpcError } from '../src/serve/client';

const fixtureDir = path.join(__dirname, 'fixtures');
const fakeServer = path.join(fixtureDir, 'fake-serve.js');

function createClient(): ServeClient {
  return new ServeClient({
    command: process.execPath,
    args: [fakeServer],
    cwd: fixtureDir,
    spawnRetries: 3,
    spawnRetryDelayMs: 100,
    requestTimeoutMs: 2_000,
  });
}

test('ServeClient.ping returns the server version', async () => {
  const client = createClient();
  await client.start();
  try {
    const result = await client.request<{ ok: boolean; version: string }>('serve.ping');
    assert.equal(result.ok, true);
    assert.equal(result.version, '1.5.2');
  } finally {
    await client.stop();
  }
});

test('ServeClient.echo round-trips params', async () => {
  const client = createClient();
  await client.start();
  try {
    const result = await client.request<{ hello: string }>('echo', { hello: 'world' });
    assert.equal(result.hello, 'world');
  } finally {
    await client.stop();
  }
});

test('ServeClient maps error responses to RpcError with code', async () => {
  const client = createClient();
  await client.start();
  try {
    await assert.rejects(
      client.request('fail'),
      (err: unknown) => err instanceof RpcError && err.code === -32602 && err.message === 'boom',
    );
  } finally {
    await client.stop();
  }
});

test('ServeClient dispatches push notifications without blocking', async () => {
  const client = createClient();
  await client.start();
  const received: Array<{ method: string; params: unknown }> = [];
  const unsubscribe = client.onNotify((method, params) => received.push({ method, params }));
  try {
    await client.request('notify.test', { value: 42 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.method, 'test.event');
    assert.deepEqual(received[0]?.params, { value: 42 });
  } finally {
    unsubscribe();
    await client.stop();
  }
});

test('ServeClient times out on requests without response', async () => {
  const client = createClient();
  await client.start();
  try {
    await assert.rejects(
      client.request('slow', undefined, { timeoutMs: 100 }),
      (err: unknown) => err instanceof RpcError && err.message.includes('timed out'),
    );
  } finally {
    await client.stop();
  }
});

test('ServeClient rejects in-flight requests on stop()', async () => {
  const client = createClient();
  await client.start();
  const inflight = client.request('slow'); // never answers
  const rejection = assert.rejects(
    inflight,
    (err: unknown) => err instanceof RpcError && err.message.includes('stopped'),
  );
  await client.stop();
  await rejection;
});

test('ServeClient fires onExit and rejects pending on server crash', async () => {
  const client = createClient();
  await client.start();
  const exits: Array<{ code: number | null; signal: string | null }> = [];
  const unsubscribe = client.onExit((info) => exits.push({ code: info.code, signal: info.signal }));
  try {
    const inflight = client.request('crash');
    await assert.rejects(inflight, (err: unknown) => err instanceof RpcError && err.code === -32000);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.code, 1);
  } finally {
    unsubscribe();
    await client.stop();
  }
});

test('ServeClient.start throws a descriptive error when the process exits immediately', async () => {
  const client = new ServeClient({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    cwd: fixtureDir,
    spawnRetries: 2,
    spawnRetryDelayMs: 50,
  });
  await assert.rejects(client.start(), (err: unknown) => err instanceof RpcError && err.code === -32000);
});

test('ServeClient.running reflects process lifecycle', async () => {
  const client = createClient();
  assert.equal(client.running, false);
  await client.start();
  assert.equal(client.running, true);
  await client.stop();
  assert.equal(client.running, false);
});
