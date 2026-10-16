# Tasks

Updated: 2026-10-16. Ledger for the native Windows port. See `../../PLAN.md` (master folder) for the plan and why, and `WINDOWS.md` for how to use it; this file is only what and when.

## In progress
- [~] Reconnect on a popped-out session brings back the original chat instead of starting a new one — built (ef2b1a8); not yet seen working on a real popped-out session.
- [~] Pasted image reaches Claude as an attached image — the path is typed into the session (seen in a browser); not yet tried in a live Claude chat.
- [~] Desktop tray menu — installed app runs and started its own server; menu items not clicked by hand.
- [~] Claude event hook as a Node script — built; the route that installs it is unused upstream too, so nothing in the UI reaches it.

## Blocked

## Next
- [ ] Optional: OctoAlly dashboard on the phone over Tailscale — large
  **Why:** Lakshya wanted to follow sessions from the phone. Claude Code's Remote Control already covers chatting from the Claude app (turned on for all new chats 2026-10-14), so try that first; the full dashboard on a phone needs a login added, because OctoAlly has none today. Only if Remote Control isn't enough.
- [ ] Optional: run upstream's Linux build in WSL to confirm nothing regressed for Linux — medium
  **Why:** every change is guarded to Windows, but Linux/macOS weren't re-run. Only matters if this fork will be shared with Linux/macOS users.

## Done
- [x] Claude sessions doing real work inside OctoAlly — the CLI is signed in to Lakshya's Max plan (`claude auth status`, 2026-10-16) and live chats (GMC, pink-parotha, octoally) have been running real work in the dashboard. The old long-lived `CLAUDE_CODE_OAUTH_TOKEN` was removed so new sessions use this sign-in.
- [x] Drop or paste files of any type into a session (Lakshya's request) — tested in the desktop app code with a real drop and real File Explorer copies: real paths arrived, a name with a space was quoted, drop outside a session opened nothing, browser upload fallback worked; new installer built and installed, sessions survived (98fdff4).
- [x] Alt+Shift+Arrows moves the green focus in Active Sessions (Lakshya's request) — headless browser, 5 fake sessions in 2 columns: every move landed right and no keypress leaked into a session (ffc3db7).
- [x] Drag project tabs to reorder them (Lakshya's request) — test browser: dragged "Artifacts" before "GMC", order swapped and was saved (7fb8f09).
- [x] Drag sessions to reorder the Active Sessions grid (Lakshya's request) — throwaway copy with alpha/bravo/charlie: dragging alpha onto charlie's right half gave bravo, charlie, alpha, same after reload (802e3b5).
- [x] Terminal buttons moved into the title bar, grouped by what they do — checked in screenshots of the grid and of project/session views (0941a04).
- [x] Sessions drew without colour — server now drops the `NO_COLOR` setting it inherits when started from Claude Code; new e2e check; a fresh terminal showed colour again (ef2b1a8).
- [x] Terminal buttons no longer cover Claude's panel close button — checked in a real browser (ef2b1a8; later moved into the title bar, 0941a04).
- [x] Paste images into sessions (Lakshya's request) — e2e passes with two new checks (image saved, non-image refused); pasted into a test terminal in a real browser and the path appeared (f94a1ee).
- [x] Visual previews in the file viewer, like the Claude desktop app (Lakshya's request) — seen working in the dashboard: video player, image with zoom, audio player, PDF viewer, live HTML page with its CSS/JS/image, SVG, CSV table, Markdown with image; preview updated on its own when the file changed; clicking a path printed in a terminal opened the video; Open-in-default-app opened Photos, Show-in-file-manager opened Explorer; previewed page could not reach the API; e2e 30/30 without pop-out (5a0226d).
- [x] Desktop app installed and set to start at login — installed per-user to `%LOCALAPPDATA%\Programs\OctoAlly` (Start menu shortcut); Run key `com.aigenius.octoally` = `"…\OctoAlly.exe" --hidden`; launched from Explorer it started the server (PID 58704) and opened its window. Lakshya's call.
- [x] `octoally update` on a branch with no remote — `update --force` reinstalled and rebuilt everything and restarted the server (6deff33).
- [x] Windows docs — `WINDOWS.md` + README platform row (1d7cf0b).
- [x] Dashboard click-through on Windows — added a project by typing `C:\...\octoally\` (stored as `C:/...`, name auto-filled, git branch detected); "This PC" drive list; terminal ran your PowerShell profile and `git log`; file explorer opened files; git panel showed a side-by-side diff; Active Sessions grid streamed 3 sessions.
- [x] Real Claude Code sessions from the dashboard — Claude v2.1.288 started in the project; prompt with `"`, `&`, `%` and `'` arrived exactly; agent session ran `claude.exe --agent code-reviewer-pro "..."`.
- [x] Agent picker shows your agents — fixed CRLF/BOM parsing; 38 agents listed (cb3798c).
- [x] Sessions start with a clean environment — a host Claude Code session's private variables no longer leak in; "Transcript saving is off" warning gone (cb3798c).
- [x] Restart Server button relaunches on Windows — new server PID, both sessions survived and reattached.
- [x] Pop-out and adopt-back from the UI — Claude session moved into Windows Terminal (attach client confirmed), then back via "External sessions".
- [x] Server OS integrations — Open folder → File Explorer at the project; Open terminal → Windows Terminal; Open URL → default browser.
- [x] Status line — installed into a sandbox `~/.claude`, and the installed command rendered from cmd, PowerShell and Git Bash (e2e).
- [x] No console windows flash — every child process of the server, workers and daemon is hidden by default (4321d51).
- [x] Windows CLI + installer — start/stop/restart/status/logs/channel/install-service tested from cmd, PowerShell and Git Bash; install.ps1 ran end-to-end; auto-start installed and removed cleanly (4321d51).
- [x] Desktop app builds and runs on Windows — `OctoAlly Setup 1.0.89.exe` built; second launch exits (single instance); window loaded the dashboard (143f4b8).
- [x] Windows paths end-to-end on the server — e2e: backslash paths normalised; "This PC" lists C: and G:.
- [x] winmux wired into the server — e2e 30/30: terminal in the project folder; server killed, session survives with its screen; pop-out/re-adopt; external session adoption; kill; graceful shutdown.
- [x] Windows command launcher — quotes, `%`, `&`, newlines, Unicode, trailing backslashes reach the program exactly; npm tools run as `node <script>`.
- [x] winmux: Windows replacement for tmux (b4962f1).
- [x] Cross-platform build scripts + Windows dependency install.
- [x] Mapped every Linux/macOS dependency (see `PLAN.md`).
- [x] Native pieces load on Node 24 (node-pty 1.1.0 ConPTY, better-sqlite3 12).
- [x] Cloned upstream v1.0.89 into `octoally/` on branch `windows-port` (55f6d61).

## Dropped
- [-] Codex sessions — Lakshya doesn't use Codex (OpenAI's tool), so it won't be installed or tested. The launch path exists and shares tested code with Claude's.
- [-] Voice dictation testing in the desktop app — Lakshya already uses Handy for dictation. The feature is built and its parts were proven (5 mics listed, 32 KB/s capture, whisper.cpp transcribed a test WAV), but it won't be tested by speaking.

## Decisions waiting on the owner
| | |
|---|---|
| Sign in to Claude Code | Run `claude` once in a terminal and `/login`; sessions in OctoAlly use that sign-in. |
| Status bar in Claude Code | Optional. A line under Claude Code's input box showing folder, git branch, session time, cost and how full the context is. You have none set, so nothing would be replaced. Settings → Install Status Bar if you want it. |
| Publishing | Personal build; the Commons Clause license forbids selling it. Sharing, a public fork or offering it upstream is your call. Note the desktop installer bundles ffmpeg (GPL). |
