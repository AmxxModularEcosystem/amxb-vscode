/**
 * Parse amxxpc (AMX Mod X compiler) text output into structured diagnostics.
 *
 * Output format (verified against amxb serve compile.single):
 *   /path/scripting/Foo.inc(343) : warning 217: loose indentation
 *   /path/scripting/Foo.sma(12) : error 017: undefined symbol "bar"
 *   ...
 *   1 Error.
 *   2 Warnings.
 */

export interface CompilerDiagnostic {
  /** Absolute or relative path printed by the compiler. */
  readonly file: string;
  /** 1-based line; null when the compiler did not report a line. */
  readonly line: number | null;
  readonly severity: 'error' | 'warning';
  readonly code: number;
  readonly message: string;
}

export interface CompilerOutputSummary {
  readonly errors: number;
  readonly warnings: number;
}

export interface ParseCompilerResult {
  readonly ok: boolean;
  readonly diagnostics: readonly CompilerDiagnostic[];
  /** Parsed "N Error(s), M Warning(s)." trailer, if present. */
  readonly summary: CompilerOutputSummary | undefined;
}

const DIAGNOSTIC_RE = /^(.*\.(?:sma|inc))\((\d+)\)\s*:\s*(error|warning)\s+(\d+):\s*(.*)$/gm;
const SUMMARY_RE = /^(\d+)\s+(?:Errors?|Warnings?)(?:,\s*(\d+)\s+(?:Errors?|Warnings?))?\.?$/m;

export function parseCompilerOutput(output: string): ParseCompilerResult {
  const diagnostics: CompilerDiagnostic[] = [];

  let match: RegExpExecArray | null;
  DIAGNOSTIC_RE.lastIndex = 0;
  while ((match = DIAGNOSTIC_RE.exec(output)) !== null) {
    const lineText = match[2];
    diagnostics.push({
      file: match[1] ?? '',
      line: lineText !== undefined && lineText !== '' ? Number(lineText) : null,
      severity: match[3] === 'error' ? 'error' : 'warning',
      code: Number(match[4] ?? 0),
      message: match[5] ?? '',
    });
  }

  const summaryMatch = output.match(SUMMARY_RE);
  let summary: CompilerOutputSummary | undefined;
  if (summaryMatch) {
    const a = Number(summaryMatch[1] ?? 0);
    const b = Number(summaryMatch[2] ?? 0);
    // The first number may be errors or warnings; the second is the other kind.
    const firstKindErrors = (summaryMatch[0].includes('Error') && !summaryMatch[0].startsWith('0'))
      || (summaryMatch[0].includes('Warning') && summaryMatch[0].indexOf('Error') === -1);
    summary = firstKindErrors ? { errors: a, warnings: b } : { errors: b, warnings: a };
  }

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const hasContent = output.trim().length > 0;
  const ok = hasContent && errorCount === 0 && (summary === undefined || summary.errors === 0);

  return { ok, diagnostics, summary };
}

/** True when the output indicates a successful compile (heuristic on the trailer). */
export function outputIndicatesOk(output: string): boolean {
  return /Done\.\s*$/.test(output.trimEnd()) || parseCompilerOutput(output).ok;
}
