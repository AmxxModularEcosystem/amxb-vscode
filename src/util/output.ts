import * as vscode from 'vscode';

/** Timestamped OutputChannel wrapper used by all features. */
export interface AmxbOutput {
  readonly channel: vscode.OutputChannel;
  /** Write a timestamped line to the channel. */
  readonly log: (message: string) => void;
  /** Write raw text (no timestamp, no newline). */
  readonly append: (text: string) => void;
  /** Write a blank line. */
  readonly line: () => void;
  /** Reveal the channel. */
  readonly show: (preserveFocus?: boolean) => void;
  readonly clear: () => void;
}

export function createAmxbOutput(name = 'AMXB'): AmxbOutput {
  const channel = vscode.window.createOutputChannel(name);

  function log(message: string): void {
    const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
    channel.appendLine(`[${ts}] ${message}`);
  }

  return {
    channel,
    log,
    append: (text: string) => channel.append(text),
    line: () => channel.appendLine(''),
    show: (preserveFocus = true) => channel.show(preserveFocus),
    clear: () => channel.clear(),
  };
}
