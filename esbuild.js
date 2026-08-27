'use strict';

// Build script: bundles the extension to dist/extension.js and the tests to
// out-test/ (CJS, node:test compatible). Run `node esbuild.js [--watch]`.

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  external: ['vscode'],
  outfile: 'dist/extension.js',
  logLevel: 'info',
};

const testConfig = {
  entryPoints: [
    'test/client.test.ts',
    'test/parseCompiler.test.ts',
    'test/yamlLine.test.ts',
    'test/manifestSearch.test.ts',
    'test/includeResolve.test.ts',
    'test/repoSuggestContext.test.ts',
    'test/repoSuggestCache.test.ts',
    'test/repoSuggestErrors.test.ts',
    'test/refSort.test.ts',
    'test/integration.serve.test.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  outdir: 'out-test',
  logLevel: 'info',
};

async function main() {
  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const testCtx = await esbuild.context(testConfig);
    await Promise.all([extCtx.watch(), testCtx.watch()]);
    console.log('[esbuild] watching...');
    return;
  }
  await esbuild.build(extensionConfig);
  await esbuild.build(testConfig);
  fs.cpSync(path.join(__dirname, 'test', 'fixtures'), path.join(__dirname, 'out-test', 'fixtures'), { recursive: true });
  console.log('[esbuild] build complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
