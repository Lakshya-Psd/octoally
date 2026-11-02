// Run: npm test (in dashboard) — node's own test runner, no build step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPathCandidates, pickLinks, type PathCandidate } from '../src/lib/terminal-path-candidates.ts';

const texts = (lines: string[]) => findPathCandidates(lines).map((c) => c.text);

// Claude breaks its own lines at spaces, so "Windows 11" ends one line and starts the next.
const QUEUE = 'C:/Users/Windows 11/Desktop/Artifacts/projects/pink-parotha/videos/short-02-the-queue/edit-v2';

test('a folder path broken at the space in "Windows 11" is read whole', () => {
  const found = texts(['Files: videos (C:/Users/Windows', '11/Desktop/Artifacts/projects/pink-parotha/videos/short-02-the-queue/edit-v2),']);
  assert.ok(found.includes(QUEUE), found.join('\n'));
});

test('a file path broken at the space in "Windows 11" is read whole', () => {
  const found = texts([' post text (C:/Users/Windows', '11/Desktop/Artifacts/projects/pink-parotha/posts/short-02-the-queue.md)']);
  assert.ok(found.includes('C:/Users/Windows 11/Desktop/Artifacts/projects/pink-parotha/posts/short-02-the-queue.md'), found.join('\n'));
});

test('a path broken at a space and again in the middle of a word is read whole', () => {
  const found = texts([
    'Files: video (C:/Users/Windows',
    '11/Desktop/Artifacts/projects/worker-ai/videos/short-06-clean/renders/short-06-clea',
    'n-v4-music.mp4)',
  ]);
  assert.ok(found.includes('C:/Users/Windows 11/Desktop/Artifacts/projects/worker-ai/videos/short-06-clean/renders/short-06-clean-v4-music.mp4'), found.join('\n'));
});

test('continuation lines may be indented', () => {
  const found = texts(['  - C:/Users/Windows', '    11/Desktop/Artifacts']);
  assert.ok(found.includes('C:/Users/Windows 11/Desktop/Artifacts'), found.join('\n'));
});

test('a relative folder path is a candidate, trailing slash and all', () => {
  assert.ok(texts(['  `videos/short-02-the-queue/edit-v2/`']).includes('videos/short-02-the-queue/edit-v2/'));
});

test('a line number after a path is not part of it', () => {
  assert.ok(texts(['see src/App.tsx:12 for that']).includes('src/App.tsx'));
  assert.ok(!texts(['see src/App.tsx:12 for that']).some((t) => t.includes(':12')));
});

test('a sentence-ending period is not part of a path', () => {
  const found = texts(['Saved the video to C:\\Users\\me\\out\\demo.mp4.']);
  assert.ok(found.includes('C:\\Users\\me\\out\\demo.mp4'), found.join('\n'));
  assert.ok(!found.some((t) => t.endsWith('.')), found.join('\n'));
});

test('a single word with no slash or extension is never a candidate', () => {
  assert.deepEqual(texts(['Ready to post (each still needs your yes)']), []);
});

test('candidates map back to where they sit in the lines', () => {
  const lines = ['Files: videos (C:/Users/Windows', '11/Desktop/x/edit-v2),'];
  const c = findPathCandidates(lines).find((x) => x.text === 'C:/Users/Windows 11/Desktop/x/edit-v2');
  assert.ok(c);
  assert.deepEqual(c.start, { line: 0, index: lines[0].indexOf('C:') });
  assert.deepEqual(c.end, { line: 1, index: lines[1].indexOf(')') - 1 });
});

test('the longest path that exists wins, and shorter ones inside it are dropped', () => {
  const at = (line: number, index: number) => ({ line, index });
  const existing: PathCandidate[] = [
    { start: at(0, 15), end: at(0, 22), text: 'C:/Users' },
    { start: at(0, 15), end: at(1, 40), text: QUEUE },
    { start: at(1, 0), end: at(1, 40), text: '11/Desktop/…' }, // starts inside the long one
    { start: at(1, 50), end: at(1, 60), text: 'later.md' },
  ];
  assert.deepEqual(pickLinks(existing).map((c) => c.text), [QUEUE, 'later.md']);
});
