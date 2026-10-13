import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  // ffmpeg-static locates its binary via __dirname, so it must stay a real module
  external: ['electron', 'ffmpeg-static'],
  sourcemap: true,
  logLevel: 'info',
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.js',
  }),
  build({
    ...common,
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.js',
  }),
]);
