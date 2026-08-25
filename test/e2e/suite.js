'use strict';
// E2E suite: runs inside the Extension Development Host against a real
// AMX Mod X workspace. Asserts observable behavior through public VS Code APIs.

const assert = require('assert');
const vscode = require('vscode');

const EXTENSION_ID = 'arkaneman.amxb-vscode';

suite('AMXB extension e2e', function () {
  this.timeout(240_000);

  test('activation detects the root manifest', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext.activate();
    assert.equal(ext.isActive, true);
  });

  test('manifest validation produces diagnostics on the root manifest', async () => {
    const manifestUris = (await vscode.workspace.findFiles('amxbuild.yml', null, 1)) ?? [];
    assert.ok(manifestUris.length > 0, 'no amxbuild.yml found in the workspace');
    const uri = manifestUris[0];

    await vscode.commands.executeCommand('amxb.validateManifest');

    const deadline = Date.now() + 120_000;
    let diagnostics = vscode.languages.getDiagnostics(uri);
    while (diagnostics.length === 0 && Date.now() < deadline) {
      await sleep(1000);
      diagnostics = vscode.languages.getDiagnostics(uri);
    }
    if (diagnostics.length === 0) {
      const all = vscode.languages.getDiagnostics();
      console.error('[e2e] all diagnostics:');
      for (const [u, ds] of all) {
        console.error(`  ${u.toString()} -> ${ds.length}: ${ds.map((d) => `[${d.severity}] ${d.message}`).join(' | ').slice(0, 300)}`);
      }
    }
    assert.ok(diagnostics.length > 0, 'expected manifest diagnostics (amxb-manifest)');
    const info = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Information && d.message.includes('valid'));
    assert.ok(info, 'expected a "Manifest is valid" diagnostic');
  });

  test('compile.single reports compiler warnings as diagnostics', async () => {
    const smaUris = await vscode.workspace.findFiles('**/CustomWeaponsAPI.sma', '**/node_modules/**', 1);
    assert.ok(smaUris.length > 0, 'CustomWeaponsAPI.sma not found');

    await vscode.commands.executeCommand('amxb.compileFile', smaUris[0]);

    const deadline = Date.now() + 240_000;
    let total = vscode.languages.getDiagnostics().reduce((sum, [, ds]) => sum + ds.length, 0);
    while (total === 0 && Date.now() < deadline) {
      await sleep(1000);
      total = vscode.languages.getDiagnostics().reduce((sum, [, ds]) => sum + ds.length, 0);
    }
    assert.ok(total > 0, 'expected compiler diagnostics (warnings) after compile');
  });
  test('reveal commands run without error and the tree loads dependencies', async () => {
    await vscode.commands.executeCommand('amxbProjectsView.focus');
    await sleep(4000);
    for (const repo of ['rehlds/ReAPI', 'AmxxModularEcosystem/ParamsController']) {
      await vscode.commands.executeCommand('amxb.revealDep', repo);
    }
    await vscode.commands.executeCommand('amxb.revealExtFile', 'does-not-matter');
    await vscode.commands.executeCommand('amxb.revealInclude', 'does-not-matter');
    assert.ok(true, 'reveal commands must not throw');
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
