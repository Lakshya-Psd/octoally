/**
 * Windows desktop integration: open URLs, folders, terminals, and pop a winmux
 * session out into its own console window (the Windows counterpart of opening
 * tilix / gnome-terminal / Terminal.app with `tmux attach`).
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, win32 } from 'path';
import { fileURLToPath } from 'url';
import { resolveExecutable, defaultShell, quoteArg } from '../winmux/command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function launch(file: string, args: string[], opts: { cwd?: string; verbatim?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: opts.verbatim,
    });
    let settled = false;
    child.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    child.once('spawn', () => {
      child.unref();
      // Give it a moment to fail (e.g. missing exe) before reporting success.
      setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 150);
    });
  });
}

/** Open a URL in the default browser (no shell parsing of the URL). */
export function openUrl(url: string): Promise<void> {
  return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
}

/** Open File Explorer at a folder (or with a file selected). */
export function openFolder(path: string): Promise<void> {
  const native = win32.normalize(path);
  // explorer.exe returns exit code 1 even on success, so only spawn errors count.
  return launch('explorer.exe', [native]);
}

export function windowsTerminalPath(): string | null {
  return resolveExecutable('wt');
}

/** Open a new terminal window in a directory (Windows Terminal if installed). */
export async function openTerminalAt(path: string): Promise<string> {
  const cwd = win32.normalize(path);
  const wt = windowsTerminalPath();
  if (wt) {
    await launch(wt, ['-w', 'new', 'new-tab', '-d', cwd]);
    return 'Windows Terminal';
  }
  const shell = defaultShell();
  const cmd = `start "" /D ${quoteArg(cwd)} ${quoteArg(shell.file)} ${shell.args.map(quoteArg).join(' ')}`;
  await launch(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { verbatim: true });
  return shell.name;
}

/**
 * "Restart Server" on Windows: nothing supervises a CLI-started server (no
 * systemd/launchd), so hand off to a short-lived helper that runs
 * `octoally start` once this process has exited and freed the port.
 * Returns false when the Windows CLI isn't installed (dev checkouts).
 */
export function scheduleRelaunch(): boolean {
  let cli: string | null = null;
  try {
    const info = JSON.parse(readFileSync(join(homedir(), '.octoally', 'install.json'), 'utf8'));
    if (info?.cli && existsSync(info.cli)) cli = info.cli;
  } catch { /* not installed via install.ps1 */ }
  if (!cli) return false;
  const script = `setTimeout(() => require('child_process').spawn(process.execPath, [${JSON.stringify(cli)}, 'start'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(), 2000)`;
  const helper = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true });
  helper.unref();
  return true;
}

/** The `octoally mux` CLI script (compiled .js, or .ts when running under tsx). */
export function muxCliScript(): string {
  const js = join(__dirname, '..', 'winmux', 'cli.js');
  return existsSync(js) ? js : join(__dirname, '..', 'winmux', 'cli.ts');
}

/**
 * Open a console window attached to a winmux session — the "pop out" action.
 * Returns the name of the terminal used.
 */
export async function openAttachConsole(sessionName: string, title: string, cwd?: string): Promise<string> {
  const node = process.execPath;
  const cmd = [node, ...process.execArgv, muxCliScript(), 'attach', sessionName];
  const dir = cwd && existsSync(cwd) ? win32.normalize(cwd) : undefined;
  // Windows Terminal treats ';' as a command separator.
  const safeTitle = title.replace(/[;\r\n"]/g, ' ').slice(0, 80) || 'OctoAlly';

  const wt = windowsTerminalPath();
  if (wt) {
    const args = ['-w', 'new', 'new-tab', '--title', safeTitle];
    if (dir) args.push('-d', dir);
    args.push(...cmd.map(a => a.replace(/;/g, '\\;')));
    await launch(wt, args);
    return 'Windows Terminal';
  }

  // Classic console window via `start`.
  // `start` takes the first quoted argument as the window title, so always quote it.
  const line = `start "${safeTitle.replace(/[%^&|<>]/g, ' ')}"${dir ? ` /D ${quoteArg(dir)}` : ''} ${cmd.map(quoteArg).join(' ')}`;
  await launch(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { verbatim: true });
  return 'Console';
}
