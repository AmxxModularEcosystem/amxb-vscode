/**
 * Best-effort mapping of a JSON pointer (as returned by manifest.validate
 * error `path` fields, e.g. `/name`, `/amxmodx/version`, `/deps/0/ref`) to a
 * 1-based line number in the YAML manifest text.
 *
 * Used only for placing diagnostics on the right line; falls back to the last
 * known parent line (or line 1) when a pointer segment cannot be located.
 * The served error message text remains the authoritative diagnostic content.
 */

function indentOf(line: string): number {
  const m = /^\s*/.exec(line);
  return m?.[0]?.length ?? 0;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Find an object key `key` with indentation > minIndent, starting at `start`. */
function findKey(lines: readonly string[], start: number, key: string, minIndent: number): number {
  for (let i = Math.max(0, start); i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^(\s*)([^#\s][^:]*?):(\s|$)/.exec(line);
    if (!m) continue;
    const li = m[1]!.length;
    if (li <= minIndent) return -1; // dedented past the parent block
    if (m[2]!.trim() === key) return i;
  }
  return -1;
}

/** Find the (index)-th `- ` list item with indentation >= minIndent, starting at `start`. */
function findListItem(lines: readonly string[], start: number, index: number, minIndent: number): number {
  let seen = 0;
  for (let i = Math.max(0, start); i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const item = /^(\s*)-\s*/.exec(line);
    if (!item) {
      if (indentOf(line) <= minIndent) return -1; // left the parent block
      continue;
    }
    if (item[1]!.length < minIndent) return -1;
    if (seen === index) return i;
    seen++;
  }
  return -1;
}

export function findLineForPointer(yamlText: string, pointer: string): number {
  if (!pointer || pointer === '(root)' || pointer === '/') return 1;
  const segments = pointer.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return 1;

  const lines = yamlText.split(/\r?\n/);
  let cursor = -1; // previous located line (last found key/item)
  let minIndent = -1; // next key must be indented deeper than this
  let lastFound = 0;

  for (const rawSegment of segments) {
    const segment = decodePointerSegment(rawSegment);
    if (/^\d+$/.test(segment)) {
      const itemLine = findListItem(lines, cursor + 1, Number(segment), minIndent);
      if (itemLine === -1) return lastFound + 1;
      lastFound = itemLine;
      cursor = itemLine;
      minIndent = indentOf(lines[itemLine] ?? '');
      continue;
    }
    const keyLine = findKey(lines, cursor + 1, segment, minIndent);
    if (keyLine === -1) return lastFound + 1;
    lastFound = keyLine;
    cursor = keyLine;
    minIndent = indentOf(lines[keyLine] ?? '');
  }

  return lastFound + 1; // 1-based line number
}
