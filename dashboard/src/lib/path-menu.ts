/**
 * The right-click menu on a file or folder path in a terminal: which entries it
 * has and what they're called. Terminal.tsx draws it and runs the actions.
 *
 * No imports, so node's test runner can load this file directly.
 */

export type PathMenuAction = 'open-here' | 'reveal' | 'open-default' | 'copy';
export type PathMenuEntry = { action: PathMenuAction; label: string } | 'separator';

function fileManager(platform: string): string {
  if (platform === 'win32') return 'Windows File Explorer';
  if (platform === 'darwin') return 'Finder';
  return 'file manager';
}

/**
 * canOpenHere: the terminal has an OctoAlly File Explorer to open the path in
 * (a left click does the same).
 */
export function pathMenuEntries(opts: { type: 'file' | 'directory'; canOpenHere: boolean; platform: string }): PathMenuEntry[] {
  const fm = fileManager(opts.platform);
  const entries: PathMenuEntry[] = [];
  if (opts.canOpenHere) entries.push({ action: 'open-here', label: 'Open in OctoAlly' }, 'separator');
  if (opts.type === 'file') {
    entries.push({ action: 'reveal', label: `Show in ${fm}` }, { action: 'open-default', label: 'Open in default app' });
  } else {
    entries.push({ action: 'reveal', label: `Open in ${fm}` });
  }
  entries.push('separator', { action: 'copy', label: 'Copy path' });
  return entries;
}

/** The path as people paste it on this system (backslashes on Windows). */
export function pathForClipboard(path: string, platform: string): string {
  return platform === 'win32' ? path.replace(/\//g, '\\') : path;
}
