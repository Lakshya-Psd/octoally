# Tasks

Updated: 2026-10-13. Ledger for the native Windows port. See `../../PLAN.md` (master folder) for the full plan and why; this file is only what and when.

## In progress
_(nothing yet)_

## Blocked
_(nothing)_

## Next
- [ ] Cross-platform build scripts + Windows dependency install — small
  **Why:** the server's build step uses Linux `cp -r`, so it can't even be built on Windows. Nothing else can be tested until it builds. (Lakshya's goal: full Windows support.)
- [ ] winmux: Windows replacement for tmux (session daemon, client, `octoally-mux` CLI) — large
  **Why:** tmux is what keeps sessions alive when the server restarts, lets you pop a session out to your own terminal and bring it back, and gives a clean screen snapshot. Windows has no tmux, so without this every session dies on restart and pop-out doesn't exist.
- [ ] Windows command launcher (find `claude`/`codex`, handle npm `.cmd` wrappers, safe quoting) — medium
  **Why:** on Linux the task text is handed to bash. On Windows that would break on quotes, `%`, `&` and multi-line prompts, so sessions would start with a mangled prompt or not at all.
- [ ] Wire winmux into the server (spawn, reconnect, capture, kill, release, adopt, discover) — large
  **Why:** the server talks to tmux in ~90 places. Each needs a Windows path so sessions, agents and terminals behave the same as on Linux.
- [ ] Pop-out to Windows Terminal and re-adopt — medium
  **Why:** a headline feature ("pop out to your system terminal, then bring it back"). On Linux it opens tilix/gnome-terminal; Windows needs Windows Terminal or a console window.
- [ ] Server OS integrations: open URL / folder / terminal, PATH discovery, temp paths, process-tree kill, Claude history folder naming — medium
  **Why:** buttons like "Open in file manager" and "Open in terminal" call Linux tools, and the server can't find Claude's history files on Windows because it names the folder the Linux way.
- [ ] Windows paths end-to-end (server returns `C:/...`, folder picker can switch drives) — medium
  **Why:** the UI splits paths on `/` and checks "starts with /" for absolute paths, so Windows paths show up as whole strings, trigger false warnings, and you can't reach other drives.
- [ ] Status line + Claude event hook as Node scripts — small
  **Why:** both are bash scripts that need `jq`/`mktemp`, which a normal Windows PC doesn't have, so the status bar and live tool-event feed would silently do nothing.
- [ ] Dashboard Windows fixes (path helpers, drive switching, Ctrl+C/Ctrl+V/right-click in terminals, wording, update text) — medium
  **Why:** the UI assumes Linux habits: copy is Ctrl+Shift+C, the text mentions tmux and bash, and it warns that `C:\...` isn't an absolute path.
- [ ] Windows CLI (`octoally start/stop/restart/status/update/logs/install-service`) + `install.ps1` — medium
  **Why:** the `octoally` command and installer are bash and systemd/launchd only. Windows needs its own way to start, stop and auto-start the server.
- [ ] Desktop app on Windows (server control, single instance, tray icon, installer build) — medium
  **Why:** the tray app finds and controls the server with Linux commands (`realpath`, `fuser`, `pkexec`), so on Windows it can't start or stop anything.
- [ ] Voice dictation on Windows (ffmpeg mic capture, prebuilt whisper.cpp) — medium
  **Why:** mic capture uses Linux/mac audio tools and whisper is compiled from source with cmake. Today it throws "Unsupported platform" on Windows.
- [ ] End-to-end verification on this PC (browser + desktop app) — large
  **Why:** built is not proven. Every feature has to be clicked through on real Windows before it counts as done.
- [ ] Windows docs (`WINDOWS.md` + README section) — small
  **Why:** you and anyone you share it with need to know how to install, run and troubleshoot it on Windows.

## Done
- [x] Mapped every Linux/macOS dependency across server, dashboard, desktop app and CLI. Evidence: audit notes folded into `PLAN.md`.
- [x] Proved the native pieces load on this PC's Node 24: node-pty 1.1.0 ran `cmd.exe` through ConPTY (output "hi from conpty"), and better-sqlite3 12 opened a database (SQLite 3.53.2).
- [x] Cloned upstream v1.0.89 into `octoally/` on branch `windows-port`. Evidence: commit 55f6d61.

## Dropped
_(nothing)_

## Decisions waiting on the owner
| | |
|---|---|
| Publishing | This is a personal Windows build. The license (Commons Clause) forbids selling it. Whether to share it, fork it publicly or offer it upstream is your call. |
