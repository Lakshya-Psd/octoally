// End-to-end check of the Windows session stack against a real server:
//   terminal session → server restart (session survives) → pop-out → re-adopt →
//   external `octoally mux new` session adoption → kill → shutdown.
//
// Usage: node scripts/e2e-windows.mjs [--no-popout]
// Runs the compiled server (npm run build first) on port 42099 with a throwaway
// home directory, so your real ~/.claude and ~/.octoally are not touched.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 42099;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), 'octoally-e2e-'));
const skipPopout = process.argv.includes('--no-popout');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const realHome = process.env.USERPROFILE;
const env = {
  ...process.env,
  PORT: String(PORT),
  USERPROFILE: home,
  HOME: home,
  DB_PATH: join(home, 'octoally.db'),
  OCTOALLY_SHELL: 'powershell',
  Path: `${process.env.Path || process.env.PATH};${realHome}\\.local\\bin`,
};

let server = null;
function startServer() {
  server = spawn(process.execPath, [join(root, 'dist', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(d); });
}
async function waitHealth(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return await r.json(); } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error('server did not become healthy');
}
async function api(method, path, body) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

/** Open a terminal WebSocket, send our size, collect output. */
function openTerminal(id, cols = 100, rows = 30) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal/${id}`);
  const t = { ws, out: '', exited: null };
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'output') t.out += msg.data;
    if (msg.type === 'exit') t.exited = msg;
  });
  t.ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'resize', cols, rows })); resolve(); });
    ws.addEventListener('error', reject);
  });
  t.type = (s) => ws.send(JSON.stringify({ type: 'input', data: s }));
  t.waitFor = async (needle, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (strip(t.out).includes(needle)) return true; await sleep(100); }
    return false;
  };
  return t;
}

const mux = (...args) => execFileSync(process.execPath, [join(root, 'dist', 'winmux', 'cli.js'), ...args], { encoding: 'utf8', env, windowsHide: true });

try {
  startServer();
  await waitHealth();
  check('server healthy', true);

  const plat = await api('GET', '/platform');
  check('/api/platform', plat.body.platform === 'win32' && plat.body.drivesRoot === '::drives', JSON.stringify(plat.body));

  const projectDir = join(root, '..', '..').replace(/\//g, '\\') + '\\'; // typed with backslashes + trailing slash
  const created = await api('POST', '/projects', { name: 'E2E', path: projectDir });
  const project = created.body.project || created.body;
  check('project path normalised', /^[A-Z]:\/.*[^/]$/.test(project.path || '') && !project.path.includes('\\'), project.path);

  const drives = await api('GET', '/browse?path=::drives');
  check('browse ::drives lists C:/', drives.body.dirs?.some((d) => d.path === 'C:/'), JSON.stringify(drives.body.dirs?.map((d) => d.path)));
  const croot = await api('GET', '/browse?path=C:/');
  check('browse C:/ has parent ::drives', croot.body.parent === '::drives' && croot.body.path === 'C:/', `${croot.body.path} parent=${croot.body.parent}`);

  // File-viewer preview server (own origin) + file endpoints
  const pb = plat.body.previewBase;
  check('preview server advertised', /^http:\/\/127\.0\.0\.1:\d+$/.test(pb || ''), String(pb));
  const previewSample = join(home, 'preview sample.txt');
  writeFileSync(previewSample, 'x'.repeat(1000));
  const sampleUrl = `${pb}/${previewSample.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/')}`;
  const full = await fetch(sampleUrl);
  check('preview serves a file (path with a space)', full.status === 200 && (await full.text()).length === 1000, String(full.status));
  const part = await fetch(sampleUrl, { headers: { Range: 'bytes=10-19' } });
  check('preview supports range requests (video seeking)', part.status === 206 && (await part.text()).length === 10, String(part.status));
  const blocked = await fetch(`${BASE}/api/sessions`, { headers: { Origin: pb } });
  check('API refuses requests from previewed pages', blocked.status === 403, String(blocked.status));
  const st = await api('GET', `/files/stat?path=${encodeURIComponent(previewSample)}`);
  check('files/stat', st.body.exists === true && st.body.size === 1000, JSON.stringify(st.body));
  const binFile = join(home, 'blob.dat');
  writeFileSync(binFile, Buffer.from([1, 0, 2, 3]));
  const rb = await api('GET', `/files/read?path=${encodeURIComponent(binFile)}`);
  check('binary files are flagged, not shown as text', rb.body.binary === true, JSON.stringify(rb.body).slice(0, 120));

  // 1. Terminal session
  const s1 = await api('POST', '/sessions', { project_path: project.path, project_id: project.id, mode: 'terminal', task: 'Terminal' });
  const id = s1.body.session.id;
  let t = openTerminal(id);
  await t.ready;
  await sleep(3000);
  t.type('echo ("winmux-" + "e2e")\r');
  check('terminal output streams', await t.waitFor('winmux-e2e'));
  check('terminal cwd is project', strip(t.out).includes(project.path.replace(/\//g, '\\')), project.path);
  t.ws.close();
  check('winmux has session', mux('ls').includes(`of-${id}`));

  // 2. Server restart — session must survive and reconnect with its screen
  execFileSync('taskkill', ['/PID', String(server.pid), '/F'], { windowsHide: true });
  await sleep(1500);
  check('session alive while server is down', mux('ls').includes(`of-${id}`));
  startServer();
  await waitHealth();
  await sleep(1500);
  const after = await api('GET', `/sessions/${id}`);
  check('session reconnected after restart', ['running', 'detached'].includes(after.body.session?.status), after.body.session?.status);
  t = openTerminal(id);
  await t.ready;
  check('replay after restart shows earlier output', await t.waitFor('winmux-e2e', 8000));
  t.type('echo ("after-" + "restart")\r');
  check('input works after restart', await t.waitFor('after-restart'));

  // 3. Pop-out to a console window, then re-adopt
  if (!skipPopout) {
    const pop = await api('POST', `/sessions/${id}/pop-out`);
    check('pop-out opened a terminal', pop.body.ok === true, JSON.stringify(pop.body));
    await sleep(3000);
    const ls = mux('ls');
    check('popped-out console attached', new RegExp(`of-${id}: .* 1 client`).test(ls), ls.trim());
    const disc = await api('GET', `/sessions/discoverable?project_path=${encodeURIComponent(project.path)}`);
    const entry = disc.body.sessions?.find((s) => s.socketPath === `tmux:of-${id}`);
    check('released session is discoverable', !!entry, JSON.stringify(disc.body.sessions));
    const adopt = await api('POST', '/sessions/adopt', { socket_path: `tmux:of-${id}` });
    check('re-adopt succeeded', adopt.body.ok === true, JSON.stringify(adopt.body).slice(0, 200));
    t.ws.close();
    t = openTerminal(id);
    await t.ready;
    t.type('echo ("back-" + "home")\r');
    check('input works after re-adopt', await t.waitFor('back-home'));
    await sleep(1000);
    check('console was detached on re-adopt', new RegExp(`of-${id}: .* 1 client`).test(mux('ls')));
  }

  // 4. External session started from a terminal, adopted into the dashboard
  mux('new', '-d', '-s', 'ext-e2e', '-c', project.path, '-t', 'external e2e', '--', 'powershell.exe', '-NoLogo', '-NoProfile');
  const disc2 = await api('GET', `/sessions/discoverable?project_path=${encodeURIComponent(project.path)}`);
  check('external session discoverable', disc2.body.sessions?.some((s) => s.socketPath === 'winmux:ext-e2e' && s.task === 'external e2e'), JSON.stringify(disc2.body.sessions));
  const adopted = await api('POST', '/sessions/adopt', { socket_path: 'winmux:ext-e2e', project_id: project.id });
  const extId = adopted.body.session?.id;
  check('external adopt created session', !!extId, JSON.stringify(adopted.body).slice(0, 200));
  const te = openTerminal(extId);
  await te.ready;
  await sleep(2500);
  te.type('echo ("ext-" + "adopted")\r');
  check('adopted external session works', await te.waitFor('ext-adopted'));
  check('external session renamed to of-<id>', mux('ls').includes(`of-${extId}`) && !mux('ls').includes('ext-e2e'));

  // 5. Status line installer (writes only into the throwaway home)
  const sl = await api('POST', '/settings/statusline/install');
  check('status line install', sl.body.ok === true, JSON.stringify(sl.body));
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const slCmd = settings.statusLine?.command || '';
  check('status line command is node + script', /^node ".*octoally-statusline\.cjs"$/.test(slCmd), slCmd);
  const sample = JSON.stringify({ workspace: { current_dir: project.path }, model: { id: 'claude-opus-4-6' }, cost: { total_duration_ms: 65000 } });
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const shells = [
    ['cmd', () => execFileSync('cmd.exe', ['/d', '/s', '/c', `"${slCmd}"`], { input: sample, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true })],
    ['PowerShell', () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', slCmd], { input: sample, encoding: 'utf8', windowsHide: true })],
    ['Git Bash', () => execFileSync(gitBash, ['-c', slCmd], { input: sample, encoding: 'utf8', windowsHide: true })],
  ];
  for (const [name, run] of shells) {
    if (name === 'Git Bash' && !existsSync(gitBash)) continue;
    let out = '';
    try { out = strip(run()); } catch (err) { out = `ERROR ${err.message}`; }
    check(`status line runs from ${name}`, out.includes('Opus 4.6') && out.includes('1m'), out.slice(0, 120));
  }
  const slu = await api('POST', '/settings/statusline/uninstall');
  check('status line uninstall', slu.body.ok === true);

  // 6. Kill both
  await api('DELETE', `/sessions/${id}`);
  await api('DELETE', `/sessions/${extId}`);
  await sleep(2500);
  const ls2 = mux('ls');
  check('killed sessions gone from winmux', !ls2.includes(`of-${id}`) && !ls2.includes(`of-${extId}`), ls2.trim());

  // 7. Graceful shutdown
  await api('POST', '/shutdown');
  await sleep(1500);
  let down = false;
  try { await fetch(`${BASE}/api/health`); } catch { down = true; }
  check('graceful shutdown', down);
} catch (err) {
  console.log('FAIL exception —', err?.stack || err);
  failures++;
} finally {
  try { server?.kill(); } catch { /* ignore */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* daemon log may be open */ }
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
