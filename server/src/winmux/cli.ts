#!/usr/bin/env node
/**
 * `octoally mux` — command-line access to winmux sessions (the Windows
 * counterpart of running `tmux` against OctoAlly's tmux server).
 *
 *   octoally mux ls                       list sessions
 *   octoally mux attach <name>            attach this console (detach: Ctrl+B, then D)
 *   octoally mux new [-c dir] [-s name] [-t task] [-d] [-- command args...]
 *                                         start an external session (adoptable from the dashboard)
 *   octoally mux capture <name>           print a session's screen
 *   octoally mux kill <name>              kill a session
 *   octoally mux daemon-status            one-line daemon status
 *   octoally mux kill-server              stop the daemon and every session
 */

import { basename } from 'path';
import { nanoid } from 'nanoid';
import * as mux from './client.js';
import { buildCommand, defaultShell } from './command.js';

const PREFIX_KEY = '\x02'; // Ctrl+B, like tmux

function usage(): void {
  console.log(`Usage: octoally mux <command>

Commands:
  ls                                   List sessions
  attach <name>                        Attach this console to a session (detach: Ctrl+B, then D)
  new [-c dir] [-s name] [-t task] [-d] [-- command args...]
                                       Start a session (default: your shell). It appears under
                                       "External sessions" in the dashboard and can be adopted.
  capture <name>                       Print a session's current screen
  kill <name>                          Kill a session
  daemon-status                        Show whether the winmux daemon is running
  kill-server                          Stop the daemon and all sessions`);
}

/** Accept `of-<id>`, `<id>`, or any unique prefix of a session name. */
async function resolveName(input: string): Promise<string | null> {
  const sessions = await mux.listSessions();
  const names = sessions.map(s => s.name);
  if (names.includes(input)) return input;
  if (names.includes(`of-${input}`)) return `of-${input}`;
  const matches = names.filter(n => n.startsWith(input) || n.startsWith(`of-${input}`));
  return matches.length === 1 ? matches[0] : null;
}

async function cmdList(): Promise<number> {
  const sessions = await mux.listSessions();
  if (sessions.length === 0) {
    console.log('No sessions.');
    return 0;
  }
  for (const s of sessions) {
    const owner = s.meta.owner === 'external' ? 'external' : 'octoally';
    const task = (s.meta.task || s.command).replace(/\s+/g, ' ').slice(0, 60);
    console.log(`${s.name}: ${s.cols}x${s.rows} pid ${s.pid} [${owner}] ${s.clients} client(s) — ${task}`);
  }
  return 0;
}

async function cmdAttach(input: string | undefined): Promise<number> {
  if (!input) { console.error('attach: missing session name'); return 1; }
  const name = await resolveName(input);
  if (!name) { console.error(`attach: no session matching "${input}"`); return 1; }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const interactive = !!(stdin.isTTY && stdout.isTTY);
  const cols = stdout.columns || 120;
  const rows = stdout.rows || 30;

  // Strip modes that only make sense between ConPTY and its own host.
  const clean = (d: string) => d.replace(/\x1b\[\?(?:9001|1004)[hl]/g, '');

  return new Promise<number>(async (resolve) => {
    let finished = false;
    const restore = (message: string, code: number) => {
      if (finished) return;
      finished = true;
      if (interactive) {
        try { stdin.setRawMode(false); } catch { /* ignore */ }
      }
      stdin.pause();
      // Undo modes the session may have turned on in this console.
      stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[0m\x1b[?25h\r\n');
      stdout.write(`[octoally] ${message}\r\n`);
      resolve(code);
    };

    let att: mux.Attachment;
    try {
      att = await mux.attach(name, {
        cols, rows, snapshot: true, client: 'terminal',
        onSnapshot: (data) => {
          if (data) stdout.write('\x1b[H\x1b[2J\x1b[3J' + clean(data));
        },
      });
    } catch (err: any) {
      console.error(`attach: ${err?.message ?? err}`);
      resolve(1);
      return;
    }

    stdout.write(`\x1b]0;OctoAlly — ${name}\x07`);
    att.onData((d) => stdout.write(clean(d)));
    att.onExit(({ exitCode }) => restore(`session ${name} exited (code ${exitCode})`, exitCode ?? 0));
    att.onDetach((reason) => restore(`detached from ${name} (${reason})`, 0));

    if (interactive) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    let prefix = false;
    stdin.on('data', (chunk: string) => {
      let out = '';
      for (const ch of chunk) {
        if (prefix) {
          prefix = false;
          if (ch === 'd' || ch === 'D') {
            if (out) att.write(out);
            att.detach();
            restore(`detached from ${name} — reattach with: octoally mux attach ${name}`, 0);
            return;
          }
          if (ch === PREFIX_KEY) out += PREFIX_KEY;
          continue; // unbound key after prefix: ignored, like tmux
        }
        if (ch === PREFIX_KEY) { prefix = true; continue; }
        out += ch;
      }
      if (out) att.write(out);
    });

    stdout.on('resize', () => {
      if (stdout.columns && stdout.rows) att.resize(stdout.columns, stdout.rows);
    });
  });
}

async function cmdNew(args: string[]): Promise<number> {
  let cwd = process.cwd();
  let name = '';
  let task = '';
  let detached = false;
  let command: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { command = args.slice(i + 1); break; }
    if (a === '-c') cwd = args[++i] ?? cwd;
    else if (a === '-s') name = args[++i] ?? '';
    else if (a === '-t') task = args[++i] ?? '';
    else if (a === '-d') detached = true;
    else { command = args.slice(i); break; }
  }

  const spec = command.length > 0
    ? buildCommand(command)
    : (() => { const sh = defaultShell(); return { file: sh.file, args: sh.args }; })();
  const sessionName = name || `ext-${nanoid(8)}`;
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

  await mux.newSession({
    name: sessionName,
    file: spec.file,
    args: spec.args,
    cwd,
    env,
    cols,
    rows,
    meta: {
      owner: 'external',
      projectPath: cwd.replace(/\\/g, '/'),
      task: task || (command.length ? command.join(' ') : `Shell in ${basename(cwd)}`),
    },
  });
  console.log(`[octoally] started session ${sessionName}`);
  if (detached) return 0;
  return cmdAttach(sessionName);
}

async function cmdCapture(input: string | undefined): Promise<number> {
  if (!input) { console.error('capture: missing session name'); return 1; }
  const name = await resolveName(input);
  if (!name) { console.error(`capture: no session matching "${input}"`); return 1; }
  const data = await mux.capturePane(name);
  process.stdout.write((data ?? '') + '\n');
  return 0;
}

async function cmdKill(input: string | undefined): Promise<number> {
  if (!input) { console.error('kill: missing session name'); return 1; }
  const name = await resolveName(input);
  if (!name) { console.error(`kill: no session matching "${input}"`); return 1; }
  await mux.killSession(name);
  console.log(`[octoally] killed ${name}`);
  return 0;
}

async function cmdDaemonStatus(): Promise<number> {
  const status = await mux.daemonStatus();
  if (!status) {
    console.log('winmux: not running');
    return 0;
  }
  console.log(`winmux: running (pid ${status.pid}, ${status.sessions} session(s), protocol ${status.protocol}, up ${status.uptime}s)`);
  return 0;
}

async function cmdKillServer(): Promise<number> {
  if (!(await mux.isDaemonRunning())) {
    console.log('winmux: not running');
    return 0;
  }
  await mux.request({ op: 'shutdown' });
  console.log('winmux: stopping (all sessions killed)');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'ls':
    case 'list':
    case 'list-sessions':
      return cmdList();
    case 'attach':
    case 'a':
    case 'attach-session':
      return cmdAttach(rest[0]);
    case 'new':
    case 'new-session':
      return cmdNew(rest);
    case 'capture':
    case 'capture-pane':
      return cmdCapture(rest[0]);
    case 'kill':
    case 'kill-session':
      return cmdKill(rest[0]);
    case 'daemon-status':
    case 'status':
      return cmdDaemonStatus();
    case 'kill-server':
      return cmdKillServer();
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      usage();
      return 0;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`octoally mux: ${err?.message ?? err}`);
    process.exit(1);
  },
);
