/**
 * Server platform info (GET /api/platform), fetched once and cached.
 *
 * Older servers don't have the endpoint — in that case we guess from the
 * browser: Windows if the user agent says so, otherwise POSIX (the dashboard
 * and server almost always run on the same machine).
 */
import { useEffect, useState } from 'react';
import { api, type PlatformInfo } from './api';
import { DRIVES_ROOT, normalizePath } from './paths';

/** True when the browser itself runs on Windows (keyboard conventions etc.). */
export const isWindowsClient: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  // User-Agent Client Hints (Chromium only) — not in TS's DOM lib yet.
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  if (uaPlatform) return /windows/i.test(uaPlatform);
  return /^win/i.test(navigator.platform || '') || /windows/i.test(navigator.userAgent || '');
})();

const isMacClient: boolean =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

const FALLBACK: PlatformInfo = {
  platform: isWindowsClient ? 'win32' : isMacClient ? 'darwin' : 'linux',
  home: '',
  drivesRoot: isWindowsClient ? DRIVES_ROOT : null,
  shell: '',
  updateCommand: '',
};

let cached: PlatformInfo | null = null;
let pending: Promise<PlatformInfo> | null = null;
let failedAt = 0;
const RETRY_AFTER_MS = 30_000;

/** Fetch (once) the server platform; never rejects. */
export function getPlatform(): Promise<PlatformInfo> {
  if (cached) return Promise.resolve(cached);
  if (!pending && failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(FALLBACK);
  if (!pending) {
    pending = api
      .platform()
      .then((info) => {
        cached = {
          ...FALLBACK,
          ...info,
          home: info.home ? normalizePath(info.home) : '',
          drivesRoot: info.drivesRoot ?? null,
        };
        return cached;
      })
      .catch(() => {
        // Endpoint missing (older server) or network error — use the guess,
        // and let a later call retry (throttled so mounts don't spam 404s).
        pending = null;
        failedAt = Date.now();
        return FALLBACK;
      });
  }
  return pending;
}

/** Best current answer without waiting (fallback guess until the fetch resolves). */
export function getPlatformSync(): PlatformInfo {
  return cached ?? FALLBACK;
}

/** React hook: server platform info, re-rendering once the fetch resolves. */
export function usePlatform(): PlatformInfo {
  const [info, setInfo] = useState<PlatformInfo>(getPlatformSync);
  useEffect(() => {
    let alive = true;
    getPlatform().then((p) => { if (alive) setInfo(p); });
    return () => { alive = false; };
  }, []);
  return info;
}

/** React hook: true when the server runs on Windows. */
export function useIsWindows(): boolean {
  return usePlatform().platform === 'win32';
}

/** Example project path for placeholders, matching the server OS. */
export function examplePath(info: PlatformInfo, sub = 'projects/myapp'): string {
  return info.platform === 'win32' ? `C:/Users/you/${sub}` : `/home/user/${sub}`;
}
