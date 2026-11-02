import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathMenuEntries, pathForClipboard } from '../src/lib/path-menu.ts';

const labels = (...args: Parameters<typeof pathMenuEntries>) =>
  pathMenuEntries(...args).map((e) => (e === 'separator' ? '—' : e.label));

test('a file on Windows: open here, show in File Explorer, default app, copy path', () => {
  assert.deepEqual(labels({ type: 'file', canOpenHere: true, platform: 'win32' }), [
    'Open in OctoAlly', '—', 'Show in Windows File Explorer', 'Open in default app', '—', 'Copy path',
  ]);
});

test('a folder on Windows: open here, open in File Explorer, copy path', () => {
  assert.deepEqual(labels({ type: 'directory', canOpenHere: true, platform: 'win32' }), [
    'Open in OctoAlly', '—', 'Open in Windows File Explorer', '—', 'Copy path',
  ]);
});

test('with nowhere to open it inside OctoAlly, that entry is left out', () => {
  assert.deepEqual(labels({ type: 'file', canOpenHere: false, platform: 'win32' }), [
    'Show in Windows File Explorer', 'Open in default app', '—', 'Copy path',
  ]);
});

test('the file manager is named for the system', () => {
  assert.ok(labels({ type: 'directory', canOpenHere: false, platform: 'darwin' }).includes('Open in Finder'));
  assert.ok(labels({ type: 'directory', canOpenHere: false, platform: 'linux' }).includes('Open in file manager'));
});

test('each entry says what it does', () => {
  const actions = pathMenuEntries({ type: 'file', canOpenHere: true, platform: 'win32' })
    .flatMap((e) => (e === 'separator' ? [] : [e.action]));
  assert.deepEqual(actions, ['open-here', 'reveal', 'open-default', 'copy']);
});

test('a copied path uses backslashes on Windows only', () => {
  assert.equal(pathForClipboard('C:/Users/Windows 11/Desktop/a.mp4', 'win32'), 'C:\\Users\\Windows 11\\Desktop\\a.mp4');
  assert.equal(pathForClipboard('/home/me/a.mp4', 'linux'), '/home/me/a.mp4');
});
