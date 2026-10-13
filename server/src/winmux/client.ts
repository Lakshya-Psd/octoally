/**
 * winmux client — talks to the per-user winmux daemon over its named pipe.
 * Used by the server (status checks, capture, kill), the PTY workers (attach),
 * and the `octoally mux` CLI.
 */

import { connect, type Socket } from 'net';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  pipePath, onMessages, sendMessage,
  type NewSessionRequest, type SessionInfo, type SessionMeta, type DaemonFrame,
} from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function daemonScript(): string {
  const js = join(__dirname, 'daemon.js');
  if (existsSync(js)) return js;
  return join(__dirname, 'daemon.ts');
}

function connectPipe(timeoutMs = 3000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath());
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('winmux connect timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** True if a daemon is listening (does not start one). */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const s = await connectPipe(1500);
    s.destroy();
    return true;
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;

/** Start the daemon if it isn't running, and wait until it accepts connections. */
export function ensureDaemon(): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    if (await isDaemonRunning()) return;
    const child = spawn(process.execPath, [...process.execArgv, daemonScript(), '--detach'], {
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      if (await isDaemonRunning()) return;
    }
    throw new Error('winmux daemon did not start (see ~/.octoally/winmux.log)');
  })().finally(() => { starting = null; });
  return starting;
}

let requestSeq = 0;

/** One request/response round-trip. Starts the daemon first when `autoStart`. */
export async function request<T = any>(msg: Record<string, unknown>, opts: { autoStart?: boolean; timeoutMs?: number } = {}): Promise<T> {
  if (opts.autoStart) await ensureDaemon();
  const socket = await connectPipe();
  const id = ++requestSeq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`winmux ${String(msg.op)} timed out`));
    }, opts.timeoutMs ?? 10_000);
    onMessages(socket, (reply: any) => {
      if (reply?.id !== id) return;
      clearTimeout(timer);
      socket.end();
      if (reply.ok) resolve(reply as T);
      else reject(new Error(reply.error || `winmux ${String(msg.op)} failed`));
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    sendMessage(socket, { ...msg, id });
  });
}

/** Like request(), but "no daemon running" means an empty answer instead of an error. */
async function query<T>(msg: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return await request<T>(msg);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT') return fallback;
    throw err;
  }
}

/* ================================================================
   tmux-equivalent helpers
   ================================================================ */

export async function newSession(req: Omit<NewSessionRequest, 'op'>): Promise<{ pid: number }> {
  return request<{ pid: number }>({ op: 'new', ...req }, { autoStart: true });
}

export async function hasSession(name: string): Promise<boolean> {
  const r = await query<{ exists: boolean }>({ op: 'has', name }, { exists: false });
  return !!r.exists;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const r = await query<{ sessions: SessionInfo[] }>({ op: 'list' }, { sessions: [] });
  return r.sessions || [];
}

export async function killSession(name: string): Promise<boolean> {
  const r = await query<{ killed: boolean }>({ op: 'kill', name }, { killed: false });
  return !!r.killed;
}

export async function capturePane(name: string, scrollback?: number): Promise<string | null> {
  const r = await query<{ data: string | null }>({ op: 'capture', name, scrollback }, { data: null });
  return r.data ?? null;
}

export async function resizeSession(name: string, cols: number, rows?: number): Promise<void> {
  await query({ op: 'resize', name, cols, rows }, {});
}

export async function detachClients(name: string): Promise<number> {
  const r = await query<{ detached: number }>({ op: 'detach-clients', name }, { detached: 0 });
  return r.detached || 0;
}

export async function setMeta(name: string, meta: SessionMeta): Promise<void> {
  await query({ op: 'set-meta', name, meta }, {});
}

export async function renameSession(name: string, newName: string, meta?: SessionMeta): Promise<boolean> {
  const r = await query<{ renamed: boolean }>({ op: 'rename', name, newName, meta }, { renamed: false });
  return !!r.renamed;
}

export async function daemonStatus(): Promise<Record<string, unknown> | null> {
  try { return await request({ op: 'status' }, { timeoutMs: 3000 }); } catch { return null; }
}

/* ================================================================
   Attach — an IPty-like handle on a running session
   ================================================================ */

export interface Attachment {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  /** Fired when the daemon detaches us (another client took over) or the pipe drops. */
  onDetach(listener: (reason: string) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Snapshot ordered with the live stream (output before it is included in it). */
  capture(scrollback?: number): Promise<string | null>;
  /** Detach without killing the session. */
  detach(): void;
}

export function attach(
  name: string,
  opts: { cols?: number; rows?: number; snapshot?: boolean; client?: string; onSnapshot?: (data: string | null) => void } = {},
): Promise<Attachment> {
  return new Promise(async (resolve, reject) => {
    let socket: Socket;
    try {
      socket = await connectPipe();
    } catch (err) {
      reject(err);
      return;
    }

    const dataListeners: Array<(d: string) => void> = [];
    const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
    const detachListeners: Array<(r: string) => void> = [];
    const captureWaiters: Array<(d: string | null) => void> = [];
    let snapshotPending = !!opts.snapshot;
    let settled = false;
    let ended = false;
    let pid = 0;
    let cols = opts.cols ?? 0;
    let rows = opts.rows ?? 0;

    const finish = (reason: string) => {
      if (ended) return;
      ended = true;
      for (const w of captureWaiters.splice(0)) w(null);
      for (const l of detachListeners) l(reason);
    };

    const handle: Attachment = {
      get pid() { return pid; },
      get cols() { return cols; },
      get rows() { return rows; },
      onData: (l) => { dataListeners.push(l); },
      onExit: (l) => { exitListeners.push(l); },
      onDetach: (l) => { detachListeners.push(l); },
      write: (data) => { sendMessage(socket, { type: 'input', data }); },
      resize: (c, r) => {
        cols = c; rows = r;
        sendMessage(socket, { type: 'resize', cols: c, rows: r });
      },
      capture: (scrollback) => new Promise((res) => {
        if (ended) { res(null); return; }
        captureWaiters.push(res);
        sendMessage(socket, { type: 'capture', scrollback });
      }),
      detach: () => {
        sendMessage(socket, { type: 'detach' });
        socket.end();
      },
    };

    onMessages(socket, (frame: DaemonFrame) => {
      switch (frame.type) {
        case 'attached':
          pid = frame.pid; cols = frame.cols; rows = frame.rows;
          if (!settled) { settled = true; resolve(handle); }
          break;
        case 'output':
          for (const l of dataListeners) l(frame.data);
          break;
        case 'capture':
          if (snapshotPending) {
            snapshotPending = false;
            opts.onSnapshot?.(frame.data);
          } else {
            captureWaiters.shift()?.(frame.data);
          }
          break;
        case 'exit':
          ended = true;
          for (const l of exitListeners) l({ exitCode: frame.exitCode, signal: frame.signal });
          break;
        case 'detached':
          finish(frame.reason);
          break;
        case 'error':
          if (!settled) { settled = true; reject(new Error(frame.message)); socket.destroy(); }
          break;
      }
    });

    socket.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    socket.on('close', () => {
      if (!settled) { settled = true; reject(new Error(`winmux: attach to ${name} closed`)); return; }
      finish('connection closed');
    });

    sendMessage(socket, {
      op: 'attach',
      name,
      cols: opts.cols,
      rows: opts.rows,
      snapshot: opts.snapshot,
      client: opts.client,
    });
  });
}
