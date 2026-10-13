/**
 * Cross-platform path helpers for the dashboard.
 *
 * The server always hands us forward-slash paths (`/home/me/proj` on POSIX,
 * `C:/Users/me/proj` on Windows), but users can still type or paste
 * `C:\Users\me\proj`, and Claude hook payloads on Windows carry backslashes.
 * These helpers are pure string functions so they behave the same no matter
 * which OS the browser runs on.
 */

/** Virtual root the server uses on Windows for the drive list ("This PC"). */
export const DRIVES_ROOT = '::drives';

/** True for the Windows `::drives` virtual root — never a real path. */
export function isDrivesRoot(p: string | null | undefined): boolean {
  return p === DRIVES_ROOT;
}

const DRIVE_RE = /^[a-zA-Z]:/;
const DRIVE_ROOT_RE = /^[a-zA-Z]:\/$/;
const UNC_ROOT_RE = /^\/\/[^/]+\/[^/]+$/;

/** Replace every backslash with a forward slash. */
export function toSlash(p: string): string {
  return (p || '').replace(/\\/g, '/');
}

/** True when the path looks like a Windows path (drive letter, UNC or backslashes). */
export function isWindowsPath(p: string): boolean {
  const s = (p || '').trim();
  if (!s) return false;
  if (DRIVE_RE.test(s) || /^\/\/[^/]/.test(s) || s.startsWith('\\\\')) return true;
  // Backslashes only count outside POSIX absolute paths (`/a\b` is a legal POSIX name).
  return !s.startsWith('/') && s.includes('\\');
}

/** POSIX `/x`, Windows `C:/x` / `C:\x`, or UNC `//server/share` / `\\server\share`. */
export function isAbsolutePath(p: string): boolean {
  const s = (p || '').trim();
  return s.startsWith('/') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s);
}

/** True for `/`, `C:/` and `//server/share` — paths that have no parent. */
export function isRootPath(p: string): boolean {
  const s = normalizePath(p);
  return s === '/' || DRIVE_ROOT_RE.test(s) || UNC_ROOT_RE.test(s);
}

/**
 * Canonical form for comparing and saving: trims whitespace, converts
 * backslashes to `/`, upper-cases the drive letter, collapses repeated
 * slashes and strips trailing slashes (except at a root: `/`, `C:/`).
 */
export function normalizePath(p: string): string {
  const trimmed = (p || '').trim();
  // A POSIX absolute path can legally contain `\` in a file name — leave those
  // alone. Everything else (drive paths, `\\server` UNC, typed Windows paths)
  // gets its backslashes converted.
  let s = /^\/(?!\/)/.test(trimmed) ? trimmed : toSlash(trimmed);
  if (!s || s === DRIVES_ROOT) return s;
  // Keep a leading `//` (UNC), collapse any other run of slashes.
  const unc = /^\/\/[^/]/.test(s);
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = '/' + s;
  if (DRIVE_RE.test(s)) s = s[0].toUpperCase() + s.slice(1);
  // Bare drive (`C:`) means the root of that drive.
  if (/^[A-Z]:$/.test(s)) return s + '/';
  if (s === '/' || DRIVE_ROOT_RE.test(s)) return s;
  return s.replace(/\/+$/, '');
}

/** Last path segment: `C:/Users/x/proj/` → `proj`, `C:/` → `C:`, `/` → ``. */
export function baseName(p: string): string {
  const s = normalizePath(p);
  if (s === '/') return '';
  if (DRIVE_ROOT_RE.test(s)) return s.slice(0, 2);
  const parts = s.split('/');
  return parts[parts.length - 1] || '';
}

/** Parent directory, or null at a root: `C:/foo` → `C:/`, `C:/` → null, `/a` → `/`. */
export function parentDir(p: string): string | null {
  const s = normalizePath(p);
  if (!s || s === DRIVES_ROOT || isRootPath(s)) return null;
  const idx = s.lastIndexOf('/');
  if (idx < 0) return null;
  const parent = s.slice(0, idx);
  if (parent === '') return '/';
  if (/^[A-Z]:$/.test(parent)) return parent + '/';
  return parent;
}

/** Root of a path: `/`, `C:/` or `//server/share` (falls back to `/`). */
export function rootOf(p: string): string {
  const s = normalizePath(p);
  const drive = s.match(/^[A-Z]:\//);
  if (drive) return drive[0];
  const unc = s.match(/^\/\/[^/]+\/[^/]+/);
  if (unc) return unc[0];
  return '/';
}

/**
 * Join a base directory with further segments using `/`, without doubling
 * separators at a root (`C:/` + `x` → `C:/x`, `/` + `x` → `/x`). Only forward
 * slashes at the joins are trimmed, so POSIX file names are not rewritten.
 */
export function joinPath(base: string, ...segments: string[]): string {
  let out = base || '';
  for (const seg of segments) {
    const clean = (seg || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    out = out === '' ? clean : out.endsWith('/') ? out + clean : `${out}/${clean}`;
  }
  return out;
}

/** Windows paths compare case-insensitively; POSIX paths stay case-sensitive. */
function caseInsensitive(a: string, b: string): boolean {
  return isWindowsPath(a) || isWindowsPath(b);
}

/** Same location after normalisation (case-insensitive for Windows paths). */
export function pathEquals(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (caseInsensitive(a, b)) return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

/**
 * True when `child` is `parent` itself or lies inside it. Separator-boundary
 * aware (`C:/Users/xy` is NOT inside `C:/Users/x`) and case-insensitive for
 * Windows paths.
 */
export function isSubPath(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  const ci = caseInsensitive(child, parent);
  const eq = (x: string, y: string) => (ci ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (eq(c, p)) return true;
  const prefix = p.endsWith('/') ? p : p + '/';
  return c.length > prefix.length && eq(c.slice(0, prefix.length), prefix);
}

/** True when `child` lies strictly inside `parent` (not equal to it). */
export function isStrictSubPath(child: string, parent: string): boolean {
  return isSubPath(child, parent) && !pathEquals(child, parent);
}

/**
 * The part of `child` below `parent` (no leading slash), `''` when equal, or
 * null when `child` is not inside `parent`. Keeps the child's original casing.
 */
export function relativeSubPath(child: string, parent: string): string | null {
  if (!isSubPath(child, parent)) return null;
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c.length <= p.length) return '';
  return c.slice(p.endsWith('/') ? p.length : p.length + 1);
}

const HOME_PATTERNS = [/^\/home\/[^/]+/, /^\/Users\/[^/]+/, /^[A-Za-z]:\/Users\/[^/]+/i, /^\/root(?=\/|$)/];

/**
 * Replace the home-directory prefix with `~`. Uses `home` when known (from
 * /api/platform), otherwise falls back to the usual `/home/x`, `/Users/x`
 * and `C:/Users/x` layouts.
 */
export function shortenHome(p: string, home?: string | null): string {
  if (!p) return p;
  const s = normalizePath(p);
  if (home && !isRootPath(home)) {
    const rest = relativeSubPath(s, home);
    if (rest !== null) return rest ? `~/${rest}` : '~';
    return s;
  }
  for (const re of HOME_PATTERNS) {
    const m = s.match(re);
    if (m) return '~' + s.slice(m[0].length);
  }
  return s;
}
