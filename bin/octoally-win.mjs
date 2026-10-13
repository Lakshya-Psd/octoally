#!/usr/bin/env node
// OctoAlly CLI for native Windows (works from cmd.exe, PowerShell and Git Bash).
// Mirrors bin/octoally (the bash CLI used on Linux/macOS). No npm dependencies.
//
// Usage: octoally <start|stop|restart|status|update|channel|logs|install-service|
//                  uninstall-service|service-status|mux|port|help>
//
// Keep console output ASCII-only: PowerShell 5.1 decodes piped output with the
// OEM code page, so non-ASCII characters turn into mojibake.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Paths -------------------------------------------------------------------

const CLI_PATH = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(CLI_PATH);
const INSTALL_DIR = path.resolve(BIN_DIR, '..');
const SERVER_DIR = path.join(INSTALL_DIR, 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'dist', 'index.js');
const DASHBOARD_DIR = path.join(INSTALL_DIR, 'dashboard');
const WINMUX_CLI = path.join(SERVER_DIR, 'dist', 'winmux', 'cli.js');
const CONFIG_FILE = path.join(INSTALL_DIR, '.octoally');
const VERSION_FILE = path.join(INSTALL_DIR, 'version.json');
const PID_FILE = path.join(INSTALL_DIR, '.octoally.pid');
const LOG_DIR = path.join(INSTALL_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'octoally.log');
const DATA_DIR = path.join(os.homedir(), '.octoally');
const DB_PATH = path.join(DATA_DIR, 'octoally.db');
const INSTALL_JSON = path.join(DATA_DIR, 'install.json');
const VBS_LAUNCHER = path.join(BIN_DIR, 'octoally-hidden.vbs');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const RUN_VALUE = 'OctoAlly';

const DEFAULT_PORT = 42010;
const DEFAULT_START_WAIT_SEC = 20;
const IS_WIN = process.platform === 'win32';

// --- Output ------------------------------------------------------------------

const USE_COLOR = !!process.stdout.isTTY && !('NO_COLOR' in process.env);
const paint = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint('0;31');
const green = paint('0;32');
const yellow = paint('1;33');
const cyan = paint('0;36');
const bold = paint('1');

const logInfo = (m) => console.log(`${cyan('[OctoAlly]')} ${m}`);
const logOk = (m) => console.log(`${green('[OctoAlly]')} ${m}`);
const logWarn = (m) => console.log(`${yellow('[OctoAlly]')} ${m}`);
const logError = (m) => console.log(`${red('[OctoAlly]')} ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// --- Config / version --------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// Same lookup as the bash CLI (regex, so a hand-edited file still works).
function getConfigVal(key) {
  try {
    const txt = fs.readFileSync(CONFIG_FILE, 'utf8');
    const m = txt.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function getLocalVersion() {
  const v = getConfigVal('local_version');
  if (v) return v;
  const vj = readJson(VERSION_FILE);
  return vj && vj.version ? String(vj.version) : 'unknown';
}

function getChannel() {
  return getConfigVal('channel') || 'stable';
}

// --- Environment / node / npm ------------------------------------------------

// process.env minus NODE_OPTIONS (case-insensitive: Windows env names are).
// A NODE_OPTIONS preload from the launching shell (context-mode, claude-mem...)
// points at a temp file that dies with that shell; inheriting it would break
// every session the server spawns. Same reason the bash CLI uses `env -u`.
// ELECTRON_RUN_AS_NODE (set when the desktop app runs this CLI through
// Electron) is dropped too, so Electron-based tools the server launches
// (e.g. VS Code's `code`) do not start in node mode.
const SCRUBBED_ENV = new Set(['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']);
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SCRUBBED_ENV.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}

function serverEnv() {
  const env = cleanEnv();
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODE_ENV') delete env[k];
  env.NODE_ENV = 'production';
  return env;
}

// The node.exe used to run the server. When this CLI itself runs under
// Electron (ELECTRON_RUN_AS_NODE), prefer the real node recorded at install.
function nodeBin() {
  if (!process.versions.electron) return process.execPath;
  const info = readJson(INSTALL_JSON);
  if (info && info.node && fs.existsSync(info.node)) return path.normalize(info.node);
  return 'node';
}

function cmdQuote(s) {
  return /[\s"&|<>^()%!]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
}

// Run npm. Prefer `node <nodeDir>\node_modules\npm\bin\npm-cli.js` (no shell,
// same Node as the server). Fall back to `cmd.exe /d /s /c "npm ..."`: Node
// >= 18.20 refuses to spawn .cmd files without a shell (CVE-2024-27980).
function runNpm(args, { cwd, stdio = 'inherit' } = {}) {
  const node = nodeBin();
  const env = cleanEnv();
  if (path.isAbsolute(node)) {
    const npmCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) {
      return spawnSync(node, [npmCli, ...args], { cwd, stdio, env, windowsHide: true });
    }
  }
  const line = ['npm', ...args].map(cmdQuote).join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    cwd,
    stdio,
    env,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

function nativeModulesOk() {
  const r = spawnSync(nodeBin(), ['-e', "require('better-sqlite3'); require('node-pty')"], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    env: cleanEnv(),
    windowsHide: true,
    timeout: 60000,
  });
  return r.status === 0;
}

// --- Port resolution (same order as bash _resolve_server_port) ---------------

let cachedPort = null;

function resolvePort() {
  if (cachedPort === null) cachedPort = resolvePortUncached();
  return cachedPort;
}

function resolvePortUncached() {
  // 1. PORT env var
  const envPort = process.env.PORT;
  if (envPort && /^\d+$/.test(envPort)) return Number(envPort);

  // 2. server/.env PORT= (last one wins, quotes stripped)
  try {
    const lines = fs
      .readFileSync(path.join(SERVER_DIR, '.env'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^\s*PORT\s*=/.test(l));
    if (lines.length) {
      const v = lines[lines.length - 1]
        .replace(/^\s*PORT\s*=\s*/, '')
        .replace(/^["']/, '')
        .replace(/["']\s*$/, '')
        .replace(/\s*$/, '');
      if (/^\d+$/.test(v)) return Number(v);
    }
  } catch {}

  // 3. SQLite settings table (key = server_port). Read in a child process so
  //    this CLI never holds better_sqlite3.node open (Windows locks loaded
  //    DLLs, which would break `npm rebuild` / `npm install`).
  const nm = path.join(SERVER_DIR, 'node_modules');
  if (fs.existsSync(DB_PATH) && fs.existsSync(path.join(nm, 'better-sqlite3'))) {
    const code =
      'try{const D=require(process.env.OCTO_NM+"/better-sqlite3");' +
      'const db=new D(process.env.OCTO_DB,{readonly:true,fileMustExist:true});' +
      'const r=db.prepare("SELECT value FROM settings WHERE key=?").get("server_port");' +
      'db.close();if(r&&r.value)process.stdout.write(String(r.value));}catch(e){}';
    const r = spawnSync(nodeBin(), ['-e', code], {
      env: cleanEnv({ OCTO_NM: nm, OCTO_DB: DB_PATH }),
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const v = String(r.stdout || '').trim();
    if (/^\d+$/.test(v)) return Number(v);
  }

  return DEFAULT_PORT;
}

// --- Processes ---------------------------------------------------------------

function readPidFile() {
  try {
    const n = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function removePidFile() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {}
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Image name (e.g. "node.exe") of a PID, or null if not found.
function imageName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && Number(m[2]) === pid) return m[1];
    }
  } catch {}
  return null;
}

const isNodeImage = (img) => !!img && /^node(\.exe)?$/i.test(img);
const isNodeProcess = (pid) => pidAlive(pid) && isNodeImage(imageName(pid));

// Full command line of a process via CIM (~0.5s), or null if unavailable.
function processCommandLine(pid) {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: cleanEnv() },
  );
  if (r.error || r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  return out || null;
}

// PID from the PID file if it really is our server, else null. Guards against
// PID reuse: a stale PID file (e.g. after a reboot) can point at an unrelated
// node.exe, which `stop` must never kill.
function ourServerPid(port, healthy) {
  const pid = readPidFile();
  if (!pid || !isNodeProcess(pid)) return null;
  if (healthy && listeningPids(port).includes(pid)) return pid; // fast path
  const cmdline = processCommandLine(pid);
  return cmdline && /[\\/]server[\\/]dist[\\/]index\.js/i.test(cmdline) ? pid : null;
}

// Force-kill ONE process. Never /T: the winmux session daemon may be a
// descendant of the server and must survive server stop/restart.
function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

// PIDs listening on a TCP port (IPv4 + IPv6). The state column is localized
// on non-English Windows, so a "foreign address of *:0" also counts as listening.
function listeningPids(port) {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    const local = parts[1];
    const foreign = parts[2];
    const pid = Number(parts[parts.length - 1]);
    const listening =
      /^LISTEN/i.test(parts[3]) || foreign === '0.0.0.0:0' || foreign === '[::]:0';
    if (listening && local.endsWith(`:${port}`) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

// --- Network -----------------------------------------------------------------

function tryConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function portInUse(port) {
  return (await tryConnect('127.0.0.1', port)) || (await tryConnect('::1', port));
}

function httpJson(method, port, urlPath, { timeoutMs = 1500, body } = {}) {
  return new Promise((resolve) => {
    const headers = { connection: 'close' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers, agent: false, timeout: timeoutMs },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, json });
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function health(port) {
  const r = await httpJson('GET', port, '/api/health');
  return r && r.status === 200 && r.json && r.json.name === 'octoally' ? r.json : null;
}

// --- Log helpers ---------------------------------------------------------------

function tailText(file, lines, uptoSize) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = uptoSize ?? fs.fstatSync(fd).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    const out = all.slice(-lines);
    return out.length ? out.join('\n') + '\n' : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// --- winmux / service helpers --------------------------------------------------

// daemon-status prints "winmux: running (...)" / "winmux: not running". The
// desktop app decides the *server* state from `status` output with
// /not running|stopped/ and "running", so reword those here (up/down).
function winmuxStatus() {
  if (!fs.existsSync(WINMUX_CLI)) return 'not built';
  const r = spawnSync(nodeBin(), [WINMUX_CLI, 'daemon-status'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    env: cleanEnv(),
  });
  if (r.error && r.error.code === 'ETIMEDOUT') return 'no answer (daemon-status timed out after 3s)';
  if (r.error) return `unavailable (${r.error.message})`;
  const first = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  const line = first(r.stdout) || first(r.stderr) || `daemon-status exit code ${r.status}`;
  return line
    .replace(/^winmux:\s*/i, '')
    .replace(/\bnot running\b/gi, 'daemon down')
    .replace(/\bstopped\b/gi, 'down')
    .replace(/\brunning\b/gi, 'daemon up');
}

function serviceInstalled() {
  const r = spawnSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return r.status === 0;
}

// --- Commands ------------------------------------------------------------------

function parseOpt(args, names, fallback) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && args[i + 1] !== undefined) return args[i + 1];
    for (const n of names) if (args[i].startsWith(n + '=')) return args[i].slice(n.length + 1);
  }
  return fallback;
}

async function cmdStart(args = []) {
  const noWait = args.includes('--no-wait');
  const waitSec = Math.max(1, Number(parseOpt(args, ['--timeout'], DEFAULT_START_WAIT_SEC)) || DEFAULT_START_WAIT_SEC);
  const port = resolvePort();

  const oldPid = ourServerPid(port, !!(await health(port)));
  if (oldPid) {
    logWarn(`OctoAlly is already running (PID ${oldPid})`);
    logInfo(`Dashboard: http://localhost:${port}`);
    return 0;
  }
  // Stale PID file - remove before starting
  if (fs.existsSync(PID_FILE)) removePidFile();

  // Port pre-flight: avoid silently EADDRINUSE-ing into the log file
  if (await portInUse(port)) {
    if (await health(port)) {
      logWarn(`OctoAlly is already running on port ${port} (not started by this CLI)`);
      logInfo(`Dashboard: http://localhost:${port}`);
      return 0;
    }
    logError(`Port ${port} is already in use by another process.`);
    logInfo("Run 'octoally stop' to clear it, or 'octoally restart'.");
    return 1;
  }

  if (!fs.existsSync(SERVER_ENTRY)) {
    logError(`Server is not built (missing ${SERVER_ENTRY}).`);
    logInfo('Run scripts\\install.ps1, or "npm run build" in dashboard\\ and server\\.');
    return 1;
  }
  if (!fs.existsSync(path.join(DASHBOARD_DIR, 'dist', 'index.html'))) {
    logWarn('Dashboard is not built (dashboard\\dist missing) - the web UI will not load.');
  }

  logInfo('Starting OctoAlly server...');
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Native module guard: if native modules fail to load (Node upgraded since
  // install -> NODE_MODULE_VERSION mismatch), rebuild them for this Node.
  if (!nativeModulesOk()) {
    logWarn('Native module mismatch - rebuilding for current Node...');
    const fd = fs.openSync(LOG_FILE, 'a');
    let r;
    try {
      r = runNpm(['rebuild', 'better-sqlite3', 'node-pty'], { cwd: SERVER_DIR, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    if (r.status === 0 && nativeModulesOk()) {
      logOk('Rebuild complete');
    } else {
      logError(`Rebuild failed - see ${LOG_FILE}`);
      return 1;
    }
  }

  const fd = fs.openSync(LOG_FILE, 'a');
  let child;
  let spawnError = null;
  try {
    child = spawn(nodeBin(), [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      detached: true, // own process group, no console: survives closing this terminal
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: serverEnv(),
    });
    child.on('error', (e) => (spawnError = e));
  } catch (e) {
    spawnError = e;
  } finally {
    fs.closeSync(fd);
  }
  await sleep(100);
  if (spawnError || !child || !child.pid) {
    logError(`Failed to start server: ${spawnError ? spawnError.message : 'unknown error'}`);
    return 1;
  }
  child.unref();
  const pid = child.pid;
  fs.writeFileSync(PID_FILE, String(pid));
  logOk(`OctoAlly started (PID ${pid})`);

  if (noWait) {
    logInfo(`Dashboard: http://localhost:${port}`);
    return 0;
  }

  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    const h = await health(port);
    if (h) {
      logOk(`Server is up${h.version ? ` (v${h.version})` : ''}`);
      logInfo(`Dashboard: http://localhost:${port}`);
      return 0;
    }
    if (!pidAlive(pid)) {
      removePidFile();
      logError(`Server exited during startup. Last lines of ${LOG_FILE}:`);
      process.stdout.write(
        tailText(LOG_FILE, 20)
          .split('\n')
          .map((l) => (l ? `    ${l}` : l))
          .join('\n'),
      );
      return 1;
    }
    await sleep(500);
  }
  logWarn(`Server did not answer on port ${port} within ${waitSec}s - it may still be starting.`);
  logInfo(`Check the log with: octoally logs   (${LOG_FILE})`);
  logInfo(`Dashboard: http://localhost:${port}`);
  return 0;
}

async function forceClearPort(port) {
  const pids = listeningPids(port);
  const nodePids = [];
  for (const pid of pids) {
    const img = imageName(pid);
    if (isNodeImage(img)) nodePids.push(pid);
    else logWarn(`Port ${port} is held by ${img || 'an unknown process'} (PID ${pid}) - not node.exe, leaving it alone.`);
  }
  if (!nodePids.length) return false;
  logWarn(`Force-stopping process on port ${port} (PID ${nodePids.join(', ')})...`);
  for (const pid of nodePids) killPid(pid);
  return waitFor(async () => !(await portInUse(port)), 3000);
}

async function cmdStop() {
  const port = resolvePort();
  const h = await health(port);
  const pid = ourServerPid(port, !!h);
  const pidOk = !!pid;
  let stopped = false;

  if (pidOk || h) {
    logInfo(pidOk ? `Stopping OctoAlly (PID ${pid})...` : `Stopping OctoAlly on port ${port}...`);
    let graceful = false;
    if (h) {
      // Graceful: lets the server flush state; 404 = endpoint not available.
      const r = await httpJson('POST', port, '/api/shutdown', { timeoutMs: 3000, body: '{}' });
      graceful = !!r && r.status >= 200 && r.status < 300;
    }
    if (graceful) {
      const gone = await waitFor(
        async () => (pidOk ? !pidAlive(pid) : !(await portInUse(port))),
        5000,
      );
      if (!gone) logWarn('Graceful stop timed out - force-stopping');
    }
    if (pidOk && pidAlive(pid)) {
      killPid(pid);
      await waitFor(() => !pidAlive(pid), 3000);
    }
    stopped = true;
  }
  removePidFile();

  // Port-based fallback - catches a server started outside this CLI or a stale
  // PID file. Only node.exe listeners on the configured port are killed.
  if (await portInUse(port)) {
    if (await forceClearPort(port)) {
      logOk(`OctoAlly stopped (cleared port ${port})`);
      return 0;
    }
    logError(`Port ${port} is still in use - could not stop the process holding it.`);
    return 1;
  }
  if (stopped) logOk('OctoAlly stopped');
  else logInfo('OctoAlly is not running');
  return 0;
}

async function cmdRestart(args) {
  await cmdStop();
  return cmdStart(args);
}

async function cmdStatus(args = []) {
  const port = resolvePort();
  const h = await health(port);
  const pid = ourServerPid(port, !!h);
  const pidOk = !!pid;
  const running = pidOk || !!h;
  const portBusy = running ? true : await portInUse(port);
  const version = getLocalVersion();
  const channel = getChannel();
  const service = serviceInstalled();
  const winmux = winmuxStatus();

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          status: running ? 'running' : 'stopped',
          pid: pidOk ? pid : null,
          port,
          version,
          serverVersion: h && h.version ? h.version : null,
          channel,
          service: service ? 'installed' : 'not installed',
          winmux,
          installDir: INSTALL_DIR,
          dashboard: `http://localhost:${port}`,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(bold(`OctoAlly v${version}`));
  console.log(`  Install dir:     ${INSTALL_DIR}`);
  console.log(`  Channel:         ${channel}`);
  if (pidOk) {
    console.log(`  Status:          ${green('running')} (PID ${pid})`);
  } else if (h) {
    console.log(`  Status:          ${green('running')} (port ${port}, not started by this CLI)`);
  } else {
    console.log(
      `  Status:          ${red('stopped')}` + (portBusy ? ` (port ${port} is in use by another process)` : ''),
    );
  }
  if (h && h.version) console.log(`  Server version:  ${h.version}`);
  else if (pidOk) console.log(`  Server version:  (not answering on port ${port} yet)`);
  console.log(`  Port:            ${port}`);
  if (running) console.log(`  Dashboard:       http://localhost:${port}`);
  console.log(`  Auto-start:      ${service ? 'installed' : 'not installed'}`);
  console.log(`  winmux:          ${winmux}`);
  return 0;
}

function hasGitCheckout() {
  return fs.existsSync(path.join(INSTALL_DIR, '.git'));
}

async function cmdUpdate(args = []) {
  const force = args.includes('--force');

  if (!hasGitCheckout()) {
    logError('This install is not a git checkout, so it cannot update itself.');
    console.log('');
    console.log('  To update this Windows build:');
    console.log('    1. Download or clone the latest OctoAlly Windows fork source.');
    console.log('    2. Run install.cmd (or scripts\\install.ps1) from the new folder.');
    console.log('  Your data in %USERPROFILE%\\.octoally is kept.');
    return 1;
  }

  const git = (gitArgs, opts = {}) =>
    spawnSync('git', ['-C', INSTALL_DIR, ...gitArgs], { encoding: 'utf8', windowsHide: true, ...opts });
  const probe = git(['--version']);
  if (probe.error || probe.status !== 0) {
    logError('git was not found. Install it from https://git-scm.com/download/win and try again.');
    return 1;
  }

  const head = () => String(git(['rev-parse', 'HEAD']).stdout || '').trim();
  const branch = String(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const before = head();

  // A local branch with no remote (e.g. a fork you merge upstream into by hand):
  // nothing to pull, but --force still reinstalls dependencies and rebuilds.
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.status !== 0) {
    if (!force) {
      logError(`Branch ${branch || 'unknown'} does not track a remote, so there is nothing to pull.`);
      logInfo('Set one with: git push -u <remote> ' + (branch || '<branch>'));
      logInfo("Or, after merging changes yourself, rebuild with: octoally update --force");
      return 1;
    }
    logWarn(`Branch ${branch || 'unknown'} does not track a remote - skipping git pull, rebuilding only.`);
  }

  const pull = upstream.status !== 0
    ? { status: 0 }
    : (logInfo(`Pulling latest changes (branch ${branch || 'unknown'})...`),
       git(['pull', '--ff-only'], { stdio: 'inherit', encoding: undefined }));
  if (pull.status !== 0) {
    logError('git pull --ff-only failed - nothing was changed.');
    logInfo('Common causes: local changes (commit or stash them), a diverged branch, or no upstream branch.');
    logInfo(`Fix it in ${INSTALL_DIR}, then run 'octoally update' again.`);
    return 1;
  }
  const after = head();

  if (before && before === after && !force && fs.existsSync(SERVER_ENTRY)) {
    logOk(`Already up to date (${after.slice(0, 7)})`);
    logInfo("Use 'octoally update --force' to reinstall dependencies and rebuild anyway.");
    return 0;
  }

  // Windows locks loaded native modules (.node files), so npm cannot replace
  // them while the server runs: stop it first, start it again afterwards.
  const port = resolvePort();
  const healthy = !!(await health(port));
  const wasRunning = healthy || !!ourServerPid(port, healthy);
  if (wasRunning) {
    logInfo('Stopping the server while dependencies are updated...');
    await cmdStop();
  }

  const steps = [
    ['Installing server dependencies', SERVER_DIR, ['install', '--no-audit', '--no-fund']],
    ['Installing dashboard dependencies', DASHBOARD_DIR, ['install', '--no-audit', '--no-fund']],
    ['Building dashboard', DASHBOARD_DIR, ['run', 'build']],
    ['Building server', SERVER_DIR, ['run', 'build']],
  ];
  for (const [label, cwd, npmArgs] of steps) {
    logInfo(`${label}...`);
    const r = runNpm(npmArgs, { cwd });
    if (r.status !== 0) {
      logError(`${label} failed (npm ${npmArgs.join(' ')} exited with ${r.status ?? r.error?.message}).`);
      if (wasRunning) {
        logInfo('Trying to start the server again...');
        await cmdStart([]);
      }
      return 1;
    }
  }

  logOk(`Update complete! (${before.slice(0, 7)} -> ${after.slice(0, 7)})`);
  if (wasRunning) {
    logInfo('Restarting...');
    return cmdStart([]);
  }
  return 0;
}

function cmdChannel(args = []) {
  const target = args[0];
  if (!target) {
    console.log(`${bold('Current channel:')} ${getConfigVal('channel') || 'stable'}`);
    console.log('');
    console.log('Available channels:');
    console.log('  stable   Production releases (default)');
    console.log('  beta     Pre-release testing');
    console.log('  canary   Latest development builds');
    console.log('');
    console.log('Switch with: octoally channel <name>');
    return 0;
  }

  if (!['stable', 'beta', 'canary'].includes(target)) {
    logError(`Unknown channel: ${target} (valid: stable, beta, canary)`);
    return 1;
  }

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = readJson(CONFIG_FILE);
      if (cfg && typeof cfg === 'object') {
        cfg.channel = target;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
      } else {
        const txt = fs.readFileSync(CONFIG_FILE, 'utf8');
        if (!/"channel"\s*:\s*"[^"]*"/.test(txt)) {
          logError(`Could not update ${CONFIG_FILE} (no "channel" key).`);
          return 1;
        }
        fs.writeFileSync(CONFIG_FILE, txt.replace(/"channel"\s*:\s*"[^"]*"/, `"channel": "${target}"`));
      }
    } else {
      const cfg = { channel: target, local_version: getLocalVersion() };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
    }
  } catch (e) {
    logError(`Could not write ${CONFIG_FILE}: ${e.message}`);
    return 1;
  }

  logOk(`Switched to ${target} channel`);
  logInfo("Note: this Windows build updates from git - run 'octoally update' to pull the latest source.");
  return 0;
}

async function cmdLogs(args = []) {
  const follow = !args.includes('--no-follow');
  const lines = Math.max(1, Number(parseOpt(args, ['-n', '--lines'], 100)) || 100);

  if (!fs.existsSync(LOG_FILE)) {
    if (!fs.existsSync(SERVER_ENTRY)) {
      logError(`No log file yet and the server is not built (missing ${SERVER_ENTRY}).`);
      return 1;
    }
    logInfo('Starting server in foreground (Ctrl+C to stop)...');
    const r = spawnSync(nodeBin(), [SERVER_ENTRY], { cwd: SERVER_DIR, stdio: 'inherit', env: serverEnv() });
    return r.status ?? 1;
  }

  let pos = fs.statSync(LOG_FILE).size;
  process.stdout.write(tailText(LOG_FILE, lines, pos));
  if (!follow) return 0;

  // tail -f: poll for appended bytes; restart from 0 if the file was truncated.
  await new Promise(() => {
    setInterval(() => {
      let st;
      try {
        st = fs.statSync(LOG_FILE);
      } catch {
        return;
      }
      if (st.size < pos) pos = 0;
      if (st.size === pos) return;
      let fd;
      try {
        fd = fs.openSync(LOG_FILE, 'r');
        while (pos < st.size) {
          const len = Math.min(st.size - pos, 1024 * 1024);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, pos);
          if (n <= 0) break;
          process.stdout.write(buf.subarray(0, n));
          pos += n;
        }
      } catch {
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }, 500);
  });
  return 0;
}

function cmdInstallService() {
  const node = nodeBin();
  if (!path.isAbsolute(node) || !fs.existsSync(node)) {
    logError(`Could not resolve an absolute node.exe path (tried: ${node})`);
    return 1;
  }

  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const wscript = path.join(sysRoot, 'System32', 'wscript.exe');
  let command;
  let how;
  if (fs.existsSync(wscript) && fs.existsSync(VBS_LAUNCHER)) {
    // wscript + .vbs starts node with no window at all.
    command = `"${wscript}" //B //Nologo "${VBS_LAUNCHER}" "${node}" start`;
    how = 'wscript.exe (hidden)';
  } else {
    // Fallback: a hidden PowerShell window (may flash briefly at login).
    const psPath = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const ps = fs.existsSync(psPath) ? psPath : 'powershell.exe';
    const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
    command = `"${ps}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ${sq(node)} ${sq(CLI_PATH)} start"`;
    how = 'PowerShell (hidden window)';
  }

  logInfo('Installing login auto-start for the current user (no admin needed)...');
  try {
    execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) {
    logError(`Could not write ${RUN_KEY}\\${RUN_VALUE}: ${e.message}`);
    return 1;
  }
  // Clear a "disabled" flag left by Task Manager > Startup apps, if any.
  spawnSync('reg', ['delete', STARTUP_APPROVED_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore', windowsHide: true });

  logOk(`Auto-start installed - OctoAlly starts at login via ${how}`);
  logInfo(`Registry: ${RUN_KEY}\\${RUN_VALUE}`);
  logInfo(`Auto-start output is logged to ${path.join(LOG_DIR, 'autostart.log')}`);
  logInfo("Start it now with: octoally start");
  return 0;
}

function cmdUninstallService() {
  logInfo('Removing login auto-start...');
  spawnSync('reg', ['delete', STARTUP_APPROVED_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore', windowsHide: true });
  if (!serviceInstalled()) {
    logInfo('Auto-start is not installed');
    return 0;
  }
  try {
    execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    logError(`Could not remove ${RUN_KEY}\\${RUN_VALUE}: ${e.message}`);
    return 1;
  }
  logOk('Auto-start removed (a running server is left running; use "octoally stop")');
  return 0;
}

function cmdServiceStatus() {
  console.log(serviceInstalled() ? 'installed' : 'not installed');
  return 0;
}

function cmdMux(args = []) {
  if (!fs.existsSync(WINMUX_CLI)) {
    logError(`winmux is not built yet (missing ${WINMUX_CLI}).`);
    logInfo('Build the server first: npm run build (in server\\)');
    return 1;
  }
  const r = spawnSync(nodeBin(), [WINMUX_CLI, ...args], { stdio: 'inherit', env: cleanEnv() });
  if (r.error) {
    logError(`Failed to run winmux: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function cmdHelp() {
  console.log(bold('OctoAlly CLI (Windows)'));
  console.log('');
  console.log('Usage: octoally <command>');
  console.log('');
  console.log('Commands:');
  console.log('  start [--no-wait]    Start the OctoAlly server (waits up to 20s for it to answer)');
  console.log('  stop                 Stop the OctoAlly server (terminal sessions keep running)');
  console.log('  restart              Restart the OctoAlly server');
  console.log('  status [--json]      Show server status, version, port, channel and winmux info');
  console.log('  update [--force]     Pull the latest source with git and rebuild');
  console.log('  channel [name]       Show or switch release channel (stable/beta/canary)');
  console.log('  logs [--no-follow]   Show/follow server logs (-n <lines>, default 100)');
  console.log('  install-service      Start OctoAlly automatically at login (no admin needed)');
  console.log('  uninstall-service    Remove the login auto-start');
  console.log('  service-status       Print "installed" or "not installed"');
  console.log('  mux <args...>        Run the winmux session daemon CLI (try: octoally mux help)');
  console.log('  port                 Print the configured server port');
  console.log('  help                 Show this help message');
  return 0;
}

// --- Main ------------------------------------------------------------------------

async function main(argv) {
  const [cmd = 'help', ...rest] = argv;
  if (!IS_WIN && !['help', '--help', '-h'].includes(cmd)) {
    logError('bin/octoally-win.mjs is the Windows CLI. On Linux/macOS use bin/octoally.');
    return 1;
  }
  switch (cmd) {
    case 'start':
      return cmdStart(rest);
    case 'stop':
      return cmdStop();
    case 'restart':
      return cmdRestart(rest);
    case 'status':
      return cmdStatus(rest);
    case 'update':
      return cmdUpdate(rest);
    case 'channel':
      return cmdChannel(rest);
    case 'logs':
      return cmdLogs(rest);
    case 'install-service':
      return cmdInstallService();
    case 'uninstall-service':
      return cmdUninstallService();
    case 'service-status':
      return cmdServiceStatus();
    case 'mux':
      return cmdMux(rest);
    case 'port':
      console.log(resolvePort());
      return 0;
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    default:
      logError(`Unknown command: ${cmd}`);
      cmdHelp();
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
    // Let stdout drain naturally; force-exit only if a stray handle lingers.
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  },
  (err) => {
    logError(err && err.stack ? err.stack : String(err));
    process.exit(1);
  },
);
