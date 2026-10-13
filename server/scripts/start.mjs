// Cross-platform `npm start`: run the compiled server in production mode.
// (Replaces `env NODE_ENV=production node dist/index.js`, which needs a POSIX shell.)
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'production';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
