import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';

const IS_WINDOWS = process.platform === 'win32';
const SERVER_PORT = 42010;

// ---------------------------------------------------------------------------
// Windows install discovery
// ---------------------------------------------------------------------------

/** Shape of %USERPROFILE%\.octoally\install.json written by the Windows installer */
interface WindowsInstallInfo {
  installDir?: string;
  cli?: string;
  node?: string;
}

function readWindowsInstallInfo(): WindowsInstallInfo {
  try {
    const p = path.join(os.homedir(), '.octoally', 'install.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Default CLI location for a Windows install rooted at installDir */
function windowsCliInDir(installDir: string): string {
  return path.join(path.normalize(installDir), 'bin', 'octoally-win.mjs');
}

/**
 * Resolve the Windows CLI script (octoally-win.mjs).
 * Order: OCTOALLY_INSTALL_DIR → install.json → %USERPROFILE%\octoally.
 */
function resolveWindowsCliPath(): string {
  const envDir = process.env.OCTOALLY_INSTALL_DIR;
  if (envDir) {
    const p = windowsCliInDir(envDir);
    if (fs.existsSync(p)) return p;
  }

  const info = readWindowsInstallInfo();
  if (info.cli && fs.existsSync(path.normalize(info.cli))) {
    return path.normalize(info.cli);
  }
  if (info.installDir) {
    const p = windowsCliInDir(info.installDir);
    if (fs.existsSync(p)) return p;
  }

  const fallback = windowsCliInDir(path.join(os.homedir(), 'octoally'));
  if (!fs.existsSync(fallback)) {
    console.warn(
      `[OctoAlly] CLI not found (checked OCTOALLY_INSTALL_DIR, ~/.octoally/install.json, ${fallback})`,
    );
  }
  return fallback;
}

let cachedNodeBinary: { cmd: string; electronAsNode: boolean } | null = null;

/**
 * Resolve a real node.exe to run the Windows CLI with. Electron's own
 * process.execPath is electron.exe, so it is only used (with
 * ELECTRON_RUN_AS_NODE=1) as a last resort.
 */
function resolveWindowsNodeBinary(): { cmd: string; electronAsNode: boolean } {
  if (cachedNodeBinary && fs.existsSync(cachedNodeBinary.cmd)) return cachedNodeBinary;

  const candidates: string[] = [];
  const info = readWindowsInstallInfo();
  if (info.node) candidates.push(path.normalize(info.node));

  try {
    const out = execFileSync('where.exe', ['node'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: envWithPath(process.env, buildNodeAwarePath()),
    });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && p.toLowerCase().endsWith('.exe')) candidates.push(p);
    }
  } catch {}

  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedNodeBinary = { cmd: c, electronAsNode: false };
      return cachedNodeBinary;
    }
  }

  console.warn('[OctoAlly] node.exe not found — falling back to Electron in node mode');
  cachedNodeBinary = { cmd: process.execPath, electronAsNode: true };
  return cachedNodeBinary;
}

/**
 * Return a copy of env with PATH replaced. On Windows env keys are
 * case-insensitive ("Path" vs "PATH"), so drop any other casing first —
 * otherwise the child may see the stale value.
 */
function envWithPath(base: NodeJS.ProcessEnv, newPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (IS_WINDOWS) {
    for (const k of Object.keys(env)) {
      if (k !== 'PATH' && k.toLowerCase() === 'path') delete env[k];
    }
  }
  env.PATH = newPath;
  return env;
}

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Run an octoally CLI command.
 * POSIX: execFile the CLI directly (unchanged behaviour).
 * Windows: run `node octoally-win.mjs <args>` — never spawn the .cmd shim
 * (execFile cannot run .cmd files without a shell, CVE-2024-27980).
 */
function runCli(
  cli: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<CliResult> {
  if (!IS_WINDOWS) {
    return new Promise((resolve) => {
      execFile(cli, args, { timeout: timeoutMs, env }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err?.message,
        });
      });
    });
  }

  return new Promise((resolve) => {
    if (!fs.existsSync(cli)) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: `OctoAlly CLI not found at ${cli}. Reinstall OctoAlly or set OCTOALLY_INSTALL_DIR.`,
      });
      return;
    }

    const node = resolveWindowsNodeBinary();
    const childEnv = envWithPath(env || process.env, buildNodeAwarePath());
    if (node.electronAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1';

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(node.cmd, [cli, ...args], {
        env: childEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      finish({ ok: false, stdout, stderr, error: e?.message || String(e) });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, stdout, stderr, error: `octoally ${args.join(' ')} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => finish({ ok: false, stdout, stderr, error: e.message }));
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exit code ${code}` });
    });
    // If `start` leaves a detached server holding the pipes, 'close' never
    // fires — resolve shortly after the CLI process itself exits.
    child.on('exit', (code) => {
      setTimeout(() => {
        finish({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exit code ${code}` });
      }, 1000);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the octoally CLI path (mirrors Rust logic in desktop/src/main.rs) */
export function resolveCliPath(): string {
  if (IS_WINDOWS) return resolveWindowsCliPath();

  // Check the standard install path directly first
  if (fs.existsSync('/usr/local/bin/octoally')) {
    // Resolve symlinks — use realpath (works on macOS + Linux) with readlink -f as fallback
    try {
      const resolved = execFileSync('realpath', ['/usr/local/bin/octoally'], {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    try {
      const resolved = execFileSync('readlink', ['-f', '/usr/local/bin/octoally'], {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    return '/usr/local/bin/octoally';
  }

  // Fallback: check ~/.local/bin
  const home = process.env.HOME;
  if (home) {
    const localPath = path.join(home, '.local/bin/octoally');
    if (fs.existsSync(localPath)) return localPath;
  }

  // Last resort: rely on PATH
  return 'octoally';
}

/** Check if OctoAlly server is currently running (managed by the CLI) */
export async function isServerRunning(cli: string): Promise<boolean> {
  const res = await runCli(cli, ['status'], 5000);
  // CLI may exit non-zero but still output status — check stdout/stderr
  const output = (res.stdout + res.stderr).toLowerCase();
  if (IS_WINDOWS && /not running|stopped/.test(output)) return false;
  return output.includes('running');
}

/** Check if the server is reachable via HTTP */
export function isServerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${SERVER_PORT}/api/health`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Sort node version directory names (v18.1.0, v20.3.1, ...) ascending */
function sortNodeVersions(dirs: string[]): string[] {
  return dirs
    .filter((d) => d.startsWith('v'))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number);
      const pb = b.slice(1).split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    });
}

/** Windows node install locations (nvm-windows, Volta, fnm, official installer, npm, scoop) */
function windowsNodeDirs(): string[] {
  const home = os.homedir();
  const env = process.env;
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const dirs: string[] = [];
  if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
  if (env.NVM_HOME) dirs.push(env.NVM_HOME);
  dirs.push(
    path.join(localAppData, 'Volta', 'bin'),
    path.join(programFiles, 'Volta'),
    path.join(appData, 'fnm', 'aliases', 'default'),
    path.join(programFiles, 'nodejs'),
    path.join(appData, 'npm'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'scoop', 'shims'),
  );
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * Build a PATH that includes node binary directories that may not be present
 * when the app is launched from a desktop environment (e.g. task manager, dock).
 * Interactive shells load nvm/fnm/volta via .bashrc/.zshrc, but desktop-launched
 * processes inherit the bare session environment which typically lacks these.
 *
 * NOTE: duplicated from server/src/utils/enrich-path.ts because Electron and
 * the server are separate build targets that cannot share modules at runtime.
 */
function buildNodeAwarePath(): string {
  const currentPath = process.env.PATH || '';
  const home = os.homedir();
  const extraDirs: string[] = [];

  if (IS_WINDOWS) {
    extraDirs.push(...windowsNodeDirs());
  } else {
    // nvm: scan for the highest installed node version
    const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
    const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      try {
        const versions = sortNodeVersions(fs.readdirSync(nvmVersionsDir));
        if (versions.length > 0) {
          const latest = versions[versions.length - 1];
          extraDirs.push(path.join(nvmVersionsDir, latest, 'bin'));
        }
      } catch {}
    }

    // fnm (Fast Node Manager)
    const fnmDir = path.join(home, '.local', 'share', 'fnm', 'node-versions');
    if (fs.existsSync(fnmDir)) {
      try {
        const versions = sortNodeVersions(fs.readdirSync(fnmDir));
        if (versions.length > 0) {
          const latest = versions[versions.length - 1];
          extraDirs.push(path.join(fnmDir, latest, 'installation', 'bin'));
        }
      } catch {}
    }

    // volta
    const voltaBin = path.join(home, '.volta', 'bin');
    if (fs.existsSync(voltaBin)) {
      extraDirs.push(voltaBin);
    }

    // Common system paths that may be missing from desktop sessions
    for (const p of ['/usr/local/bin', path.join(home, '.local', 'bin')]) {
      if (fs.existsSync(p)) extraDirs.push(p);
    }
  }

  // Prepend discovered dirs to PATH (only those not already present).
  // Windows paths are case-insensitive and may carry a trailing slash.
  const norm = (p: string) =>
    IS_WINDOWS ? p.replace(/[\\/]+$/, '').toLowerCase() : p;
  const pathSet = new Set(currentPath.split(path.delimiter).map(norm));
  const toAdd = extraDirs.filter((d, i) =>
    !pathSet.has(norm(d)) && extraDirs.findIndex((x) => norm(x) === norm(d)) === i,
  );

  return toAdd.length > 0 ? [...toAdd, currentPath].join(path.delimiter) : currentPath;
}

/** Start the server via CLI */
export async function startServer(cli: string): Promise<boolean> {
  const env = envWithPath(process.env, buildNodeAwarePath());
  if (IS_WINDOWS) {
    // Our 3s watchdog relaunches the server, so the server's "Restart Server"
    // endpoint must skip its own relaunch helper.
    env.OCTOALLY_SUPERVISED = '1';
  }
  // Windows CLI waits up to 20s for /api/health itself (and may rebuild native modules first)
  const res = await runCli(cli, ['start'], IS_WINDOWS ? 60000 : 15000, env);
  if (!res.ok) {
    console.error('[OctoAlly] Failed to start server:', res.error, (res.stderr || res.stdout).trim());
  }
  return res.ok;
}

/** Stop the server via CLI */
export async function stopServer(cli: string): Promise<boolean> {
  const res = await runCli(cli, ['stop'], 10000);
  if (!res.ok && IS_WINDOWS) {
    // CLI could not stop it (e.g. started outside the CLI) — stop by port
    console.warn('[OctoAlly] CLI stop failed, stopping by port:', res.error);
    return stopServerOnPort();
  }
  return res.ok;
}

/** Wait until the server stops answering, polling every 300ms */
async function waitForServerDown(maxWaitMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!(await isServerReachable())) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !(await isServerReachable());
}

/** Ask the server to shut itself down gracefully (POST /api/shutdown) */
function requestGracefulShutdown(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: 'localhost',
        port: SERVER_PORT,
        path: '/api/shutdown',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      },
      (res) => {
        res.resume();
        resolve(!!res.statusCode && res.statusCode < 400);
      },
    );
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
    req.end('{}');
  });
}

/** Find PIDs listening on the server port via `netstat -ano -p tcp` (Windows) */
function findListeningPidsWindows(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const pids = new Set<number>();
      for (const line of String(stdout).split(/\r?\n/)) {
        // "  TCP    127.0.0.1:42010    0.0.0.0:0    LISTENING    1234"
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
        if (!parts[1].endsWith(`:${SERVER_PORT}`)) continue;
        if (parts[3].toUpperCase() !== 'LISTENING') continue;
        const pid = parseInt(parts[4], 10);
        if (pid > 0) pids.add(pid);
      }
      resolve([...pids]);
    });
  });
}

/** Stop whatever process is listening on port 42010 (for external/unknown servers) */
export async function stopServerOnPort(): Promise<boolean> {
  if (!IS_WINDOWS) {
    return new Promise((resolve) => {
      execFile('fuser', ['-k', `${SERVER_PORT}/tcp`], { timeout: 10000 }, (err) => {
        resolve(!err);
      });
    });
  }

  // 1. Graceful shutdown endpoint
  if (await requestGracefulShutdown()) {
    if (await waitForServerDown(5000)) return true;
  }

  // 2. Kill the listening process only (no /T — the session daemon must survive)
  const pids = await findListeningPidsWindows();
  if (pids.length === 0) return !(await isServerReachable());
  for (const pid of pids) {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 10000, windowsHide: true }, (err) => {
        if (err) console.warn(`[OctoAlly] taskkill ${pid} failed:`, err.message);
        resolve();
      });
    });
  }
  return waitForServerDown(5000);
}

/** Wait for the server to become reachable, polling every 500ms */
export async function waitForServer(maxWaitMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isServerReachable()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Check if the systemd/launchd service (or Windows HKCU Run entry) is installed */
export function isServiceInstalled(): boolean {
  if (process.platform === 'linux') {
    return fs.existsSync('/etc/systemd/system/octoally.service');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (home) {
      return fs.existsSync(
        path.join(home, 'Library/LaunchAgents/com.aigenius.octoally.plist'),
      );
    }
  }
  if (IS_WINDOWS) {
    // `octoally install-service` registers an HKCU Run value named OctoAlly
    try {
      execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OctoAlly'],
        { timeout: 3000, windowsHide: true, stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Toggle service install/uninstall */
export function toggleService(cli: string): Promise<boolean> {
  const installed = isServiceInstalled();
  const cmd = installed ? 'uninstall-service' : 'install-service';

  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      // Use pkexec for graphical sudo prompt (same as Tauri version)
      execFile('pkexec', [cli, cmd], { timeout: 30000 }, (err) => {
        resolve(!err);
      });
    } else {
      // macOS: CLI directly. Windows: HKCU Run key, no elevation needed.
      runCli(cli, [cmd], 30000).then((res) => {
        if (!res.ok) console.error(`[OctoAlly] ${cmd} failed:`, res.error, (res.stderr || res.stdout).trim());
        resolve(res.ok);
      });
    }
  });
}
