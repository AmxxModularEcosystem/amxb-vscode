import * as vscode from 'vscode';

/**
 * Shared build/watch lifecycle state, driven by features (build.ts, watchMode.ts)
 * and consumed by the status bar and diagnostics listeners.
 */

export type BuildState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'building'; readonly stage: string; readonly projectName: string }
  | { readonly kind: 'watching'; readonly projectName: string }
  | { readonly kind: 'error'; readonly message: string; readonly projectName?: string };

/** Raw serve notifications received while a build is running. */
export type BuildEvent =
  | { readonly kind: 'stage'; readonly stage: string; readonly message: string }
  | { readonly kind: 'progress'; readonly label: string; readonly current: number; readonly total: number }
  | {
      readonly kind: 'compiled';
      readonly baseName: string;
      readonly ok: boolean;
      readonly output?: string;
      readonly amxxName?: string;
      readonly repo?: string;
      readonly ref?: string;
    }
  | { readonly kind: 'done'; readonly ok: boolean; readonly elapsed?: string; readonly message?: string };

export interface BuildBus {
  readonly onBuildStateChange: vscode.Event<BuildState>;
  readonly getBuildState: () => BuildState;
  readonly setBuildState: (state: BuildState) => void;
  readonly onBuildEvent: vscode.Event<BuildEvent>;
  readonly emitBuildEvent: (event: BuildEvent) => void;
}

export function createBuildBus(): BuildBus {
  const stateEmitter = new vscode.EventEmitter<BuildState>();
  const eventEmitter = new vscode.EventEmitter<BuildEvent>();
  let current: BuildState = { kind: 'idle' };

  return {
    onBuildStateChange: stateEmitter.event,
    getBuildState: () => current,
    setBuildState: (state: BuildState) => {
      current = state;
      stateEmitter.fire(state);
    },
    onBuildEvent: eventEmitter.event,
    emitBuildEvent: (event: BuildEvent) => eventEmitter.fire(event),
  };
}
