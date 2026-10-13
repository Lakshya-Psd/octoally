/**
 * Windows: make every child process windowless by default.
 *
 * The server, its PTY workers and the winmux daemon run without a console. On
 * Windows, a console program (git, gh, taskkill, node workers ...) started from
 * a console-less parent gets a brand-new console window unless `windowsHide` is
 * set — so without this, every git status poll would flash a window on screen.
 * Patching child_process once here covers all call sites (including ones in
 * dependencies). Callers can still pass `windowsHide: false` explicitly.
 *
 * Import this module FIRST in every entry point, before anything that captures
 * child_process functions (e.g. `promisify(execFile)` at module load).
 */

import childProcess from 'child_process';
import { syncBuiltinESMExports } from 'module';
import { promisify } from 'util';

type AnyFn = (...args: any[]) => any;

function isOptions(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Add windowsHide to the options of spawn/execFile/fork-style calls:
 *  (file, [args], [options], [callback]). */
function withHideArgsStyle(args: any[]): any[] {
  const out = [...args];
  const idx = Array.isArray(out[1]) ? 2 : 1; // where options live
  const slot = out[idx];
  if (isOptions(slot)) {
    out[idx] = { windowsHide: true, ...slot };
  } else if (typeof slot === 'function') {
    out.splice(idx, 0, { windowsHide: true }); // callback where options would be
  } else if (slot === undefined || slot === null) {
    out[idx] = { windowsHide: true };
  }
  return out;
}

/** Same for exec/execSync, whose options are always the second argument. */
function withHideExecStyle(args: any[]): any[] {
  const out = [...args];
  if (isOptions(out[1])) out[1] = { windowsHide: true, ...out[1] };
  else if (typeof out[1] === 'function') out.splice(1, 0, { windowsHide: true });
  else if (out[1] === undefined || out[1] === null) out[1] = { windowsHide: true };
  return out;
}

if (process.platform === 'win32' && !(childProcess as any).__octoallyHidden) {
  const cp = childProcess as unknown as Record<string, AnyFn>;
  const wrap = (name: string, normalize: (a: any[]) => any[]) => {
    const original = cp[name];
    if (typeof original !== 'function') return;
    const wrapped: AnyFn = function (this: unknown, ...args: any[]) {
      return original.apply(this, normalize(args));
    };
    const custom = (original as any)[promisify.custom];
    if (custom) {
      // Keep execFile/exec's {stdout, stderr} promisified shape.
      (wrapped as any)[promisify.custom] = (...args: any[]) => custom(...normalize(args));
    }
    cp[name] = wrapped;
  };
  wrap('spawn', withHideArgsStyle);
  wrap('spawnSync', withHideArgsStyle);
  wrap('execFile', withHideArgsStyle);
  wrap('execFileSync', withHideArgsStyle);
  wrap('fork', withHideArgsStyle);
  wrap('exec', withHideExecStyle);
  wrap('execSync', withHideExecStyle);
  (childProcess as any).__octoallyHidden = true;
  // Update `import { spawn } from 'child_process'` bindings in ES modules.
  syncBuiltinESMExports();
}

export {};
