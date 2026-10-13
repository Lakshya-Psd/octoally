/**
 * winmux — OctoAlly's tmux replacement for native Windows.
 *
 * A per-user daemon owns every session's ConPTY (via node-pty) plus a headless
 * xterm that mirrors the screen, so sessions survive OctoAlly server restarts,
 * can be popped out into Windows Terminal and adopted back, and can produce a
 * clean "capture-pane" snapshot at any time.
 *
 * Wire format: newline-delimited JSON over a named pipe.
 *  - Request/response: client sends { id, op, ... }, daemon answers { id, ok, ... }.
 *  - Attach: client sends { op: 'attach', ... }; the connection then becomes a
 *    stream of { type: 'output' | 'exit' | 'capture' | 'detached' } frames from
 *    the daemon and { type: 'input' | 'resize' | 'capture' | 'detach' } frames
 *    from the client.
 */

import { userInfo } from 'os';
import type { Socket } from 'net';

export const PROTOCOL_VERSION = 1;

export function pipePath(): string {
  if (process.env.OCTOALLY_MUX_PIPE) return process.env.OCTOALLY_MUX_PIPE;
  let user = 'user';
  try { user = userInfo().username; } catch { /* ignore */ }
  const safe = user.replace(/[^A-Za-z0-9_.-]/g, '_') || 'user';
  return `\\\\.\\pipe\\octoally-mux-${safe}`;
}

/** Session metadata. `owner: 'octoally'` sessions belong to the dashboard;
 *  `owner: 'external'` ones were started from a terminal with `octoally mux new`
 *  and show up in the dashboard's "External sessions" list for adoption. */
export interface SessionMeta {
  owner?: 'octoally' | 'external';
  projectPath?: string;
  task?: string;
  cliType?: 'claude' | 'codex';
  [key: string]: string | undefined;
}

export interface NewSessionRequest {
  op: 'new';
  name: string;
  file: string;
  /** Array → quoted by node-pty; string → raw Windows command line. */
  args: string[] | string;
  cwd: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  meta?: SessionMeta;
  /** Scrollback lines kept for capture (default 10000). */
  historyLimit?: number;
}

export interface SessionInfo {
  name: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  command: string;
  clients: number;
  meta: SessionMeta;
}

export type Request =
  | ({ id: number } & NewSessionRequest)
  | { id: number; op: 'has'; name: string }
  | { id: number; op: 'list' }
  | { id: number; op: 'kill'; name: string }
  | { id: number; op: 'capture'; name: string; scrollback?: number }
  | { id: number; op: 'resize'; name: string; cols: number; rows?: number }
  | { id: number; op: 'detach-clients'; name: string }
  | { id: number; op: 'set-meta'; name: string; meta: SessionMeta }
  | { id: number; op: 'rename'; name: string; newName: string; meta?: SessionMeta }
  | { id: number; op: 'status' }
  | { id: number; op: 'shutdown' };

export interface AttachRequest {
  op: 'attach';
  name: string;
  /** Resize the session to this size on attach (latest client wins, like tmux). */
  cols?: number;
  rows?: number;
  /** Send a capture snapshot before live output (used by the terminal client). */
  snapshot?: boolean;
  /** Free-form label shown in `ls` (e.g. 'octoally-worker', 'terminal'). */
  client?: string;
}

/** Frames sent by the daemon on an attached connection. */
export type DaemonFrame =
  | { type: 'attached'; pid: number; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'capture'; data: string | null }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'detached'; reason: string }
  | { type: 'error'; message: string };

/** Frames sent by a client on an attached connection. */
export type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'capture'; scrollback?: number }
  | { type: 'detach' };

/** Split a socket's byte stream into JSON messages. */
export function onMessages(socket: Socket, handler: (msg: any) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      handler(msg);
    }
  });
}

export function sendMessage(socket: Socket, msg: unknown): boolean {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(JSON.stringify(msg) + '\n');
}
