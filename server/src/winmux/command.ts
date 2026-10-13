/**
 * Windows command-line building for sessions.
 *
 * On Linux, OctoAlly hands `claude '<task>'` to `bash -i -c`. On Windows there is
 * no equivalent shell that quotes arbitrary text safely (cmd.exe expands `%`,
 * breaks on newlines and mangles quotes; Windows PowerShell 5.1 drops embedded
 * double quotes when calling native programs). So we resolve the program
 * ourselves and pass an argv array to ConPTY, which uses standard MSVCRT quoting:
 *
 *  - `claude.exe` / `codex.exe` → run directly.
 *  - npm `.cmd` shims (e.g. `%APPDATA%\npm\claude.cmd`) → unwrapped to
 *    `node <package>/cli.js`, so prompts with quotes, `%`, `&` or newlines survive.
 *  - any other `.cmd`/`.bat` → `cmd.exe /d /s /c` with cmd-safe escaping.
 *  - a configured command containing shell syntax (`&&`, `|`, `$env:` ...) →
 *    run as a PowerShell command.
 */

import { existsSync, lstatSync, readFileSync, statSync } from 'fs';
import { delimiter, dirname, isAbsolute, join, resolve, extname } from 'path';

export interface CommandSpec {
  file: string;
  /** Array → quoted by node-pty; string → raw command line (used for cmd.exe). */
  args: string[] | string;
}

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

function pathExts(env: Record<string, string | undefined>): string[] {
  const raw = env.PATHEXT || env.Pathext || '';
  const list = raw.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  // Only extensions CreateProcess can run directly (or via cmd).
  const runnable = list.filter(e => ['.COM', '.EXE', '.BAT', '.CMD'].includes(e));
  return runnable.length ? runnable : DEFAULT_PATHEXT;
}

function envPath(env: Record<string, string | undefined>): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    // App execution aliases (e.g. %LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe)
    // can't be stat'ed, but lstat reports them as links and CreateProcess runs them.
    try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
  }
}

/** Resolve a program name the way cmd.exe would (PATH × PATHEXT), preferring
 *  real executables over .cmd/.bat shims within the same directory. */
export function resolveExecutable(name: string, env: Record<string, string | undefined> = process.env): string | null {
  const exts = pathExts(env);
  const hasExt = extname(name) !== '';
  const candidatesFor = (base: string): string[] => {
    const list: string[] = [];
    if (hasExt) list.push(base);
    // Prefer .exe/.com over .cmd/.bat when both exist in the same folder.
    const ordered = [...exts].sort((a, b) => rank(a) - rank(b));
    for (const ext of ordered) list.push(base + ext.toLowerCase());
    return list;
  };

  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
    for (const c of candidatesFor(resolve(name))) if (isFile(c)) return c;
    return null;
  }

  for (const dir of envPath(env).split(delimiter)) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d) continue;
    for (const c of candidatesFor(join(d, name))) if (isFile(c)) return c;
  }
  return null;
}

function rank(ext: string): number {
  switch (ext) {
    case '.EXE': return 0;
    case '.COM': return 1;
    case '.CMD': return 2;
    case '.BAT': return 3;
    default: return 4;
  }
}

/** If `shimPath` is an npm/pnpm/yarn generated .cmd shim, return what it really runs. */
export function unwrapCmdShim(shimPath: string): { script?: string; exe?: string } | null {
  let text: string;
  try { text = readFileSync(shimPath, 'utf8'); } catch { return null; }
  const dir = dirname(shimPath);
  // Collect quoted targets that are relative to the shim's own directory, e.g.
  //   "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*      (npm cmd-shim)
  //   "%~dp0\..\some\bin\tool.js" %*                               (pnpm/yarn)
  const re = /"%(?:~dp0|dp0%)\\?([^"%]+)"/gi;
  let match: RegExpExecArray | null;
  let target: string | null = null;
  while ((match = re.exec(text)) !== null) {
    const rel = match[1];
    if (/node(\.exe)?$/i.test(rel)) continue; // the bundled node.exe, not the target
    target = rel;
  }
  if (!target) return null;
  const full = resolve(dir, target);
  if (!existsSync(full)) return null;
  if (/\.(c|m)?js$/i.test(full)) return { script: full };
  if (/\.(exe|com)$/i.test(full)) return { exe: full };
  return null;
}

/** Find a node.exe for running unwrapped npm shims. */
function nodeFor(shimPath: string, env: Record<string, string | undefined>): string {
  const local = join(dirname(shimPath), 'node.exe');
  if (isFile(local)) return local;
  const onPath = resolveExecutable('node', env);
  if (onPath && /\.exe$/i.test(onPath)) return onPath;
  return process.execPath;
}

// cmd.exe metacharacters that must be ^-escaped outside of our own quoting.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument with MSVCRT rules (same as node-pty / cross-spawn). */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"\t\n\v]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/** Escape an argument for a .cmd/.bat target run through `cmd.exe /d /s /c "..."`
 *  (same approach as cross-spawn). cmd.exe can't carry newlines inside an
 *  argument, so those become spaces. */
function escapeArgForCmd(arg: string, doubleEscape: boolean): string {
  let s = arg.replace(/\r?\n/g, ' ');
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  if (doubleEscape) s = s.replace(CMD_META, '^$1');
  return s;
}

function escapeCommandForCmd(cmd: string): string {
  return cmd.replace(CMD_META, '^$1');
}

/** Build a ConPTY spawn spec for argv[0] + args. */
export function buildCommand(argv: string[], env: Record<string, string | undefined> = process.env): CommandSpec {
  const [program, ...rest] = argv;
  const resolved = resolveExecutable(program, env);
  if (!resolved) {
    // Let cmd.exe produce its usual "not recognized" message inside the terminal.
    return cmdWrap(program, rest, false);
  }
  const ext = extname(resolved).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: resolved, args: rest };
  if (ext === '.cmd' || ext === '.bat') {
    const shim = unwrapCmdShim(resolved);
    if (shim?.script) return { file: nodeFor(resolved, env), args: [shim.script, ...rest] };
    if (shim?.exe) return { file: shim.exe, args: rest };
    return cmdWrap(resolved, rest, true);
  }
  return { file: resolved, args: rest };
}

function cmdWrap(program: string, args: string[], isBatch: boolean): CommandSpec {
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const parts = [escapeCommandForCmd(program), ...args.map(a => escapeArgForCmd(a, isBatch))];
  return { file: comspec, args: `/d /s /c "${parts.join(' ')}"` };
}

/* ================================================================
   Parsing the user's "session command" setting
   ================================================================ */

/** Characters that mean "this is shell code, not a plain program + flags". */
const SHELL_SYNTAX = /[|&;<>()`$]|\r|\n/;

/** Split a command setting like `claude --model "opus 4" --flag` into argv.
 *  Returns null when the string uses shell syntax outside of quotes. */
export function splitCommandLine(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && cmd[i + 1] === '"') { cur += '"'; i++; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
      continue;
    }
    if (SHELL_SYNTAX.test(ch)) return null;
    cur += ch;
    inToken = true;
  }
  if (quote) return null;
  if (inToken) out.push(cur);
  return out;
}

/** PowerShell single-quoted literal. */
export function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Windows PowerShell 5.1 passes native-command arguments without escaping
 *  embedded double quotes, so pre-escape them MSVCRT-style. */
function psNativeArg(s: string): string {
  let out = '';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') out += '\\'.repeat(backslashes * 2 + 1) + '"';
    else out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // PS wraps args containing spaces in quotes; trailing backslashes must then be doubled.
  out += '\\'.repeat(/\s/.test(s) ? backslashes * 2 : backslashes);
  return out;
}

export function powershellExe(env: Record<string, string | undefined> = process.env): string {
  return resolveExecutable('powershell', env)
    || join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Build the spawn spec for a configured command (e.g. the "Claude command" setting,
 * which may carry flags) followed by extra literal arguments (task text, agent name).
 */
export function buildConfiguredCommand(
  commandSetting: string,
  extraArgs: string[],
  env: Record<string, string | undefined> = process.env,
): CommandSpec {
  const argv = splitCommandLine(commandSetting.trim());
  if (argv && argv.length > 0) return buildCommand([...argv, ...extraArgs], env);

  // Shell syntax in the setting: run it as PowerShell code with the extra args appended.
  const script = `${commandSetting} ${extraArgs.map(a => psLiteral(psNativeArg(a))).join(' ')}`.trim();
  return {
    file: powershellExe(env),
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  };
}

/* ================================================================
   Interactive shell for plain terminals
   ================================================================ */

export interface ShellSpec {
  file: string;
  args: string[];
  name: string;
}

/**
 * The shell used for "Terminal" sessions. Override with OCTOALLY_SHELL
 * (`powershell`, `pwsh`, `cmd`, `bash`/`git-bash`, or a full path to an exe).
 * Default: PowerShell 7 (pwsh) if installed, otherwise Windows PowerShell.
 */
export function defaultShell(env: Record<string, string | undefined> = process.env): ShellSpec {
  const want = (env.OCTOALLY_SHELL || '').trim();
  const lower = want.toLowerCase();

  const gitBash = (): string | null => {
    const candidates = [
      join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      join(env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ];
    return candidates.find(isFile) || null;
  };

  if (lower === 'cmd' || lower === 'cmd.exe') {
    return { file: env.ComSpec || 'cmd.exe', args: [], name: 'cmd' };
  }
  if (lower === 'bash' || lower === 'git-bash' || lower === 'gitbash') {
    const bash = gitBash();
    if (bash) return { file: bash, args: ['--login', '-i'], name: 'bash' };
  }
  if (lower === 'pwsh') {
    const pwsh = resolveExecutable('pwsh', env);
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], name: 'pwsh' };
  }
  if (lower === 'powershell') {
    return { file: powershellExe(env), args: ['-NoLogo'], name: 'powershell' };
  }
  if (want && (want.includes('\\') || want.includes('/') || /\.exe$/i.test(want))) {
    const exe = resolveExecutable(want, env);
    if (exe) return { file: exe, args: [], name: want };
  }

  const pwsh = resolveExecutable('pwsh', env);
  if (pwsh) return { file: pwsh, args: ['-NoLogo'], name: 'pwsh' };
  return { file: powershellExe(env), args: ['-NoLogo'], name: 'powershell' };
}

/** Display string for a spawn spec (used in `ls` output and logs). */
export function describeCommand(spec: CommandSpec): string {
  if (typeof spec.args === 'string') return `${spec.file} ${spec.args}`;
  return [spec.file, ...spec.args].map(quoteArg).join(' ');
}
