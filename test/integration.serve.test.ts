import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ServeClient } from '../src/serve/client';
import { resolveServeBinary } from '../src/serve/binary';
import {
  manifestValidate,
  manifestResolve,
  depsTree,
  compileSingle,
  ping,
  compilerInfo,
  buildPlan,
  watchStart,
  watchStop,
  includeList,
  depGraph,
} from '../src/serve/methods';
import { repairDepGraph } from '../src/util/includeResolve';

/**
 * Integration tests against a real `amxb serve` process.
 * Each test skips itself when the amxb binary or the sample project is missing.
 */

interface TestEnv {
  readonly amxb: string;
  readonly projectDir: string;
  readonly manifest: string;
}

async function findAmxb(): Promise<string | undefined> {
  const candidates = process.platform === 'win32' ? ['amxb.cmd', 'amxb'] : ['amxb'];
  for (const name of candidates) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir.trim(), name);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

function findTestProject(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return undefined;
  const candidates = [
    path.join(home, '.cache', 'amxb-vsc-test', 'CustomWeaponsAPI'),
    path.join(home, 'AppData', 'Local', 'Temp', 'amxb-vsc-test', 'CustomWeaponsAPI'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'amxbuild.yml')));
}

let envPromise: Promise<TestEnv | undefined> | undefined;
function env(): Promise<TestEnv | undefined> {
  if (!envPromise) {
    envPromise = (async () => {
      const amxb = await findAmxb();
      const projectDir = findTestProject();
      if (!amxb || !projectDir) return undefined;
      return { amxb, projectDir, manifest: path.join(projectDir, 'amxbuild.yml') };
    })();
  }
  return envPromise;
}

async function withClient(e: TestEnv, fn: (client: ServeClient) => Promise<void>): Promise<void> {
  const lookup = await resolveServeBinary(undefined);
  if (!lookup.info) throw new Error('amxb binary not found');
  const client = new ServeClient({
    command: lookup.info.command,
    args: lookup.info.args,
    cwd: e.projectDir,
    shell: lookup.info.needsShell,
    spawnRetries: 5,
  });
  await client.start();
  try {
    await fn(client);
  } finally {
    await client.stop();
  }
}

test('integration: serve.ping works against a real amxb', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await ping(client);
    assert.equal(result.ok, true);
    assert.equal(result.version, '1.5.2');
  });
});

test('integration: manifest.validate returns valid for the sample project', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await manifestValidate(client, e.manifest);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });
});

test('integration: manifest.resolve merges defaults and exposes globalDeps', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await manifestResolve(client, e.manifest);
    assert.equal(result.name, 'CustomWeaponsAPI');
    assert.ok(result.globalDeps.length >= 2);
    assert.equal(result.globalDeps[0]?.repo, 'AmxxModularEcosystem/ParamsController');
  });
});

test('integration: deps.tree returns the dependency tree without fetching', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await depsTree(client, { manifest: e.manifest, noFetch: true });
    assert.ok(result.dependencies.length >= 2);
    for (const dep of result.dependencies) {
      assert.equal(typeof dep.repo, 'string');
      assert.equal(dep.cycle, false);
    }
  });
});

test('integration: compiler.info works from cache', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await compilerInfo(client, { manifest: e.manifest, noFetch: true });
    assert.equal(result.version, '1.10.5428');
  });
});

test('integration: build.plan returns a structured plan', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await buildPlan(client, { manifest: e.manifest });
    assert.equal(result.name, 'CustomWeaponsAPI');
    assert.ok(result.output.target);
  });
});

test('integration: compile.single compiles the sample plugin (cache only)', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const sma = path.join(e.projectDir, 'amxmodx', 'scripting', 'CustomWeaponsAPI.sma');
    const result = await compileSingle(client, { sma_file: sma, manifest: e.manifest, noFetch: true }, { timeoutMs: 120_000 });
    assert.equal(result.ok, true);
    assert.equal(result.amxxName, 'CustomWeaponsAPI.amxx');
    assert.ok(result.output_path && fs.existsSync(result.output_path));
  });
});

test('integration: include.list exposes an absolute include_dir per dep', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const result = await includeList(client, { manifest: e.manifest, noFetch: true });
    assert.ok(result.deps.length >= 2);
    for (const dep of result.deps) {
      assert.equal(typeof dep.repo, 'string');
      assert.equal(typeof dep.include_dir, 'string');
      assert.ok(path.isAbsolute(dep.include_dir as string));
    }
  });
});

test('integration: dep-graph.get returns the full include closure from a .sma', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const sma = path.join(e.projectDir, 'amxmodx', 'scripting', 'CustomWeaponsAPI.sma');
    const result = await depGraph(client, { sma_file: sma, manifest: e.manifest, noFetch: true });
    assert.equal(result.sma_file, sma);
    const smaEntry = result.files.find((f) => f.file === sma);
    assert.ok(smaEntry, 'the .sma itself must be present in files');
    assert.equal(smaEntry?.isSma, true);
    assert.ok((smaEntry?.includes.length ?? 0) >= 1);
    const withIncludes = result.files.filter((f) => f.includes.length > 0);
    assert.ok(withIncludes.length >= 1, 'some files must have nested includes');
    for (const f of result.files) {
      assert.ok(path.isAbsolute(f.file));
      for (const inc of f.includes) assert.ok(path.isAbsolute(inc));
    }
    assert.ok(Array.isArray(result.missing));
  });
});

test('integration: repairDepGraph resolves project-local includes dep-graph misses', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const sma = path.join(e.projectDir, 'amxmodx', 'scripting', 'CustomWeaponsAPI.sma');
    const raw = await depGraph(client, { sma_file: sma, manifest: e.manifest, noFetch: true });
    assert.ok(raw.missing.some((m) => m.name === 'cwapi'), 'dep-graph should miss <cwapi> (server include-dir gap)');
    const repaired = repairDepGraph(raw, sma, e.projectDir);
    assert.equal(repaired.missing.filter((m) => m.name === 'cwapi').length, 0, '<cwapi> resolved after repair');
    assert.ok(
      repaired.files.some((f) => f.file.endsWith(path.join('scripting', 'include', 'cwapi.inc'))),
      'cwapi.inc present in the repaired graph',
    );
  });
});

test('integration: watch.start/stop round-trips', async (t) => {
  const e = await env();
  if (!e) return t.skip('amxb or test project not found');
  await withClient(e, async (client) => {
    const start = await watchStart(client, e.manifest);
    assert.equal(start.ok, true);
    assert.ok(start.watching);
    const stop = await watchStop(client);
    assert.equal(stop.ok, true);
  });
});
