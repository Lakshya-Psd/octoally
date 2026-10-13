# OctoAlly on Windows

This fork runs OctoAlly natively on Windows 10 (1809+) and Windows 11. No WSL is needed. Every feature from the Linux/macOS version is available: Claude Code and Codex sessions, agent sessions, terminals, sessions that survive server restarts, pop-out and adopt-back, the active-sessions grid, git, the file explorer, the web view, the status bar, the desktop app and voice dictation.

## Requirements

| Need | Why | Get it |
|---|---|---|
| Node.js 20+ | Runs the server | https://nodejs.org |
| Claude Code | The agent OctoAlly drives | `irm https://claude.ai/install.ps1 \| iex` |
| Git for Windows | Git panel; Claude Code uses Git Bash | https://git-scm.com |
| Codex CLI (optional) | Codex sessions | `npm install -g @openai/codex` |
| Windows Terminal (optional) | Nicer pop-out windows | Built into Windows 11 |

Before the first session, run Claude Code once in a normal terminal to sign in and accept its terms:

```powershell
claude
```

Also run `claude --dangerously-skip-permissions` once if you want to use the "skip permissions" option.

## Install

Double-click **`install.cmd`**, or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

| Option | Effect |
|---|---|
| `-Service` | Start OctoAlly automatically when you log in (no admin needed) |
| `-Desktop` | Also build the desktop app installer (`desktop-electron\release\OctoAlly Setup <version>.exe`) |
| `-NoStart` | Don't start the server or open the browser at the end |
| `-SkipBuild` | Install dependencies only |

The installer does the following:
- Installs dependencies and builds the server and the dashboard inside this folder.
- Adds `bin\` (and `%USERPROFILE%\.local\bin`, where Claude Code lives) to your user PATH.
- Writes `%USERPROFILE%\.octoally\install.json`, which the desktop app reads.
- Starts the dashboard at http://localhost:42010.

## Everyday use

```powershell
octoally start
```

Other commands:

| Command | Effect |
|---|---|
| `octoally stop` | Stop the server. Running sessions keep running. |
| `octoally restart` | Restart the server |
| `octoally status` | Server, port, auto-start and session daemon state |
| `octoally logs` | Follow the server log |
| `octoally install-service` / `uninstall-service` | Turn auto-start at login on or off |
| `octoally update` | `git pull` plus rebuild |
| `octoally mux ls` | List running sessions |

`octoally` works from cmd, PowerShell and Git Bash. `npx octoally` also forwards to this install.

## How sessions work on Windows

Linux/macOS keep sessions alive with **tmux**. On Windows that job is done by **winmux**, a small background process that is part of OctoAlly (`server/src/winmux`). It owns every session's console through Windows' ConPTY.

- **Sessions survive server restarts.** Stopping, restarting or updating the server never kills a session. As with tmux, sessions end when Windows shuts down.
- **Pop out.** The pop-out button opens the session in Windows Terminal, or a console window if Windows Terminal isn't installed. Detach with **Ctrl+B, then D** (same as tmux), or just close the window. Bring the session back from the dashboard's "External sessions" list.
- **Start a session yourself and adopt it later:**
  ```powershell
  octoally mux new -t "my task" -- claude
  ```
  It appears under "External sessions" for that folder.
- **Attach from any terminal:**
  ```powershell
  octoally mux attach <id>
  ```
  Other commands: `octoally mux capture <id>`, `octoally mux kill <id>`.
- **Prompts are passed safely.** Prompts reach Claude/Codex exactly as typed, including quotes, `%`, `&`, newlines and emoji. Programs installed with npm run directly, not through `cmd.exe`.

### Terminal shell

Plain terminals use PowerShell 7 (`pwsh`) if it is installed, otherwise Windows PowerShell. To change this, set `OCTOALLY_SHELL` before starting the server to `pwsh`, `powershell`, `cmd`, `bash` (Git Bash), or a full path to a program.

### Keys in browser terminals

| Keys | Effect |
|---|---|
| Ctrl+C with text selected | Copy |
| Ctrl+C with nothing selected | Interrupt |
| Ctrl+V | Paste |
| Right-click | Copy the selection, or paste if nothing is selected |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste, as on Linux |

## Seeing what Claude made

Open the file explorer (folder icon on the left) and click a file. The viewer can show these files:

| File types | Preview |
|---|---|
| png, jpg, gif, webp, avif, bmp, ico, svg | Image, with fit / zoom |
| mp4, webm, mov, m4v, ogv, mkv | Video player with seeking |
| mp3, wav, ogg, m4a, aac, flac, opus | Audio player |
| pdf | PDF viewer |
| html | Live page; its own CSS, JavaScript and images load |
| md | Rendered Markdown; images next to the file show |
| csv, tsv | Table |

Pages, SVG, Markdown and CSV files have a **Preview / Code** switch.

- **Auto-refresh.** The preview reloads by itself when Claude changes the file.
- **Toolbar buttons.** Reload, open in your browser, open in the default app, and show in File Explorer.
- **Clickable paths.** When Claude mentions a file in a session (e.g. `C:\...\demo.mp4` or `src/App.tsx`), click it to open the preview.
- **Safety.** Previewed web pages run on a separate local address, so they can't control OctoAlly.
- **Paste images.** Paste a screenshot into a session (Ctrl+V, Ctrl+Shift+V or right-click). It's saved in `%USERPROFILE%\.octoally\pastes` and its path is typed in, so Claude gets the image. Pasted images are deleted after 7 days.

## Desktop app

Build it with `install.ps1 -Desktop`, or run `npm run dist:win` in `desktop-electron`, then run `OctoAlly Setup <version>.exe`. On Windows the tray app:
- Starts and stops the server through the Windows CLI.
- Has an "Open OctoAlly at Login" option.
- Allows only one copy of itself to run.
- Provides voice dictation:
  - The microphone is captured with a bundled ffmpeg (DirectShow).
  - Local Whisper downloads the prebuilt whisper.cpp Windows build. No compiler is needed.

## Differences from Linux/macOS

| Linux/macOS | Windows |
|---|---|
| tmux / dtach | winmux (built in, nothing to install) |
| bash status line script using `jq` | Node script, installed as `node "<path>"` (works from Git Bash, cmd and PowerShell) |
| systemd / launchd service | Auto-start via `HKCU\...\Run` (no admin) |
| `npx octoally@latest` updates | `octoally update`. The npm release only ships Linux/macOS builds. |
| Pop-out to tilix/gnome-terminal/Terminal.app | Pop-out to Windows Terminal / console |

## Troubleshooting

- **"Login expired · Please run /login" inside a session.** Your Claude Code CLI sign-in has expired. Run `claude` in a terminal and use `/login`.
- **Server won't start.** Run `octoally logs`. If native modules are mismatched after a Node upgrade, `octoally start` rebuilds them automatically.
- **Port 42010 already in use.** Use `octoally stop`, or change the port in Settings.
- **Sessions not starting / daemon problems.** Run `octoally mux daemon-status` and read `%USERPROFILE%\.octoally\winmux.log`. `octoally mux kill-server` stops the daemon and **all** sessions.
- **Boxes instead of icons in the terminal.** Your prompt uses Nerd Font glyphs that the browser font lacks. This is cosmetic.
- **`octoally update` says there's no upstream branch.** `update` runs `git pull` on the branch you're on, so the branch has to track a remote, e.g. your own fork: `git push -u <your-remote> windows-port`. To pick up new upstream OctoAlly releases, merge them in: `git fetch origin`, then `git merge origin/main`, then `octoally update --force`.
- **npm tools give "running scripts is disabled" in a PowerShell terminal.** That's PowerShell's execution policy for npm's `.ps1` wrappers, the same as in any PowerShell window:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

This stops the server, removes auto-start and the PATH entry, and asks before deleting `%USERPROFILE%\.octoally`. It never deletes this folder.

## Testing

```powershell
cd server
npm run build
node scripts/e2e-windows.mjs
```

This runs a real server on port 42099 with a throwaway home folder. It checks:
- terminals
- surviving a server kill
- pop-out and adopt-back
- external sessions
- the status line from cmd, PowerShell and Git Bash
- kill and graceful shutdown

Add `--no-popout` to skip opening a Windows Terminal window.
