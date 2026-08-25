import * as vscode from 'vscode';
import type { FeatureDeps } from '../core/types';
import { releasesList } from '../serve/methods';
import type { ReleaseInfo } from '../serve/protocol';
import { DepNode, errMsg, getClient } from './depsTree';
import { applyDepRef } from './depRefEdit';

interface RefPick extends vscode.QuickPickItem {
  readonly ref?: string;
  readonly toggle?: boolean;
}

async function showReleases(deps: FeatureDeps, node: DepNode): Promise<void> {
  const client = await getClient(deps, node.project);
  if (!client) return;

  let tags = false;
  for (;;) {
    let entries: readonly ReleaseInfo[];
    try {
      entries = await releasesList(client, { repo: node.dep.repo, limit: 15, tags });
    } catch (err) {
      void vscode.window.showErrorMessage(`AMXB: releases.list failed: ${errMsg(err)}`);
      return;
    }
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(`AMXB: no ${tags ? 'tags' : 'releases'} found for ${node.dep.repo}`);
      return;
    }
    const toggleLabel = tags ? '$(github) Show releases instead' : '$(tag) Show tags instead';
    const picks: RefPick[] = [
      { label: toggleLabel, toggle: true },
      ...entries.map((entry): RefPick => {
        const pick: RefPick = { label: `$(tag) ${entry.tag}`, ref: entry.tag };
        const description = [entry.name, entry.published].filter(Boolean).join(' · ');
        if (description) pick.description = description;
        return pick;
      }),
    ];
    const picked = await vscode.window.showQuickPick(picks, { placeHolder: `${node.dep.repo} — pick a ref` });
    if (!picked) return;
    if (picked.toggle) {
      tags = !tags;
      continue;
    }
    if (picked.ref !== undefined) await applyDepRef(deps, node, picked.ref);
    return;
  }
}

function isDepNode(arg: unknown): arg is DepNode {
  return arg instanceof DepNode;
}

export function register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('amxb.showReleases', (arg?: unknown) => {
      if (isDepNode(arg)) void showReleases(deps, arg);
    }),
    vscode.commands.registerCommand('amxb.setDepRef', async (arg?: unknown) => {
      if (!isDepNode(arg)) return;
      const ref = await vscode.window.showInputBox({ prompt: `Ref for ${arg.dep.repo}`, value: arg.dep.ref });
      if (ref && ref.trim()) await applyDepRef(deps, arg, ref.trim());
    }),
    vscode.commands.registerCommand('amxb.openDepOnGithub', (arg?: unknown) => {
      if (isDepNode(arg)) {
        void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${arg.dep.repo}`));
      }
    }),
  ];
}
