/**
 * Clickable file and folder paths in terminal output: when Claude prints
 * "Saved the video to C:\Users\me\proj\out\demo.mp4" or "updated src/App.tsx",
 * clicking the path opens it in OctoAlly's file viewer; a folder opens in the
 * file tree.
 *
 * Only paths that exist on disk become links (checked via /api/files/stat,
 * cached briefly), so words like "Node.js" or "v1.0" are never underlined.
 * Claude wraps its own lines, so a path may run over two or three lines; see
 * terminal-path-candidates.ts for how those are read whole.
 */
import type { IBufferCellPosition, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { api } from './api';
import { isAbsolutePath, joinPath, normalizePath } from './paths';
import { findPathCandidates, pickLinks, type PathCandidate, type TextPos } from './terminal-path-candidates';

export type PathType = 'file' | 'directory';
type Found = { path: string; type: PathType };

const CACHE_MS = 10_000;
const existsCache = new Map<string, { at: number; result: Promise<Found | null> }>();
// How many lines above and below the hovered one a wrapped path may reach.
const NEIGHBOURS = 2;

function checkPath(path: string): Promise<Found | null> {
  const hit = existsCache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = api.files.stat(path)
    .then((s) => (s.exists && s.type ? { path: normalizePath(s.path), type: s.type } : null))
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

/** A (possibly wrapped) logical line: its text, each character's cell, and its first and last row (0-based). */
type Line = { text: string; cells: IBufferCellPosition[]; first: number; last: number };

function readLogicalLine(term: Terminal, row: number): Line | null {
  const buffer = term.buffer.active;
  if (row < 0 || row >= buffer.length) return null;
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  let last = first;
  const cells: IBufferCellPosition[] = [];
  for (let r = first; r < buffer.length; r++) {
    const line = buffer.getLine(r);
    if (!line || (r > first && !line.isWrapped)) break;
    last = r;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // second half of a wide char
      const chars = cell.getChars() || ' ';
      // One cell per UTF-16 unit, so indexes into `text` map straight to cells.
      for (let k = 0; k < chars.length; k++) cells.push({ x: x + 1, y: r + 1 });
      text += chars;
    }
  }
  return { text: text.replace(/\s+$/, ''), cells, first, last };
}

/** The hovered line plus up to NEIGHBOURS lines either side; `at` is the hovered one's index. */
function readNeighbourhood(term: Terminal, row: number): { lines: Line[]; at: number } | null {
  const here = readLogicalLine(term, row);
  if (!here || !here.text) return null;
  const lines = [here];
  for (let k = 0, l: Line | null = here; k < NEIGHBOURS && l; k++) {
    l = readLogicalLine(term, l.first - 1);
    if (l) lines.unshift(l);
  }
  const at = lines.indexOf(here);
  for (let k = 0, l: Line | null = here; k < NEIGHBOURS && l; k++) {
    l = readLogicalLine(term, l.last + 1);
    if (l) lines.push(l);
  }
  return { lines, at };
}

export type HoveredPath = Found;

/** `hovered()` is the path under the mouse right now, for a right-click menu. */
export function registerFileLinks(
  term: Terminal,
  opts: { getProjectPath: () => string | undefined; isWindows: () => boolean; onOpen: (path: string, type: PathType) => void },
): { dispose(): void; hovered(): HoveredPath | null } {
  let hovered: Found | null = null;
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const near = readNeighbourhood(term, y - 1);
      if (!near) { callback(undefined); return; }
      const { lines, at } = near;
      const key = (p: TextPos) => `${p.line}:${p.index}`;
      const all = findPathCandidates(lines.map((l) => l.text));
      // Only paths that start on this line, or start above and may run onto it.
      const reachesHere = new Set(all.filter((c) => c.end.line >= at).map((c) => key(c.start)));
      const projectPath = opts.getProjectPath();
      const windows = opts.isWindows();
      const candidates: (PathCandidate & { target: string })[] = [];
      for (const c of all) {
        if (c.start.line > at || !reachesHere.has(key(c.start))) continue;
        const target = resolveCandidate(c.text, projectPath, windows);
        if (target) candidates.push({ ...c, target });
      }
      if (candidates.length === 0) { callback(undefined); return; }

      Promise.all(candidates.map(async (c) => ({ ...c, found: await checkPath(c.target) }))).then((results) => {
        const existing = results.filter((r): r is typeof r & { found: Found } => r.found !== null);
        const links: ILink[] = [];
        for (const c of pickLinks(existing)) {
          const start = lines[c.start.line].cells[c.start.index];
          const end = lines[c.end.line].cells[c.end.index];
          // Report each link only on the rows it occupies.
          if (!start || !end || y < start.y || y > end.y) continue;
          links.push({
            range: { start, end },
            text: c.found.path,
            decorations: { pointerCursor: true, underline: true },
            // xterm calls this for any button; a right click gets the path menu instead
            activate: (event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              opts.onOpen(c.found.path, c.found.type);
            },
            hover: () => { hovered = c.found; },
            leave: () => { if (hovered === c.found) hovered = null; },
          });
        }
        callback(links.length ? links : undefined);
      });
    },
  };
  const registration = term.registerLinkProvider(provider);
  return {
    dispose: () => { hovered = null; registration.dispose(); },
    hovered: () => hovered,
  };
}
