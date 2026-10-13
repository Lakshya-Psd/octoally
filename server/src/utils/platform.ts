/**
 * Small platform helpers shared by the server.
 *
 * Paths: on Windows the server stores and returns paths with forward slashes
 * (`C:/Users/me/proj`). Node's fs, git, ConPTY and Claude Code all accept them,
 * and the dashboard can keep splitting on '/'.
 */

import { execFile, type ExecFileOptions } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCommand } from '../winmux/command.js';

export const IS_WIN = process.platform === 'win32';

/** A file in the OS temp dir (replaces hard-coded `/tmp/...`). */
export function tempPath(name: string): string {
  return join(tmpdir(), name);
}

/** Convert a path to the form the server stores and returns. No-op on POSIX. */
export function toClientPath(p: string): string {
  if (!IS_WIN || !p) return p;
  let s = p.replace(/\\/g, '/');
  // Drive letters upper-case so C:/x and c:/x compare equal in the UI and DB.
  s = s.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  return s;
}

/**
 * Normalise a project path typed by a user: trim, forward slashes on Windows,
 * strip trailing separators except at a root (`/` or `C:/`).
 */
export function normalizeUserPath(p: string): string {
  const trimmed = (p || '').trim();
  if (!trimmed) return trimmed;
  if (!IS_WIN) {
    if (trimmed === '/') return trimmed;
    return trimmed.replace(/\/+$/, '');
  }
  let s = toClientPath(trimmed);
  if (/^[A-Za-z]:\/*$/.test(s)) return `${s.slice(0, 2)}/`;
  if (s === '/') return s;
  s = s.replace(/\/+$/, '');
  return s;
}

/**
 * Folder name Claude Code uses under ~/.claude/projects/ for a working dir:
 * every non-alphanumeric character becomes '-'
 * (`/home/me/my.app` → `-home-me-my-app`, `C:\Users\me\app` → `C--Users-me-app`).
 */
export function claudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * execFile for CLIs that may be npm `.cmd` shims on Windows (claude, codex, gh ...).
 * Node refuses to spawn .cmd/.bat without a shell, so resolve the real program first.
 */
export function execCli(
  name: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let file = name;
    let argv: string[] = args;
    let verbatim = false;
    if (IS_WIN) {
      const spec = buildCommand([name, ...args], (opts.env as Record<string, string>) || process.env);
      file = spec.file;
      if (typeof spec.args === 'string') {
        argv = [spec.args];
        verbatim = true;
      } else {
        argv = spec.args;
      }
    }
    execFile(file, argv, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: verbatim, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Kill a process and all its descendants. */
export function killProcessTree(pid: number): void {
  if (IS_WIN) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* best effort */ });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* not a group leader */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
}
