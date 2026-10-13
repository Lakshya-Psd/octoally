/**
 * When the OctoAlly server is started from inside a Claude Code session (e.g.
 * from Claude Code's own terminal or a desktop-app session), it inherits that
 * session's private variables — session IDs, messaging sockets/tokens, the
 * host's API proxy URL, "child session" markers. Passed on to the Claude Code
 * sessions OctoAlly launches, they make those sessions behave like children of
 * the host (no transcripts, wrong auth endpoint, "Login expired").
 *
 * Remove them, but keep the user's own configuration (Bedrock/Vertex, token
 * limits, Git Bash path, API key helpers ...).
 */

const HOST_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'MCP_CONNECTION_NONBLOCKING',
  'MCP_SERVER_CONNECTION_BATCH_SIZE',
]);
const HOST_PREFIXES = ['CLAUDE_AGENT_SDK_', 'CLAUDE_PREVIEW_'];
/** CLAUDE_CODE_* variables that are user configuration, not host session state. */
const USER_CLAUDE_CODE_VARS = /^CLAUDE_CODE_(USE_|MAX_|SKIP_|GIT_BASH_PATH|SHELL|API_KEY_HELPER|DISABLE_NONESSENTIAL_TRAFFIC|DISABLE_AUTOUPDATER|IDE_)/;

export function stripHostAgentEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  // Only applies when we were actually launched from within Claude Code.
  if (!env.CLAUDECODE && !env.CLAUDE_CODE_ENTRYPOINT && !env.CLAUDE_CODE_CHILD_SESSION) return env;
  const out = { ...env };
  const hostProxy = !!out.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
  for (const key of Object.keys(out)) {
    if (HOST_EXACT.has(key) || HOST_PREFIXES.some(p => key.startsWith(p))) {
      delete out[key];
    } else if (key.startsWith('CLAUDE_CODE_') && !USER_CLAUDE_CODE_VARS.test(key)) {
      delete out[key];
    }
  }
  // The host's local API proxy only works for the host's own session.
  if (hostProxy) delete out.ANTHROPIC_BASE_URL;
  return out;
}
