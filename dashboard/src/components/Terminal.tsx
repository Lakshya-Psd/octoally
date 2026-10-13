import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { RotateCcw, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import { useSpeechStore } from '../lib/speech';
import { isKeyboardNavActive } from '../lib/shortcuts';
import { api } from '../lib/api';
import { isWindowsClient, getPlatformSync } from '../lib/platform';
import { registerFileLinks } from '../lib/terminal-file-links';
import { HistoryViewer } from './HistoryViewer';
import '@xterm/xterm/css/xterm.css';

// Global event: when any terminal connects, notify all others to retry immediately.
// This prevents staggered reconnects after a server restart.
const serverAliveListeners = new Set<() => void>();
function notifyServerAlive() {
  for (const fn of serverAliveListeners) fn();
}


// Global terminal connection tracking — lets App.tsx show a "connecting" indicator
const pendingTerminals = new Set<string>();
const connectionListeners = new Set<() => void>();
export function getPendingTerminalCount() { return pendingTerminals.size; }
export function onTerminalConnectionChange(fn: () => void) {
  connectionListeners.add(fn);
  return () => { connectionListeners.delete(fn); };
}
function notifyConnectionChange() {
  for (const fn of connectionListeners) fn();
}

interface TerminalProps {
  sessionId: string;
  visible?: boolean;
  /** When true, disconnect the WebSocket and stop receiving data.
   *  Used to yield the session to another Terminal (e.g. ActiveTerminals grid). */
  suspended?: boolean;
  /** When true, don't send resize commands to the server PTY.
   *  Grid/thumbnail views use this to avoid corrupting the PTY column width
   *  that the main terminal depends on. */
  passiveResize?: boolean;
  /** Hide the xterm.js cursor. Used for RuFlo sessions where the CLI renders its own cursor. */
  hideCursor?: boolean;
  /** CLI type — Codex sessions need capture-pane refresh on tab switch/resize */
  cliType?: 'claude' | 'codex';
  onExit?: (exitCode: number) => void;
  onReconnect?: () => void;
  onPopOut?: () => void;
  /** Project folder, for resolving relative file paths printed in the terminal. */
  projectPath?: string;
  /** Called when a file path in the output is clicked (opens it in the file viewer). */
  onOpenFile?: (path: string) => void;
}

export function Terminal({ sessionId, visible = true, suspended = false, passiveResize = false, hideCursor = false, cliType, onExit, onReconnect, onPopOut, projectPath, onOpenFile }: TerminalProps) {
  // Latest values for the file-link provider, which is registered once per terminal.
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false);

  // Read terminal font size from settings
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 30_000,
  });
  const configuredFontSize = Number(settingsData?.settings?.terminal_font_size) || 12;
  const [showHistory, setShowHistory] = useState(false);

  // Expose connect/disconnect so the suspension effect can control it
  const connectFnRef = useRef<(() => void) | null>(null);
  const disconnectFnRef = useRef<(() => void) | null>(null);
  const isSuspendedRef = useRef(suspended);
  const passiveResizeRef = useRef(passiveResize);
  passiveResizeRef.current = passiveResize;
  const hideCursorRef = useRef(hideCursor);
  hideCursorRef.current = hideCursor;
  const cliTypeRef = useRef(cliType);
  cliTypeRef.current = cliType;
  // Debounce timer for Codex capture-pane refreshes — prevents multiple
  // effects (suspension + visible) from stacking duplicate captures.
  const codexRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  isSuspendedRef.current = suspended;

  // Hard refresh — the dedicated "screen is messed up, fix it" path. Always
  // clears the xterm buffer first so stale stacked renders are discarded,
  // then forces the CLI to redraw into the clean buffer. Intentionally heavier
  // than the passive refit that tab switches / visibility changes use.
  const hardRefresh = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const fit = fitRef.current;
    const w = wsRef.current;
    if (fit) fit.fit();

    if (!w || w.readyState !== WebSocket.OPEN) {
      // WebSocket not open — full reconnect, server will replay into clean buffer
      term.reset();
      disconnectFnRef.current?.();
      setTimeout(() => connectFnRef.current?.(), 50);
      return;
    }

    if (cliTypeRef.current === 'codex') {
      // Codex doesn't redraw on SIGWINCH. Send resize so tmux pane matches
      // our width, then clear and request a capture-pane refresh.
      w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        term.reset();
        w.send(JSON.stringify({ type: 'refresh' }));
      }, 300);
      return;
    }

    if (hideCursorRef.current) {
      // Claude session/agent: reset first to clear stacked renders, then
      // SIGWINCH-toggle so Claude redraws into the now-clean buffer.
      term.reset();
      const cols = term.cols;
      const rows = term.rows;
      w.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        w.send(JSON.stringify({ type: 'resize', cols, rows }));
      }, 100);
      return;
    }

    // Plain terminal — reconnect for a fresh server replay.
    term.reset();
    disconnectFnRef.current?.();
    setTimeout(() => connectFnRef.current?.(), 50);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    // Create terminal
    const term = new XTerm({
      cursorBlink: false,
      cursorStyle: hideCursor ? 'bar' : 'block',
      cursorWidth: hideCursor ? 1 : undefined,
      cursorInactiveStyle: hideCursor ? 'none' : 'outline',
      fontSize: configuredFontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: '#0f1117',
        foreground: '#e4e8f1',
        cursor: hideCursor ? '#0f1117' : '#3b82f6',
        cursorAccent: hideCursor ? '#0f1117' : undefined,
        selectionBackground: '#3b82f680',
        black: '#1a1d27',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e8f1',
        brightBlack: '#4b5563',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f9fafb',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // WebGL renderer — faster glyph rendering via GPU. Causes ~10% idle CPU
    // in Tauri/WebKitGTK (compositor polls GL surfaces at vsync), but
    // Chromium (Electron/browser) handles idle GL contexts properly.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, canvas2d renderer is the default fallback
    }

    // Make URLs in terminal output clickable — open in system browser
    term.loadAddon(new WebLinksAddon((event, url) => {
      event.preventDefault();
      console.log('[octoally] Link clicked in terminal:', url);
      // In Electron: use IPC to call shell.openExternal directly (avoids
      // xterm.js WebLinksAddon's window.open() which opens about:blank).
      // In browser: use server API to call xdg-open/open.
      if ('electronAPI' in window) {
        (window as any).electronAPI.invoke('open-external', url);
      } else {
        fetch('/api/open-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        }).catch(e => console.error('[octoally] open-url failed:', e));
      }
    }));

    // Make file paths in the output clickable — open them in the file viewer
    // (or the default app when this terminal has no viewer, e.g. the grid).
    registerFileLinks(term, {
      getProjectPath: () => projectPathRef.current,
      isWindows: () => getPlatformSync().platform === 'win32',
      onOpen: (path) => {
        if (onOpenFileRef.current) onOpenFileRef.current(path);
        else api.files.openExternal(path).catch(() => {});
      },
    });

    // Fit after a small delay to ensure container is sized
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Single paste path for every trigger (paste event, Ctrl+Shift+V, and on
    // Windows Ctrl+V / right-click) — `paste: true` keeps bracketed paste.
    // Returns false when there was nothing to send (empty text / socket down).
    const sendPaste = (text: string | undefined | null): boolean => {
      const w = wsRef.current;
      if (!text || !w || w.readyState !== WebSocket.OPEN) return false;
      w.send(JSON.stringify({ type: 'input', data: text, paste: true }));
      return true;
    };
    // A pasted image (e.g. a screenshot) is saved by the server and its path
    // pasted instead — Claude Code attaches an image given by path.
    const sendImage = (image: Blob): void => {
      api.files.pasteImage(image)
        .then(({ path }) => { sendPaste(/\s/.test(path) ? `"${path}" ` : `${path} `); })
        .catch((err) => console.error('[Terminal] image paste failed:', err));
    };
    // The clipboard's image, but only when it holds no text: apps like Excel
    // put both on the clipboard, and then the text is what's meant.
    const imageFromTransfer = (data: DataTransfer | null): File | null => {
      if (!data || data.getData('text')) return null;
      for (const item of Array.from(data.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
      }
      return null;
    };
    // Read the clipboard explicitly and paste it. Used where no native paste
    // event is available (Ctrl+Shift+V keydown we cancel, right-click).
    const pasteFromClipboard = async () => {
      try {
        if (typeof navigator.clipboard?.read === 'function') {
          const items = await navigator.clipboard.read();
          const hasText = items.some((i) => i.types.includes('text/plain'));
          const imageItem = hasText ? undefined : items.find((i) => i.types.some((t) => t.startsWith('image/')));
          if (imageItem) {
            const type = imageItem.types.find((t) => t.startsWith('image/'))!;
            sendImage(await imageItem.getType(type));
            return;
          }
        }
      } catch { /* read() refused or unsupported — fall back to text */ }
      navigator.clipboard?.readText().then(sendPaste).catch(() => {});
    };
    const canReadClipboard = typeof navigator.clipboard?.readText === 'function';
    // Copy the current selection; false when nothing is selected.
    const copySelection = (): boolean => {
      const sel = term.getSelection();
      if (!sel) return false;
      navigator.clipboard?.writeText(sel).catch(() => {});
      return true;
    };
    // Layout-aware letter match that still works on non-Latin layouts
    // (e.g. Cyrillic `с` on the physical C key), like Windows Terminal.
    const isLetter = (e: KeyboardEvent, letter: 'c' | 'v') =>
      e.key.toLowerCase() === letter || (!/^[a-z]$/i.test(e.key) && e.code === `Key${letter.toUpperCase()}`);

    // Intercept Ctrl+Shift+C to copy selection
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        copySelection();
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+V: read clipboard explicitly and send as input.
      // Can't rely on browser firing a paste event — synthetic keystrokes
      // (e.g. from text expanders like espanso via xdotool) don't trigger it.
      if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        pasteFromClipboard();
        e.preventDefault();
        return false;
      }
      // Windows conventions (Windows Terminal / conhost). Linux keeps Ctrl+C/V
      // as raw ^C / ^V; Ctrl+Shift+C/V above work everywhere.
      if (isWindowsClient && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.type === 'keydown') {
        // Ctrl+C with a selection copies it (and clears it) instead of sending
        // ^C. Without a selection it falls through to xterm → ^C as usual.
        if (isLetter(e, 'c') && term.hasSelection()) {
          copySelection();
          term.clearSelection();
          e.preventDefault();
          return false;
        }
        // Ctrl+V pastes text instead of sending ^V (\x16). Returning false
        // stops xterm from emitting \x16 but leaves the browser's default
        // action alone, so the native `paste` event reaches pasteHandler
        // below → sendPaste (same path as Ctrl+Shift+V; no clipboard
        // permission prompt, and exactly one paste).
        if (isLetter(e, 'v')) return false;
      }
      return true;
    });

    // Handle paste via native browser event — works in all contexts including WebKitGTK/Tauri
    // Listen on xterm's hidden textarea in capture phase, stop propagation to prevent xterm's
    // built-in paste handler from also firing (which would cause double paste)
    const xtermTextarea = containerRef.current.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
    const pasteTarget = xtermTextarea || containerRef.current;
    const pasteHandler = (ev: Event) => {
      const ce = ev as ClipboardEvent;
      const image = imageFromTransfer(ce.clipboardData);
      if (image) {
        sendImage(image);
        ce.preventDefault();
        ce.stopImmediatePropagation();
        return;
      }
      if (sendPaste(ce.clipboardData?.getData('text'))) {
        ce.preventDefault();
        ce.stopImmediatePropagation();
      }
    };
    pasteTarget.addEventListener('paste', pasteHandler, { capture: true });

    // Windows: right-click copies the selection if there is one, otherwise
    // pastes (Windows Terminal behaviour). The browser menu is suppressed only
    // when we handled the click. Apps that track the mouse (e.g. TUIs with
    // mouse mode on) keep receiving right-clicks unless Shift is held.
    const contextTarget = containerRef.current;
    const contextMenuHandler = (ev: MouseEvent) => {
      if (term.hasSelection()) {
        copySelection();
        term.clearSelection();
      } else if (term.modes.mouseTrackingMode !== 'none' && !ev.shiftKey) {
        return; // the app owns mouse clicks — don't paste over it
      } else if (canReadClipboard) {
        pasteFromClipboard();
      } else {
        return; // no clipboard API (insecure context) — leave the browser menu
      }
      ev.preventDefault();
      ev.stopPropagation();
      term.focus();
    };
    if (isWindowsClient) contextTarget.addEventListener('contextmenu', contextMenuHandler, { capture: true });

    termRef.current = term;
    fitRef.current = fitAddon;

    // RAF-based write batching — accumulate WS data and flush once per frame
    let pendingData = '';
    let rafId: number | null = null;

    function flushWrite() {
      rafId = null;
      if (pendingData) {
        const data = pendingData;
        pendingData = '';
        term.write(data);
      }
    }

    // Send user input to server
    // Filter out xterm.js focus reporting sequences (\x1b[I = focus in, \x1b[O = focus out)
    // These get sent when terminal gains/loses focus and Claude Code's TUI interprets them as input
    term.onData((data: string) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onBinary((data: string) => {
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // WebSocket connection with auto-reconnect
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let intentionalClose = false;
    // Suspension: close without showing disconnect messages or triggering reconnect
    let suspendedClose = false;
    // Set when doResize wanted to send but WS wasn't open yet
    let pendingResize = false;
    function connectWs() {
      if (isSuspendedRef.current) return;

      // Close any existing connection first
      const old = wsRef.current;
      if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
        suspendedClose = true;
        old.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (passiveResizeRef.current) params.set('passive', '1');
      params.set('attempt', String(reconnectAttempts));
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal/${sessionId}?${params}`);
      wsRef.current = ws;
      pendingTerminals.add(sessionId);
      notifyConnectionChange();

      ws.onopen = () => {
        setConnected(true);
        pendingTerminals.delete(sessionId);
        notifyConnectionChange();
        reconnectAttempts = 0;
        // If a resize was missed while WS was connecting, send it now.
        if (pendingResize) {
          pendingResize = false;
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
        term.focus();
        notifyServerAlive();

        // Force tmux reflow: resize to cols-1 then back to correct width.
        // Only for sessions (hideCursor=true) where CLI redraws
        // on SIGWINCH. Plain terminals (bash) don't redraw old output, so
        // force-resize just corrupts the tmux pane history via lossy reflow.
        // SKIP for Codex: Codex TUI redraws accumulate in tmux scrollback,
        // causing capture-pane to show duplicate output.
        if (!passiveResizeRef.current && hideCursorRef.current && cliTypeRef.current !== 'codex') {
          const cols = term.cols;
          const rows = term.rows;
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
                }
              }, 100);
            }
          }, 200);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'output':
              reconnectAttempts = 0;
              // Defense-in-depth: strip focus reporting enable/disable sequences
              // so xterm.js never enters sendFocusMode (which causes focus/blur
              // events to be sent as input, corrupting Codex TUI rendering)
              pendingData += msg.data.replace(/\x1b\[\?1004[hl]/g, '');
              if (rafId === null) {
                rafId = requestAnimationFrame(flushWrite);
              }
              break;
            case 'exit':
              if (msg.reason === 'popped-out') {
                term.write(`\r\n\x1b[36m[Popped out to system terminal]\x1b[0m\r\n`);
              } else {
                term.write(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
              }
              intentionalClose = true;
              onExit?.(msg.exitCode);
              break;
            case 'error':
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              intentionalClose = true;
              break;
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (suspendedClose) {
          suspendedClose = false;
          return;
        }
        if (intentionalClose) {
          term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
          return;
        }

        // Exponential backoff reconnect
        if (reconnectAttempts < 30) {
          const delay = Math.min(100 * Math.pow(1.5, reconnectAttempts), 5000);
          reconnectAttempts++;
          if (!passiveResizeRef.current) {
            term.write(`\r\n\x1b[90m[Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/30)...]\x1b[0m\r\n`);
          }
          reconnectTimer = setTimeout(() => {
            term.clear();
            connectWs();
          }, delay);
        } else {
          term.write('\r\n\x1b[31m[Connection lost — max reconnect attempts reached]\x1b[0m\r\n');
        }
      };
    }

    function disconnectWs() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        suspendedClose = true;
        ws.close();
      }
      wsRef.current = null;
    }

    // When another terminal connects, immediately retry if we're stuck in backoff.
    // Don't touch terminals that are already OPEN or CONNECTING — interrupting
    // a CONNECTING socket causes a cascade of reconnections.
    function onServerAlive() {
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      // Only act if we're waiting on a backoff timer
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
        term.clear();
        connectWs();
      }
    }
    serverAliveListeners.add(onServerAlive);

    // Expose to the suspension effect
    connectFnRef.current = connectWs;
    disconnectFnRef.current = disconnectWs;

    // Initial connection (unless suspended)
    if (!isSuspendedRef.current) {
      connectWs();
    }

    // Handle resize — debounced
    let lastCols = term.cols;
    let lastRows = term.rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let firstResize = true;

    function doResize() {
      fitAddon.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (!passiveResizeRef.current) {
          const w = wsRef.current;
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            }));
            // Force PTY redraw via SIGWINCH toggle
            const cols = term.cols;
            const rows = term.rows;
            setTimeout(() => {
              if (w.readyState === WebSocket.OPEN) {
                w.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
                setTimeout(() => {
                  if (w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols, rows }));
                  }
                }, 50);
              }
            }, 50);
          } else {
            // WS not open yet — send when it connects
            pendingResize = true;
          }
        }
      }
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && (entry.contentRect.width < 10 || entry.contentRect.height < 10)) return;

      if (firstResize) {
        // Send first resize immediately (triggers server replay + spawn)
        firstResize = false;
        doResize();
        return;
      }

      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doResize, 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      intentionalClose = true;
      pendingTerminals.delete(sessionId);
      notifyConnectionChange();
      serverAliveListeners.delete(onServerAlive);
      connectFnRef.current = null;
      disconnectFnRef.current = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      pasteTarget.removeEventListener('paste', pasteHandler, { capture: true } as EventListenerOptions);
      if (isWindowsClient) contextTarget.removeEventListener('contextmenu', contextMenuHandler, { capture: true } as EventListenerOptions);
      wsRef.current?.close();
      term.dispose();
    };
  }, [sessionId, onExit]);

  // Suspension effect: disconnect WebSocket when suspended, reconnect when resumed.
  // This ensures only one Terminal connects to a given session at a time.
  // Skip the initial mount — the main effect already handles the first connection.
  const suspendInitRef = useRef(true);
  useEffect(() => {
    if (suspendInitRef.current) {
      suspendInitRef.current = false;
      return;
    }
    if (suspended) {
      disconnectFnRef.current?.();
    } else {
      // Resume — full reset of xterm (clears viewport + scrollback) then
      // reconnect so the server replay renders into a completely clean terminal.
      if (termRef.current && connectFnRef.current) {
        termRef.current.reset();
        connectFnRef.current();
        // For Codex: raw replay buffer contains garbled chunks from different widths.
        // After reconnect settles, refit to current container width, send resize
        // to the server (tmux pane may be at a different width from Active Sessions
        // grid), then trigger a capture-pane refresh for clean display.
        // Use debounced timer so visible effect's refresh doesn't stack with this one.
        if (cliType === 'codex') {
          if (codexRefreshTimer.current) clearTimeout(codexRefreshTimer.current);
          codexRefreshTimer.current = setTimeout(() => {
            codexRefreshTimer.current = null;
            const term = termRef.current;
            const fit = fitRef.current;
            const w = wsRef.current;
            if (term && w && w.readyState === WebSocket.OPEN) {
              if (fit) fit.fit();
              w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
              // Allow tmux + Codex to reflow at new width before capturing
              setTimeout(() => {
                if (w.readyState === WebSocket.OPEN) {
                  term.reset();
                  w.send(JSON.stringify({ type: 'refresh' }));
                }
              }, 300);
            }
          }, 500);
        }
      }
    }
  }, [suspended]);

  // When passiveResize changes from true→false (grid→full terminal), the
  // replayed output is at the wrong (narrow grid) width. Clear the terminal
  // and reconnect so the server sends a fresh replay at the correct width
  // and the resize goes through to the PTY.
  const prevPassiveRef = useRef(passiveResize);
  useEffect(() => {
    const wasPassive = prevPassiveRef.current;
    prevPassiveRef.current = passiveResize;

    if (wasPassive && !passiveResize && !suspended && termRef.current) {
      // Switching from passive (grid) to active (full) — clear and reconnect
      termRef.current.reset();
      disconnectFnRef.current?.();
      setTimeout(() => connectFnRef.current?.(), 50);
    }
  }, [passiveResize, suspended]);

  // Update font size when setting changes (without recreating the terminal)
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const w = wsRef.current;
    if (!term) return;
    if (term.options.fontSize !== configuredFontSize) {
      term.options.fontSize = configuredFontSize;
      fit?.fit();
      // Notify PTY of new dimensions and force redraw via SIGWINCH toggle
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        setTimeout(() => {
          w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
          setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
        }, 50);
      }
    }
  }, [configuredFontSize]);

  // Reactively hide/show the xterm.js cursor when hideCursor prop changes
  // (e.g. when session data loads after mount)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (hideCursor) {
      // DECTCEM: hide cursor at VT level + make cursor transparent
      term.write('\x1b[?25l');
      term.options.cursorBlink = false;
      term.options.cursorInactiveStyle = 'none';
    } else {
      term.write('\x1b[?25h');
      term.options.cursorBlink = false;
      term.options.cursorInactiveStyle = 'outline';
    }
  }, [hideCursor]);

  // Re-focus and refit terminal when it becomes visible.
  // Single RAF + short delay ensures DOM layout is settled before measuring.
  // Skip auto-focus when the tab change came from a keyboard shortcut —
  // otherwise the user gets trapped in the terminal and can't keep navigating.
  useEffect(() => {
    if (visible && !suspended && termRef.current) {
      const skipFocus = isKeyboardNavActive();
      termRef.current.scrollToBottom();
      if (!skipFocus) termRef.current.focus();
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const fit = fitRef.current;
        const term = termRef.current;
        const w = wsRef.current;
        if (fit && term) {
          fit.fit();
          if (!passiveResizeRef.current && w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            // Codex: after resize, send capture-pane refresh for correct display.
            // Raw replay chunks from different widths render garbled for Codex.
            // Debounced so it doesn't stack with the suspension effect's refresh.
            if (cliType === 'codex') {
              if (codexRefreshTimer.current) clearTimeout(codexRefreshTimer.current);
              codexRefreshTimer.current = setTimeout(() => {
                codexRefreshTimer.current = null;
                if (!cancelled && w.readyState === WebSocket.OPEN) {
                  term.reset();
                  w.send(JSON.stringify({ type: 'refresh' }));
                }
              }, 500);
            }
          }
          term.scrollToBottom();
          if (!skipFocus) term.focus();
        }
      });
      return () => { cancelled = true; };
    }
  }, [visible, suspended, cliType]);

  // Re-focus terminal when returning from a different browser tab
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && visible && !suspended && termRef.current) {
        const term = termRef.current;
        term.focus();
        requestAnimationFrame(() => {
          fitRef.current?.fit();
          term.scrollToBottom();
          term.focus();
        });
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [visible, suspended]);

  // Dictation mode: route transcriptions to this terminal when it's the visible/active one
  const dictationMode = useSpeechStore((s) => s.dictationMode);
  const lastTranscription = useSpeechStore((s) => s.lastTranscription);
  const dictationLastSent = useRef('');
  useEffect(() => {
    if (!dictationMode || !visible || suspended) return;
    if (!lastTranscription || lastTranscription === dictationLastSent.current) return;
    dictationLastSent.current = lastTranscription;
    const w = wsRef.current;
    if (w && w.readyState === WebSocket.OPEN) {
      w.send(JSON.stringify({ type: 'input', data: lastTranscription }));
      termRef.current?.focus();
    }
  }, [lastTranscription, dictationMode, visible, suspended]);

  // Voice command: press Enter in active terminal
  const pendingEnter = useSpeechStore((s) => s.pendingEnter);
  useEffect(() => {
    if (pendingEnter === 0 || !visible || suspended) return;
    const w = wsRef.current;
    if (w && w.readyState === WebSocket.OPEN) {
      console.log('[STT] Sending Enter (\\r) to terminal', sessionId);
      w.send(JSON.stringify({ type: 'input', data: '\r' }));
    }
  }, [pendingEnter, visible, suspended]);

  // Voice command: send control sequences (delete words, clear text)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!visible || suspended) return;
      const { data } = (e as CustomEvent).detail;
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    };
    window.addEventListener('octoally:terminal-input', handler);
    return () => window.removeEventListener('octoally:terminal-input', handler);
  }, [visible, suspended]);

  // Voice command / external refresh event — shares the hardRefresh path so
  // voice "refresh terminal" and the refresh button behave identically.
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      hardRefresh();
    };
    window.addEventListener('octoally:refresh-terminal', handler);
    return () => window.removeEventListener('octoally:refresh-terminal', handler);
  }, [sessionId, hardRefresh]);

  // Focus terminal on demand (e.g. switching from grid to single view)
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      const term = termRef.current;
      if (term) {
        term.scrollToBottom();
        term.focus();
      }
    };
    window.addEventListener('octoally:focus-terminal', handler);
    return () => window.removeEventListener('octoally:focus-terminal', handler);
  }, [sessionId]);

  return (
    <div className="h-full relative group/terminal" onClick={() => termRef.current?.focus()}>
      <div className="absolute top-2 right-5 z-10 flex items-center gap-2">
        {connected && !suspended && (
          <>
            <button
              onClick={() => {
                const term = termRef.current;
                const fit = fitRef.current;
                const w = wsRef.current;
                if (!term) return;
                const current = term.options.fontSize || 13;
                if (current > 6) {
                  term.options.fontSize = current - 1;
                  fit?.fit();
                  if (w && w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    // Force PTY redraw via SIGWINCH toggle
                    setTimeout(() => {
                      w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                      setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
                    }, 50);
                  }
                }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Zoom out"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                const term = termRef.current;
                const fit = fitRef.current;
                const w = wsRef.current;
                if (!term) return;
                const current = term.options.fontSize || 13;
                if (current < 32) {
                  term.options.fontSize = current + 1;
                  fit?.fit();
                  if (w && w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    setTimeout(() => {
                      w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                      setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
                    }, 50);
                  }
                }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Zoom in"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              onClick={async () => {
                try {
                  const result = await api.sessions.popOut(sessionId);
                  if (result.ok) onPopOut?.();
                } catch { /* ignore */ }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--accent)', color: 'white' }}
              title="Pop out to system terminal"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
            <button
              onClick={hardRefresh}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--accent)', color: 'white' }}
              title="Refresh terminal display"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </>
        )}
        {!connected && !suspended && (
          <>
            {onReconnect && (
              <button onClick={onReconnect}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                style={{ background: 'var(--accent)', color: 'white' }}>
                <RotateCcw className="w-3 h-3" /> Reconnect
              </button>
            )}
            <div className="px-2 py-1 rounded text-xs" style={{ background: 'var(--error)', color: 'white' }}>
              Disconnected
            </div>
          </>
        )}
      </div>
      <div
        ref={containerRef}
        className={`h-full w-full overflow-hidden${hideCursor ? ' hide-xterm-cursor' : ''}`}
        style={{
          padding: '4px',
          background: '#0f1117',
        }}
      />
      {showHistory && (
        <HistoryViewer sessionId={sessionId} onClose={() => setShowHistory(false)} />
      )}
    </div>
  );
}
