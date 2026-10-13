#!/usr/bin/env node
// OctoAlly Status Line for Claude Code — Node port of statusline.sh for Windows
// (no bash, jq or bc needed). Same output: folder, git branch, duration, lines
// changed, context bar, cost and model.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';
const SEP = `${GRAY}${RESET}`;

function readStdin() {
  try { return require('fs').readFileSync(0, 'utf8'); } catch { return ''; }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true,
    }).trim();
  } catch { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const cwd = (input.workspace && input.workspace.current_dir) || process.cwd();
const model = (input.model && input.model.display_name) || '';
const modelId = (input.model && input.model.id) || '';
const ctx = input.context_window || {};
const totalTokens = num(ctx.total_input_tokens) + num(ctx.total_output_tokens);
const contextLimit = num(ctx.context_window_size);
const costObj = input.cost || {};
const cost = costObj.total_cost_usd;
const durationMs = num(costObj.total_duration_ms);
const linesAdded = num(costObj.total_lines_added);
const linesRemoved = num(costObj.total_lines_removed);

const shortDir = path.basename(cwd.replace(/[\\/]+$/, '')) || cwd;

// Git branch (or exact tag)
let gitInfo = '';
const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']) || git(cwd, ['describe', '--tags', '--exact-match']);
if (branch) gitInfo = ` ${SEP} ${MAGENTA} ${branch}${RESET}`;

// Session duration
let durationInfo = '';
if (durationMs > 0) {
  const sec = Math.floor(durationMs / 1000);
  let fmt;
  if (sec >= 3600) fmt = `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  else if (sec >= 60) fmt = `${Math.floor(sec / 60)}m`;
  else fmt = `${sec}s`;
  durationInfo = ` ${SEP} ${CYAN}⏱ ${fmt}${RESET}`;
}

// Lines changed
let linesInfo = '';
if (linesAdded > 0 || linesRemoved > 0) {
  const net = linesAdded - linesRemoved;
  const symbol = net > 0 ? `${GREEN}▲${RESET}` : net < 0 ? `${RED}▼${RESET}` : `${GRAY}=${RESET}`;
  linesInfo = ` ${SEP} ${symbol} ${GREEN}+${linesAdded}${RESET} ${RED}-${linesRemoved}${RESET}`;
}

// Token usage with progress bar
let tokenInfo = '';
if (totalTokens > 0 && contextLimit > 0) {
  const pct = Math.floor((totalTokens * 100) / contextLimit);
  const barColor = pct >= 75 ? RED : pct >= 50 ? YELLOW : GREEN;
  const width = 8;
  let filled = Math.floor((pct * width) / 100);
  if (filled > width) filled = width;
  if (filled < 1 && pct > 0) filled = 1;
  const bar = `${barColor}${'▓'.repeat(filled)}${GRAY}${'░'.repeat(width - filled)}${RESET}`;
  tokenInfo = ` ${SEP} ${bar} ${GRAY}${pct}%${RESET}`;
}

// Cost
let costInfo = '';
if (cost !== undefined && cost !== null && cost !== '') {
  const c = Number(cost);
  if (isFinite(c)) {
    const cents = Math.round(c * 100);
    const color = cents >= 1000 ? RED : cents >= 200 ? YELLOW : GREEN;
    costInfo = ` ${SEP} ${color}$${c.toFixed(2)}${RESET}`;
  }
}

// Model with version, tier colour and context size
let modelInfo = '';
if (modelId || model) {
  const key = modelId || model;
  let color = GRAY;
  let symbol = '●';
  let tier = '';
  if (/opus/i.test(key)) { color = MAGENTA; symbol = '◆'; tier = 'Opus'; }
  else if (/sonnet/i.test(key)) { color = BLUE; symbol = '◇'; tier = 'Sonnet'; }
  else if (/haiku/i.test(key)) { color = GREEN; symbol = '○'; tier = 'Haiku'; }
  if (!tier) tier = model;

  // Version from model.id: claude-opus-4-6 → 4.6, claude-sonnet-4-20250514 → 4
  let version = '';
  const m = modelId.match(/-(\d+)-(\d+)(?=-|\[|$)/);
  if (m) version = m[2].length >= 6 ? m[1] : `${m[1]}.${m[2]}`;
  else {
    const major = modelId.match(/-(\d+)(?=-|\[|$)/);
    if (major) version = major[1];
  }

  let ctxTag = '';
  if (contextLimit >= 1000000) ctxTag = ` ${GRAY}1M${RESET}`;
  else if (contextLimit >= 200000) ctxTag = ` ${GRAY}200k${RESET}`;

  const label = version ? `${tier} ${version}` : tier;
  modelInfo = ` ${SEP} ${color}${symbol} ${label}${ctxTag}${RESET}`;
}

process.stdout.write(`${BLUE}${shortDir}${RESET}${gitInfo}${durationInfo}${linesInfo}${tokenInfo}${costInfo}${modelInfo}`);
