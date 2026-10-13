/**
 * Drop-in for the parts of Node's `path` used by routes that hand paths to the
 * dashboard. On Windows every result uses forward slashes (`C:/Users/me/x`) so
 * the UI's '/'-based path handling keeps working; elsewhere it is `path` itself.
 */

import path from 'path';
import { IS_WIN, toClientPath } from './platform.js';

const out = (p: string) => (IS_WIN ? toClientPath(p) : p);

export const resolve = (...segments: string[]): string => out(path.resolve(...segments));
export const join = (...segments: string[]): string => out(path.join(...segments));
export const dirname = (p: string): string => out(path.dirname(p));
export const relative = (from: string, to: string): string => out(path.relative(from, to));
export const basename = path.basename;
export const extname = path.extname;
export const isAbsolute = path.isAbsolute;
export const sep = IS_WIN ? '/' : path.sep;

/** True when `child` is `parent` itself or inside it (case-insensitive on Windows). */
export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const s = out(path.resolve(p)).replace(/\/+$/, '');
    return IS_WIN ? s.toLowerCase() : s;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

/** Windows drive roots that exist, e.g. ['C:/', 'D:/'] (empty elsewhere). */
export async function listDrives(): Promise<string[]> {
  if (!IS_WIN) return [];
  const { access } = await import('fs/promises');
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
  const found: string[] = [];
  await Promise.all(letters.map(async (l) => {
    try { await access(`${l}:\\`); found.push(`${l}:/`); } catch { /* no such drive */ }
  }));
  return found.sort();
}
