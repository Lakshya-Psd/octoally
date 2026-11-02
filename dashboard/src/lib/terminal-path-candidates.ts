/**
 * Finding file and folder paths in terminal text.
 *
 * Claude Code wraps its own output, so one path can be split over two or three
 * lines: at the space in "C:/Users/Windows 11/…", or mid-word when the path is
 * wider than the screen. findPathCandidates lists every way a path might read
 * (each place it could end, each way its lines could join); the caller asks the
 * disk which of them exist and keeps the longest with pickLinks.
 *
 * No imports, so node's test runner can load this file directly.
 */

/** A character's place in the lines: which line, and its index in that line. */
export interface TextPos { line: number; index: number }
/** One possible path: its first and last character, and the text with any line breaks joined. */
export interface PathCandidate { start: TextPos; end: TextPos; text: string }

type Kind = 'win' | 'posix' | 'relative';

// Never part of a path: quotes, backticks, tabs and the characters Windows forbids.
const NEVER = /["'`<>|?*\t]/;
// A path can't start right after these (that would be the middle of a word or path).
const NOT_BEFORE = /[\w/\\.:@~-]/;
// A path may end just before these; only a Windows path (which can hold spaces) reads on past them.
const MAY_END = /[),;\]}]/;
// A relative path needs a slash, or an extension with a letter in it ("1.5" is not a file).
const HAS_EXT = /\.(?=[A-Za-z0-9]{0,9}[A-Za-z])[A-Za-z0-9]{1,10}$/;
const MAX_JOINS = 2;
const MAX_LENGTH = 400;
const MAX_PER_START = 40;

function kindAt(line: string, i: number): Kind | null {
  if (i > 0 && NOT_BEFORE.test(line[i - 1])) return null;
  const head = line.slice(i, i + 3);
  if (/^[A-Za-z]:[\\/]/.test(head)) return 'win';
  if (/^\/[\w.@+~-]/.test(head)) return 'posix';
  if (/^(?:\.{1,2}[\\/]|\.?[\w@+-])/.test(head)) return 'relative';
  return null;
}

function scanFrom(lines: string[], line: number, index: number, kind: Kind, out: PathCandidate[]) {
  const start = { line, index };
  const seen = new Set<string>();

  const emit = (text: string, end: TextPos | null) => {
    if (!end || seen.size >= MAX_PER_START || /[.\s,;:]$/.test(text)) return;
    if (kind === 'win' && text.length < 4) return;
    if (kind === 'posix' && text.length < 2) return;
    if (kind === 'relative' && !/[\\/]/.test(text) && !HAS_EXT.test(text)) return;
    const key = `${text}@${end.line}:${end.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ start, end, text });
  };

  const walk = (text: string, li: number, i: number, last: TextPos | null, joins: number) => {
    const s = lines[li];
    for (; i < s.length; i++) {
      if (text.length > MAX_LENGTH || seen.size >= MAX_PER_START) return;
      const ch = s[i];
      const driveColon = kind === 'win' && li === line && i === index + 1;
      if (NEVER.test(ch) || (ch === ':' && !driveColon)) { emit(text, last); return; }
      if (/\s/.test(ch)) {
        emit(text, last);
        if (kind !== 'win' || i + 1 >= s.length || /\s/.test(s[i + 1])) return;
      } else if (MAY_END.test(ch)) {
        emit(text, last);
        if (kind !== 'win') return;
      } else if (ch === '.' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
        emit(text, last); // a sentence may end here
      }
      text += ch;
      last = { line: li, index: i };
    }
    emit(text, last);
    // The line ran out mid-path: Claude may have carried it onto the next line.
    if (joins >= MAX_JOINS || li + 1 >= lines.length) return;
    const next = lines[li + 1].search(/\S/);
    if (next < 0) return;
    if (kind === 'win') walk(`${text} `, li + 1, next, last, joins + 1); // broken at a space
    walk(text, li + 1, next, last, joins + 1); // broken mid-word
  };

  walk('', line, index, null, 0);
}

/** Every way a path might be read from these lines (most won't exist on disk). */
export function findPathCandidates(lines: string[]): PathCandidate[] {
  const out: PathCandidate[] = [];
  lines.forEach((s, li) => {
    for (let i = 0; i < s.length; i++) {
      const kind = kindAt(s, i);
      if (kind) scanFrom(lines, li, i, kind, out);
    }
  });
  return out;
}

const before = (a: TextPos, b: TextPos) => a.line < b.line || (a.line === b.line && a.index < b.index);

/**
 * From candidates that exist on disk, keep the longest one for each start and
 * drop any that begin inside a path already kept.
 */
export function pickLinks<T extends PathCandidate>(found: T[]): T[] {
  const sorted = [...found].sort((a, b) =>
    before(a.start, b.start) ? -1 : before(b.start, a.start) ? 1 : b.text.length - a.text.length);
  const kept: T[] = [];
  for (const c of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && !before(prev.end, c.start)) continue;
    kept.push(c);
  }
  return kept;
}
