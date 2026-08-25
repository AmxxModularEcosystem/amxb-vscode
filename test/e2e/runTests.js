#!/usr/bin/env node
'use strict';
// Launches the Extension Development Host and runs the e2e suite against it.
// Usage: node test/e2e/runTests.js [path-to-workspace]

const { runTests } = require('@vscode/test-electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const extensionPath = path.resolve(__dirname, '..', '..');
const workspaceArg = process.argv[2];

function defaultWorkspace() {
  const candidates = [
    path.join(extensionPath, '..', 'amxb-vsc-test-workspace'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'amxb-vsc-test', 'CustomWeaponsAPI'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'amxbuild.yml')));
}

/** Pick the first amxb binary on PATH that actually supports `serve`. */
function pickAmxb() {
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === 'win32' ? ['amxb.cmd', 'amxb'] : ['amxb']) {
      const candidate = path.join(dir.trim(), name);
      if (!fs.existsSync(candidate)) continue;
      try {
        const help = execFileSync(candidate, ['--help'], { encoding: 'utf8', timeout: 15_000 });
        if (help.includes('serve')) return candidate;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return undefined;
}

function prepareWorkspace(workspace) {
  const vscodeDir = path.join(workspace, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });
  const amxb = pickAmxb();
  if (!amxb) {
    console.error('No amxb binary with the `serve` command found on PATH.');
    process.exit(1);
  }
  console.log(`E2E amxb binary: ${amxb}`);
  const settingsPath = path.join(vscodeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ 'amxb.servePath': amxb }, null, 2));
  return settingsPath;
}

function cleanupWorkspace(settingsPath) {
  fs.rmSync(settingsPath, { force: true });
}

async function main() {
  const workspace = workspaceArg ? path.resolve(workspaceArg) : defaultWorkspace();
  if (!workspace || !fs.existsSync(path.join(workspace, 'amxbuild.yml'))) {
    console.error('No test workspace found. Clone CustomWeaponsAPI next to this repo or pass a path.');
    process.exit(1);
  }
  console.log(`E2E workspace: ${workspace}`);
  const settingsPath = prepareWorkspace(workspace);

  let result;
  try {
    result = await runTests({
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath: path.join(__dirname, 'index.js'),
      launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (err) {
    console.error('E2E FAILED:', err);
    process.exit(1);
  } finally {
    cleanupWorkspace(settingsPath);
  }
  console.log('E2E done, exit code:', result);
  process.exit(result ?? 0);
}

main();
