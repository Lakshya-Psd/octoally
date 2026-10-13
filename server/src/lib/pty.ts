/**
 * node-pty loader.
 *
 * Linux/macOS use `node-pty-prebuilt-multiarch` (prebuilt binaries for many Node
 * versions). Windows uses Microsoft's `node-pty`, which ships ConPTY prebuilds
 * for win32-x64/arm64. Both are optional dependencies so a platform that can't
 * install one of them still installs cleanly; we load whichever is present.
 */

import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

export interface IPtyExit {
  exitCode: number;
  signal?: number;
}

export interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: IPtyExit) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  useConpty?: boolean;
  useConptyDll?: boolean;
}

export interface PtyModule {
  spawn(file: string, args: string[] | string, options: PtySpawnOptions): IPty;
}

let cached: PtyModule | null = null;

export function loadPty(): PtyModule {
  if (cached) return cached;
  const candidates = process.platform === 'win32'
    ? ['node-pty', 'node-pty-prebuilt-multiarch']
    : ['node-pty-prebuilt-multiarch', 'node-pty'];
  const errors: string[] = [];
  for (const name of candidates) {
    try {
      cached = nodeRequire(name) as PtyModule;
      return cached;
    } catch (err: any) {
      errors.push(`${name}: ${err?.message ?? err}`);
    }
  }
  throw new Error(`No usable node-pty module found (${errors.join('; ')})`);
}
