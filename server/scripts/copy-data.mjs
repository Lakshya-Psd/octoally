// Copy non-TypeScript data files into dist/ after `tsc`.
// Cross-platform replacement for `cp -r src/data/agents dist/data/ && cp src/data/*.sh dist/data/`.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcData = join(root, 'src', 'data');
const distData = join(root, 'dist', 'data');

mkdirSync(distData, { recursive: true });
cpSync(join(srcData, 'agents'), join(distData, 'agents'), { recursive: true });

// Status line / hook helper scripts (bash for Linux/macOS, Node for Windows)
for (const name of readdirSync(srcData)) {
  if (/\.(sh|cjs|mjs)$/.test(name)) {
    cpSync(join(srcData, name), join(distData, name));
  }
}
