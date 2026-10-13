/**
 * Clickable file paths in terminal output: when Claude prints
 * "Saved the video to C:\Users\me\proj\out\demo.mp4" or "updated src/App.tsx",
 * clicking the path opens it in OctoAlly's file viewer.
 *
 * Only paths that exist on disk become links (checked via /api/files/stat,
 * cached briefly), so words like "Node.js" or "v1.0" are never underlined.
 */
import type { IBufferCellPosition, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { api } from './api';
import { isAbsolutePath, joinPath, normalizePath } from './paths';

// The extension must contain a letter ("1.5" is not a file).
const EXT = '(?=[A-Za-z0-9]{0,9}[A-Za-z])[A-Za-z0-9]{1,10}';
// A path ends at whitespace, quotes, brackets, ":<line>" or a sentence-ending period.
const END = '(?=$|[\\s"\'`),;\\]>}]|:\\d|\\.(?:\\s|$))';
// Windows absolute paths may contain spaces ("C:\Users\Windows 11\..."): match
// lazily up to the first ".ext" that is followed by a path boundary.
const WIN_ABS = `[A-Za-z]:[\\\\/][^"'<>|?*\\r\\n]*?\\.${EXT}`;
const POSIX_ABS = `\\/(?:[\\w.@+-]+\\/)*[\\w.@+-]+\\.${EXT}`;
const RELATIVE = `(?:\\.{1,2}[\\\\/])?(?:[\\w.@+-]+[\\\\/])*[\\w@+-][\\w.@+-]*\\.${EXT}`;
const PATH_RE = new RegExp(`(?<![\\w/\\\\.:@-])(?:${WIN_ABS}|${POSIX_ABS}|${RELATIVE})${END}`, 'g');

const CACHE_MS = 10_000;
const existsCache = new Map<string, { at: number; result: Promise<string | null> }>();

function checkFile(path: string): Promise<string | null> {
  const hit = existsCache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = api.files.stat(path)
    .then((s) => (s.exists && s.type === 'file' ? normalizePath(s.path) : null))
    .catch(() => null);
  existsCache.set(path, { at: Date.now(), result });
  return result;
}

function resolveCandidate(text: string, projectPath: string | undefined, windows: boolean): string | null {
  let p = text.replace(/\\/g, '/');
  // Git Bash style /c/Users/... → C:/Users/...
  if (windows && /^\/[A-Za-z]\//.test(p)) p = `${p[1].toUpperCase()}:${p.slice(2)}`;
  if (!isAbsolutePath(p)) {
    if (!projectPath) return null;
    p = joinPath(projectPath, p.replace(/^\.\//, ''));
  }
  return normalizePath(p);
}

/** Text of a (possibly wrapped) logical line plus each character's cell position. */
function readLogicalLine(term: Terminal, y: number): { text: string; cells: IBufferCellPosition[] } | null {
  const buffer = term.buffer.active;
  let start = y - 1; // 0-based
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let text = '';
  const cells: IBufferCellPosition[] = [];
  for (let row = start; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // second half of a wide char
      const chars = cell.getChars() || ' ';
      for (const ch of chars) {
        text += ch;
        cells.push({ x: x + 1, y: row + 1 });
      }
    }
  }
  return { text: text.replace(/\s+$/, ''), cells };
}

export function registerFileLinks(
  term: Terminal,
  opts: { getProjectPath: () => string | undefined; isWindows: () => boolean; onOpen: (path: string) => void },
): { dispose(): void } {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const logical = readLogicalLine(term, y);
      if (!logical || !logical.text) { callback(undefined); return; }
      const projectPath = opts.getProjectPath();
      const windows = opts.isWindows();
      const candidates: { start: number; end: number; target: string }[] = [];
      for (const m of logical.text.matchAll(PATH_RE)) {
        const target = resolveCandidate(m[0], projectPath, windows);
        if (target) candidates.push({ start: m.index!, end: m.index! + m[0].length - 1, target });
      }
      if (candidates.length === 0) { callback(undefined); return; }

      Promise.all(candidates.map(async (c) => ({ c, file: await checkFile(c.target) }))).then((results) => {
        const links: ILink[] = [];
        for (const { c, file } of results) {
          if (!file) continue;
          const start = logical.cells[c.start];
          const end = logical.cells[c.end];
          // Report each link only on the rows it occupies.
          if (!start || !end || y < start.y || y > end.y) continue;
          links.push({
            range: { start, end },
            text: file,
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => { event.preventDefault(); opts.onOpen(file); },
          });
        }
        callback(links.length ? links : undefined);
      });
    },
  };
  return term.registerLinkProvider(provider);
}
