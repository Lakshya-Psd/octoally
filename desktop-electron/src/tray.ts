import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  MenuItemConstructorOptions,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  isServerRunning,
  isServerReachable,
  startServer,
  stopServer,
  stopServerOnPort,
  isServiceInstalled,
  toggleService,
  waitForServer,
} from './server-manager';
import { writeDesktopSetting } from './desktop-settings';

let tray: Tray | null = null;

/** Args passed when Windows launches the app at login (start in the tray). */
export const LOGIN_ITEM_ARGS = ['--hidden'];

/**
 * Resolve a file in icons/ — packaged app first (extraResources copies it to
 * resources/icons), then the development location next to dist/.
 */
export function resolveIconPath(name: string): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'icons', name),
    path.join(__dirname, '..', 'icons', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1];
}

interface TrayOptions {
  cliPath: string;
  showWindow: () => void;
}

export function createTray(opts: TrayOptions): Tray {
  // Destroy existing tray to prevent duplicates on relaunch
  if (tray) {
    tray.destroy();
    tray = null;
  }

  // Resolve icon path — try development location first, then packaged.
  // Windows: the multi-size .ico lets the shell pick 16/20/24/32px per DPI.
  const iconNames = process.platform === 'win32'
    ? ['icon.ico', 'tray-icon.png']
    : ['tray-icon.png'];
  const iconPaths: string[] = [];
  for (const name of iconNames) {
    iconPaths.push(
      path.join(__dirname, '..', 'icons', name),
      path.join(process.resourcesPath || '', 'icons', name),
    );
  }

  let icon = nativeImage.createEmpty();
  for (const p of iconPaths) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        icon = p.endsWith('.ico') ? img : img.resize({ width: 32, height: 32 });
        break;
      }
    } catch {}
  }

  tray = new Tray(icon);
  tray.setToolTip('OctoAlly');

  // Build initial menu (async — will set when ready)
  refreshMenu(opts);

  tray.on('click', () => {
    opts.showWindow();
  });

  // Refresh menu on right-click so status is always current when displayed
  tray.on('right-click', () => {
    refreshMenu(opts);
  });

  return tray;
}

async function refreshMenu(opts: TrayOptions) {
  if (!tray) return;

  let reachable = false;
  let cliManaged = false;
  let serviceInstalled = false;
  try {
    reachable = await isServerReachable();
    cliManaged = await isServerRunning(opts.cliPath);
    serviceInstalled = isServiceInstalled();
  } catch (err) {
    console.warn('[OctoAlly] Tray menu status check failed:', err);
  }

  let statusLabel = 'Status: Stopped';
  if (reachable && cliManaged) {
    statusLabel = 'Status: Running';
  } else if (reachable && !cliManaged) {
    statusLabel = 'Status: Running (external)';
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Open Dashboard',
      click: () => opts.showWindow(),
    },
    {
      label: statusLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Start Server',
      enabled: !reachable,
      click: async () => {
        await startServer(opts.cliPath);
        await waitForServer(10000);
        refreshMenu(opts);
      },
    },
    {
      label: 'Stop Server',
      enabled: reachable,
      click: async () => {
        if (cliManaged) {
          await stopServer(opts.cliPath);
        } else {
          await stopServerOnPort();
        }
        refreshMenu(opts);
      },
    },
    { type: 'separator' },
    {
      label: serviceInstalled
        ? 'Uninstall Service (auto-start)'
        : 'Install Service (auto-start)',
      click: async () => {
        await toggleService(opts.cliPath);
        refreshMenu(opts);
      },
    },
    ...loginItemMenu(opts),
    { type: 'separator' },
    {
      label: 'Close Behavior...',
      sublabel: 'Choose what happens when you close the window',
      click: () => {
        writeDesktopSetting('closeBehavior', 'ask');
        // Show the window and immediately open the close dialog
        opts.showWindow();
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('show-close-dialog');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        if (!isServiceInstalled()) {
          if (cliManaged) {
            console.log('[OctoAlly] Stopping CLI-managed server on quit...');
            await stopServer(opts.cliPath);
          } else if (reachable) {
            console.log('[OctoAlly] Stopping external server on quit...');
            await stopServerOnPort();
          }
        }
        app.exit(0);
      },
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

/** Windows: let the desktop app itself start (in the tray) at login. */
function loginItemMenu(opts: TrayOptions): MenuItemConstructorOptions[] {
  if (process.platform !== 'win32') return [];
  let openAtLogin = false;
  try {
    openAtLogin = app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin;
  } catch {}
  return [
    {
      label: 'Open OctoAlly at Login',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => {
        try {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ITEM_ARGS });
        } catch (err) {
          console.warn('[OctoAlly] Failed to update login item:', err);
        }
        refreshMenu(opts);
      },
    },
  ];
}

export async function updateTrayMenu(opts: TrayOptions) {
  await refreshMenu(opts);
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
