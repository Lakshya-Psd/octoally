# Tasks

Updated: 2026-10-13. Ledger for the native Windows port. See `../../PLAN.md` (master folder) for the plan and why, and `WINDOWS.md` for how to use it; this file is only what and when.

## In progress
- [~] Desktop tray menu — installed app runs and started its own server; menu items not clicked by hand.
- [~] Claude event hook as a Node script — built; the route that installs it is unused upstream too, so nothing in the UI reaches it.

## Blocked
- [!] A Claude session doing real work — blocked by the `claude` command-line tool reporting "Login expired / Not logged in" inside OctoAlly (the Claude desktop app itself is signed in; that's a separate login). Unblocks when Lakshya runs `claude` in a terminal and, if asked, `/login`.

## Next
- [ ] Optional: run upstream's Linux build in WSL to confirm nothing regressed for Linux — medium
  **Why:** every change is guarded to Windows, but Linux/macOS weren't re-run. Only matters if this fork will be shared with Linux/macOS users.

## Done
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
