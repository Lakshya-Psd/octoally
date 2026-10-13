/**
 * winmux daemon — owns every OctoAlly session on Windows (see protocol.ts).
 *
 * Started on demand by the server, its PTY workers, or `octoally mux`, and keeps
 * running independently of them (like the tmux server), so sessions survive
 * server restarts and can be attached from any terminal. Exits on its own a
 * little while after the last session ends.
 */

import { createServer, type Socket } from 'net';
import { spawn, execFile } from 'child_process';
import { createRequire } from 'module';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, win32 } from 'path';
import { fileURLToPath } from 'url';
import { loadPty, type IPty } from '../lib/pty.js';
import {
  PROTOCOL_VERSION, pipePath, onMessages, sendMessage,
  type NewSessionRequest, type SessionInfo, type SessionMeta, type AttachRequest,
} from './protocol.js';

const nodeRequire = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = nodeRequire('@xterm/headless') as { Terminal: any };
const { SerializeAddon } = nodeRequire('@xterm/addon-serialize') as { SerializeAddon: any };

const DEFAULT_HISTORY = parseInt(process.env.OCTOALLY_MUX_HISTORY || '10000', 10) || 10000;
const IDLE_EXIT_MS = 30_000;
const MAX_CLIENT_BACKLOG = 16 * 1024 * 1024;

/* ================================================================
   Logging
   ================================================================ */

const LOG_DIR = join(homedir(), '.octoally');
const LOG_FILE = join(LOG_DIR, 'winmux.log');

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${process.pid}] ${msg}\n`);
  } catch { /* logging must never crash the daemon */ }
}

/* ================================================================
   Sessions
   ================================================================ */

interface Marker { marker: number }

interface Client {
  socket: Socket;
  label: string;
  session: Session;
  /** While a capture is pending, live output is queued so it is not applied
   *  before the snapshot (which would lose it) — see requestCapture(). */
  queue: Array<string | Marker> | null;
}

interface Session {
  name: string;
  pty: IPty;
  pid: number;
  cols: number;
  rows: number;
  term: any;
  serializer: any;
  cwd: string;
  command: string;
  createdAt: string;
  meta: SessionMeta;
  clients: Set<Client>;
  exited: boolean;
  history: number;
}

const sessions = new Map<string, Session>();
let markerSeq = 0;

function sessionInfo(s: Session): SessionInfo {
  return {
    name: s.name,
    pid: s.pid,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    createdAt: s.createdAt,
    command: s.command,
    clients: s.clients.size,
    meta: s.meta,
  };
}

function toNativePath(p: string): string {
  return win32.normalize(p);
}

function createSession(req: NewSessionRequest): Session {
  if (sessions.has(req.name)) {
    // Same semantics as the tmux helpers: replace a stale session of the same name.
    killSession(sessions.get(req.name)!, 'replaced');
  }

  let cwd = toNativePath(req.cwd || homedir());
  if (!existsSync(cwd)) {
    log(`new ${req.name}: cwd ${cwd} does not exist, using home`);
    cwd = homedir();
  }

  const cols = Math.max(2, req.cols || 120);
  const rows = Math.max(2, req.rows || 40);
  const pty = loadPty().spawn(req.file, req.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: req.env || (process.env as Record<string, string>),
    useConptyDll: process.env.OCTOALLY_CONPTY_DLL === '1' ? true : undefined,
  });

  const history = req.historyLimit || DEFAULT_HISTORY;
  const term = new HeadlessTerminal({ cols, rows, scrollback: history, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);

  const command = typeof req.args === 'string'
    ? `${req.file} ${req.args}`
    : [req.file, ...req.args].join(' ');

  const session: Session = {
    name: req.name,
    pty,
    pid: pty.pid,
    cols,
    rows,
    term,
    serializer,
    cwd,
    command,
    createdAt: new Date().toISOString(),
    meta: { owner: 'octoally', ...(req.meta || {}) },
    clients: new Set(),
    exited: false,
    history,
  };

  pty.onData((data: string) => {
    term.write(data);
    for (const client of session.clients) {
      if (client.queue) client.queue.push(data);
      else sendFrame(client, { type: 'output', data });
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    session.exited = true;
    log(`exit ${session.name} pid=${session.pid} code=${exitCode} signal=${signal ?? ''}`);
    // Let the headless terminal and any queued output drain before telling clients.
    term.write('', () => {
      for (const client of session.clients) {
        if (client.queue) {
          for (const item of client.queue) if (typeof item === 'string') sendFrame(client, { type: 'output', data: item });
          client.queue = null;
        }
        sendFrame(client, { type: 'exit', exitCode, signal });
        client.socket.end();
      }
      session.clients.clear();
      if (sessions.get(session.name) === session) sessions.delete(session.name);
      try { term.dispose(); } catch { /* ignore */ }
      scheduleIdleExit();
    });
  });

  sessions.set(req.name, session);
  cancelIdleExit();
  log(`new ${req.name} pid=${pty.pid} ${cols}x${rows} cwd=${cwd} cmd=${command.slice(0, 200)}`);
  return session;
}

function resizeSession(session: Session, cols: number, rows?: number): void {
  const c = Math.max(2, Math.floor(cols));
  const r = Math.max(2, Math.floor(rows ?? session.rows));
  if (session.exited || (c === session.cols && r === session.rows)) return;
  try {
    session.pty.resize(c, r);
    session.term.resize(c, r);
    session.cols = c;
    session.rows = r;
  } catch (err: any) {
    log(`resize ${session.name} failed: ${err?.message ?? err}`);
  }
}

function killSession(session: Session, reason: string): void {
  log(`kill ${session.name} pid=${session.pid} (${reason})`);
  // Kill the whole process tree (shell → claude → node children ...).
  execFile('taskkill', ['/PID', String(session.pid), '/T', '/F'], { windowsHide: true }, () => {
    try { session.pty.kill(); } catch { /* already gone */ }
  });
  // If ConPTY never reports the exit, drop the session anyway.
  setTimeout(() => {
    if (sessions.get(session.name) === session) {
      for (const client of session.clients) {
        sendFrame(client, { type: 'exit', exitCode: -1 });
        client.socket.end();
      }
      sessions.delete(session.name);
      scheduleIdleExit();
    }
  }, 3000).unref();
}

/** Full-screen snapshot with colours, scrollback and cursor position — the
 *  equivalent of `tmux capture-pane -p -e -S -`, but replayable exactly. */
function serializeSession(session: Session, scrollback?: number): string {
  return session.serializer.serialize({ scrollback: scrollback ?? session.history });
}

function flushTerm(session: Session): Promise<void> {
  return new Promise(resolve => session.term.write('', () => resolve()));
}

async function captureSession(session: Session, scrollback?: number): Promise<string> {
  await flushTerm(session);
  return serializeSession(session, scrollback);
}

/** Capture for an attached client, ordered with its live output stream. */
function requestCapture(client: Client, scrollback?: number): void {
  const session = client.session;
  const marker: Marker = { marker: ++markerSeq };
  if (!client.queue) client.queue = [];
  client.queue.push(marker);
  session.term.write('', () => {
    let data: string | null = null;
    try { data = serializeSession(session, scrollback); } catch (err: any) { log(`capture ${session.name} failed: ${err?.message ?? err}`); }
    sendFrame(client, { type: 'capture', data });
    const queue = client.queue;
    if (!queue) return;
    // Output queued before this marker is already part of the snapshot.
    const idx = queue.indexOf(marker);
    queue.splice(0, idx + 1);
    if (!queue.some(item => typeof item !== 'string')) {
      client.queue = null;
      for (const item of queue) sendFrame(client, { type: 'output', data: item as string });
    }
  });
}

function sendFrame(client: Client, frame: unknown): void {
  if (client.socket.writableLength > MAX_CLIENT_BACKLOG) {
    log(`client ${client.label} on ${client.session.name} is not reading — disconnecting`);
    client.socket.destroy();
    return;
  }
  sendMessage(client.socket, frame);
}

/* ================================================================
   Idle shutdown (like tmux exiting when its last session closes)
   ================================================================ */

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleExit(): void {
  if (sessions.size > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    if (sessions.size === 0) {
      log('no sessions left — exiting');
      process.exit(0);
    }
    idleTimer = null;
  }, IDLE_EXIT_MS);
}

function cancelIdleExit(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/* ================================================================
   Connections
   ================================================================ */

const startedAt = Date.now();

function handleConnection(socket: Socket): void {
  let client: Client | null = null;

  socket.on('error', () => { /* client vanished */ });
  socket.on('close', () => {
    if (client) {
      client.session.clients.delete(client);
      client = null;
    }
  });

  onMessages(socket, (msg: any) => {
    if (client) {
      handleClientFrame(client, msg);
      return;
    }
    if (msg?.op === 'attach') {
      client = handleAttach(socket, msg as AttachRequest);
      return;
    }
    handleRequest(socket, msg).catch((err) => {
      sendMessage(socket, { id: msg?.id, ok: false, error: err?.message ?? String(err) });
    });
  });
}

function handleAttach(socket: Socket, req: AttachRequest): Client | null {
  const session = sessions.get(req.name);
  if (!session || session.exited) {
    sendMessage(socket, { type: 'error', message: `no session ${req.name}` });
    socket.end();
    return null;
  }
  const client: Client = { socket, label: req.client || 'client', session, queue: null };
  session.clients.add(client);
  if (req.cols && req.rows) resizeSession(session, req.cols, req.rows);
  sendFrame(client, { type: 'attached', pid: session.pid, cols: session.cols, rows: session.rows });
  if (req.snapshot) requestCapture(client);
  log(`attach ${session.name} by ${client.label} (${session.clients.size} client(s))`);
  return client;
}

function handleClientFrame(client: Client, frame: any): void {
  const session = client.session;
  switch (frame?.type) {
    case 'input':
      if (!session.exited && typeof frame.data === 'string') session.pty.write(frame.data);
      break;
    case 'resize':
      resizeSession(session, frame.cols, frame.rows);
      break;
    case 'capture':
      requestCapture(client, frame.scrollback);
      break;
    case 'detach':
      session.clients.delete(client);
      client.socket.end();
      break;
  }
}

async function handleRequest(socket: Socket, msg: any): Promise<void> {
  const reply = (body: Record<string, unknown>) => sendMessage(socket, { id: msg.id, ok: true, ...body });
  const get = (name: string): Session | undefined => {
    const s = sessions.get(name);
    return s && !s.exited ? s : undefined;
  };

  switch (msg?.op) {
    case 'new': {
      const s = createSession(msg as NewSessionRequest);
      reply({ pid: s.pid, session: sessionInfo(s) });
      break;
    }
    case 'has':
      reply({ exists: !!get(msg.name) });
      break;
    case 'list':
      reply({ sessions: [...sessions.values()].filter(s => !s.exited).map(sessionInfo) });
      break;
    case 'kill': {
      const s = sessions.get(msg.name);
      if (s) killSession(s, 'kill request');
      reply({ killed: !!s });
      break;
    }
    case 'capture': {
      const s = get(msg.name);
      reply({ data: s ? await captureSession(s, msg.scrollback) : null });
      break;
    }
    case 'resize': {
      const s = get(msg.name);
      if (s) resizeSession(s, msg.cols, msg.rows);
      reply({ resized: !!s });
      break;
    }
    case 'detach-clients': {
      const s = get(msg.name);
      let count = 0;
      if (s) {
        for (const c of [...s.clients]) {
          sendFrame(c, { type: 'detached', reason: 'attached elsewhere' });
          c.socket.end();
          s.clients.delete(c);
          count++;
        }
      }
      reply({ detached: count });
      break;
    }
    case 'set-meta': {
      const s = get(msg.name);
      if (s) s.meta = { ...s.meta, ...(msg.meta || {}) };
      reply({ updated: !!s });
      break;
    }
    case 'rename': {
      // Used when the dashboard adopts an external session: it becomes of-<id>.
      const s = get(msg.name);
      if (!s || !msg.newName || sessions.has(msg.newName)) {
        reply({ renamed: false });
        break;
      }
      sessions.delete(s.name);
      log(`rename ${s.name} → ${msg.newName}`);
      s.name = msg.newName;
      if (msg.meta) s.meta = { ...s.meta, ...msg.meta };
      sessions.set(s.name, s);
      reply({ renamed: true });
      break;
    }
    case 'status':
      reply({
        pid: process.pid,
        protocol: PROTOCOL_VERSION,
        sessions: sessions.size,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        pipe: pipePath(),
        node: process.version,
      });
      break;
    case 'shutdown':
      reply({ stopping: true });
      log('shutdown requested — killing all sessions');
      for (const s of [...sessions.values()]) killSession(s, 'shutdown');
      setTimeout(() => process.exit(0), 1500);
      break;
    default:
      sendMessage(socket, { id: msg?.id, ok: false, error: `unknown op ${msg?.op}` });
  }
}

/* ================================================================
   Entry point
   ================================================================ */

function startDaemon(): void {
  const server = createServer(handleConnection);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Another daemon already owns the pipe — nothing to do.
      process.exit(0);
    }
    log(`server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(pipePath(), () => {
    log(`winmux daemon listening on ${pipePath()} (node ${process.version})`);
    scheduleIdleExit();
  });

  process.on('uncaughtException', (err) => {
    // Never take every session down because of one bad message.
    log(`uncaught exception: ${err?.stack ?? err}`);
  });
  process.on('unhandledRejection', (err: any) => {
    log(`unhandled rejection: ${err?.stack ?? err}`);
  });
}

/**
 * `--detach`: start the real daemon as an orphan and return immediately. The
 * intermediate process exits, so the daemon is not a descendant of the server
 * and survives `taskkill /T` on it (like tmux double-forking).
 */
function spawnDetachedDaemon(): void {
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  process.exit(0);
}

if (process.argv.includes('--detach')) {
  spawnDetachedDaemon();
} else {
  startDaemon();
}
