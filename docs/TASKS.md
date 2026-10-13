# Tasks

Updated: 2026-10-13. Ledger for the native Windows port. See `../../PLAN.md` (master folder) for the full plan and why; this file is only what and when.

## In progress
- [~] Windows CLI (`octoally start/stop/restart/status/update/logs/install-service`) + `install.ps1` — being written by a helper; needs its own test run.
- [~] Desktop app on Windows (server control, single instance, tray icon, installer build) — being written by a helper; needs a real launch.
- [~] Voice dictation on Windows (ffmpeg mic capture, prebuilt whisper.cpp) — being written by a helper; needs a mic test.
- [~] Dashboard Windows fixes (paths, drive picker, Ctrl+C/V/right-click, wording) — 6ba67a7, builds with 0 errors; not yet clicked through in a browser.
- [~] Server OS integrations: open URL / folder / terminal — b4962f1, built; buttons not yet clicked. (PATH discovery, temp paths, process kill and Claude history naming are covered by the e2e run below.)
- [~] Claude event hook as a Node script — built; the hook route is unused upstream too, so it is not reachable from the UI.

## Blocked
_(nothing)_

## Next
- [ ] Real Claude Code + Codex sessions and agent sessions from the dashboard — medium
  **Why:** the e2e test used PowerShell sessions. Claude's own screen drawing, paste and `/resume` must be seen working inside OctoAlly on Windows.
- [ ] End-to-end click-through in the browser and the desktop app — large
  **Why:** built is not proven. Every button has to be tried on real Windows before it counts as done.
- [ ] Windows docs (`WINDOWS.md` + README section) — small
  **Why:** you and anyone you share it with need to know how to install, run and troubleshoot it on Windows.

## Done
- [x] Status line as a Node script — sample Claude data renders folder, branch, 1h2m, +120/-30, 50% bar, $2.35, "Opus 5.5 200k".
- [x] Windows paths end-to-end on the server — e2e: `C:\...\` typed with backslashes stored as `C:/...`; "This PC" lists C: and G:; `C:/` goes up to the drive list.
- [x] Pop-out to Windows Terminal and re-adopt — e2e: pop-out opened Windows Terminal attached to the session; re-adopt detached it and typing worked in the dashboard again.
- [x] winmux wired into the server — e2e (`server/scripts/e2e-windows.mjs`, 24/24 pass): terminal streams in the project folder; server killed, session survives, comes back with its screen; external `octoally mux new` session adopted; kill and graceful shutdown work.
- [x] Windows command launcher — winmux test: prompts containing quotes, `%`, `&`, newlines, Unicode and trailing backslashes reached the program exactly; npm `.cmd` tools run as `node <script>`; `claude` resolves to `~/.local/bin/claude.exe`.
- [x] winmux: Windows replacement for tmux — b4962f1; live test: create, stream, snapshot, detach, resize, detach-others and kill all pass.
- [x] Cross-platform build scripts + Windows dependency install — server installs and builds on Windows (node-pty 1.1.0 ConPTY, better-sqlite3 12).
- [x] Mapped every Linux/macOS dependency across server, dashboard, desktop app and CLI. Evidence: audit notes folded into `PLAN.md`.
- [x] Proved the native pieces load on this PC's Node 24: node-pty 1.1.0 ran `cmd.exe` through ConPTY, better-sqlite3 12 opened a database.
- [x] Cloned upstream v1.0.89 into `octoally/` on branch `windows-port`. Evidence: commit 55f6d61.

## Dropped
_(nothing)_

## Decisions waiting on the owner
| | |
|---|---|
| Publishing | This is a personal Windows build. The license (Commons Clause) forbids selling it. Whether to share it, fork it publicly or offer it upstream is your call. |
| First real run touches your Claude setup | Like on Linux, OctoAlly copies its 36 built-in agents into `~/.claude/agents/` on first start (only files that don't exist yet). The status-bar installer, if you click it, edits `~/.claude/settings.json`. |
