/**
 * Enrich process.env.PATH with node binary directories from version managers.
 *
 * Desktop-launched processes (task manager, dock, app menu) inherit the bare
 * session environment which lacks nvm/fnm/volta PATH entries that interactive
 * shells load via .bashrc/.zshrc. This causes spawned processes (PTY sessions,
 * agents, npx calls) to fail because `node`/`npx` are not found.
 *
 * Call once at server startup — all child processes inherit the enriched PATH.
 */

import { readdirSync, existsSync } from 'fs';
import { join, delimiter } from 'path';
import { homedir } from 'os';

/**
 * Windows: tools installed per-user (Claude Code's native installer, npm globals,
 * Volta, nvm-windows, fnm, Scoop, Git) whose folders may be missing from the
 * PATH of a server started at login or from the desktop app.
 */
function discoverWindowsDirs(): string[] {
  const home = homedir();
  const env = process.env;
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    join(home, '.local', 'bin'),                 // Claude Code native installer
    join(appData, 'npm'),                        // npm global bin
    join(programFiles, 'nodejs'),
    env.NVM_SYMLINK || '',                       // nvm-windows active version
    join(localAppData, 'Volta', 'bin'),
    join(programFiles, 'Volta'),
    join(appData, 'fnm', 'aliases', 'default'),
    join(home, 'scoop', 'shims'),
    join(localAppData, 'pnpm'),
    join(programFiles, 'Git', 'cmd'),
    join(localAppData, 'Programs', 'Microsoft VS Code', 'bin'),
    join(programFiles, 'Microsoft VS Code', 'bin'),
    join(localAppData, 'Microsoft', 'WindowsApps'), // wt.exe, winget
  ];
  return candidates.filter((d) => d && existsSync(d));
}

function discoverNodeDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  // nvm: pick the highest installed version
  const nvmDir = process.env.NVM_DIR || join(home, '.nvm');
  const nvmVersionsDir = join(nvmDir, 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir)
        .filter((d) => d.startsWith('v'))
        .sort((a, b) => {
          const pa = a.slice(1).split('.').map(Number);
          const pb = b.slice(1).split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
          }
          return 0;
        });
      if (versions.length > 0) {
        dirs.push(join(nvmVersionsDir, versions[versions.length - 1], 'bin'));
      }
    } catch {}
  }

  // fnm (Fast Node Manager)
  const fnmDir = join(home, '.local', 'share', 'fnm', 'node-versions');
  if (existsSync(fnmDir)) {
    try {
      const versions = readdirSync(fnmDir)
        .filter((d) => d.startsWith('v'))
        .sort((a, b) => {
          const pa = a.slice(1).split('.').map(Number);
          const pb = b.slice(1).split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
          }
          return 0;
        });
      if (versions.length > 0) {
        dirs.push(join(fnmDir, versions[versions.length - 1], 'installation', 'bin'));
      }
    } catch {}
  }

  // volta
  const voltaBin = join(home, '.volta', 'bin');
  if (existsSync(voltaBin)) {
    dirs.push(voltaBin);
  }

  // Common system paths that may be missing from desktop sessions
  for (const p of ['/usr/local/bin', join(home, '.local', 'bin')]) {
    if (existsSync(p)) dirs.push(p);
  }

  return dirs;
}

export function enrichProcessPath(): void {
  if (process.platform === 'win32') {
    // Windows env keys are case-insensitive but Node exposes the original
    // spelling (usually "Path"); write back through the same key.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
    const currentPath = process.env[key] || '';
    const pathSet = new Set(currentPath.split(delimiter).map((p) => p.replace(/[\\/]+$/, '').toLowerCase()));
    // Append (not prepend): the user's own PATH order wins on Windows.
    const toAdd = discoverWindowsDirs().filter((d) => !pathSet.has(d.replace(/[\\/]+$/, '').toLowerCase()));
    if (toAdd.length > 0) {
      process.env[key] = [currentPath, ...toAdd].filter(Boolean).join(delimiter);
    }
    return;
  }

  const currentPath = process.env.PATH || '';
  const pathSet = new Set(currentPath.split(':'));
  const toAdd = discoverNodeDirs().filter((d) => !pathSet.has(d));

  if (toAdd.length > 0) {
    process.env.PATH = [...toAdd, currentPath].join(':');
  }
}
