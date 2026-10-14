import type { FileSnapshot } from '../../shared/types.js';
import { hash, ToolError } from './paths.js';

export interface LineEdit { startLine: number; deleteCount: number; text: string }
/** Line intervals refer to the original file. Retained bytes, including CRLF,
 * remain untouched. Replacement text is literal, never a regex or command. */
export function patchSnapshot(before: FileSnapshot, edits: LineEdit[]): FileSnapshot {
  const lines = before.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let cursor = 0, previousStart = -1, content = '';
  for (const edit of edits) {
    const start = edit.startLine - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(edit.deleteCount) || start <= previousStart || start < cursor || start > lines.length || edit.deleteCount < 0 || start + edit.deleteCount > lines.length || typeof edit.text !== 'string') {
      throw new ToolError('Patch intervals must be ordered, nonoverlapping and inside the original file.');
    }
    content += lines.slice(cursor, start).join('') + edit.text;
    cursor = start + edit.deleteCount;
    previousStart = start;
  }
  content += lines.slice(cursor).join('');
  return { path: before.path, content, hash: hash(content) };
}
