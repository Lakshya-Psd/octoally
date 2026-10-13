#!/usr/bin/env node
// OctoAlly events hook for Claude Code (PostToolUse) — Node port of the bash
// one-liner, used on Windows where mktemp/cat/& are not available.
//
//   node octoally-hook.cjs <project_path> <events_url>
//
// Reads the hook JSON from stdin, hands it to a detached copy of itself that
// POSTs it to OctoAlly, and exits immediately so Claude Code is never slowed down.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function post(raw, projectPath, url) {
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { return; }
  const ti = input.tool_input || {};
  const body = JSON.stringify({
    type: 'tool_use',
    tool_name: input.tool_name || '',
    session_id: input.session_id || '',
    project_path: projectPath,
    data: {
      tool: input.tool_name || '',
      session: input.session_id || '',
      file_path: String(ti.file_path || ti.path || '').replace(/\\/g, '/'),
      command: ti.command || '',
      pattern: ti.pattern || '',
      description: ti.description || '',
    },
  });
  let target;
  try { target = new URL(url); } catch { return; }
  const mod = target.protocol === 'https:' ? require('https') : require('http');
  const req = mod.request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 1500,
  }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

const args = process.argv.slice(2);

if (args[0] === '--post') {
  // Detached worker: args = --post <tmpfile> <project_path> <url>
  const [, tmp, projectPath, url] = args;
  let raw = '';
  try { raw = fs.readFileSync(tmp, 'utf8'); } catch { /* ignore */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  post(raw, projectPath, url);
} else {
  const [projectPath = '', url = 'http://localhost:42010/api/events'] = args;
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  try {
    const tmp = path.join(os.tmpdir(), `octoally-hook-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, raw);
    const child = require('child_process').spawn(process.execPath, [__filename, '--post', tmp, projectPath, url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch { /* never fail the hook */ }
}
