/**
 * Audio capture using system tools (arecord on Linux, rec/sox on macOS,
 * ffmpeg + DirectShow on Windows).
 * Captures 16kHz mono PCM and feeds it to a callback.
 *
 * Port of desktop/src/speech/audio.rs (which uses cpal).
 */

import { spawn, spawnSync, execSync, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const TARGET_SAMPLE_RATE = 16000;

export interface AudioDevice {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  isHardware: boolean;
  formats: string[];
}

/** List available input devices */
export function listInputDevices(): AudioDevice[] {
  if (process.platform === 'linux') {
    return listAlsaDevices();
  }
  if (process.platform === 'darwin') {
    return listMacDevices();
  }
  if (process.platform === 'win32') {
    return listWindowsDevices();
  }
  return [
    {
      name: 'default',
      displayName: 'System Default',
      description: 'Default microphone',
      isDefault: true,
      isHardware: true,
      formats: [],
    },
  ];
}

function listAlsaDevices(): AudioDevice[] {
  const devices: AudioDevice[] = [
    {
      name: 'default',
      displayName: 'System Default',
      description: 'Recommended — uses your system\'s active microphone',
      isDefault: true,
      isHardware: true,
      formats: [],
    },
  ];

  try {
    // List ALSA capture devices
    const output = execSync('arecord -l 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const lines = output.split('\n');
    for (const line of lines) {
      // Format: "card N: Name [Description], device M: ..."
      const match = line.match(/^card (\d+): (\S+) \[(.+?)\], device (\d+): (.+)/);
      if (match) {
        const [, cardNum, , cardDesc, devNum] = match;
        const alsaName = `plughw:${cardNum},${devNum}`;
        devices.push({
          name: alsaName,
          displayName: cardDesc,
          description: `ALSA hw:${cardNum},${devNum}`,
          isDefault: false,
          isHardware: true,
          formats: [],
        });
      }
    }
  } catch {}

  // Also add pipewire/pulse if available
  try {
    execSync('which pw-record', { timeout: 2000 });
    devices.splice(1, 0, {
      name: 'pipewire',
      displayName: 'PipeWire',
      description: 'PipeWire audio server',
      isDefault: false,
      isHardware: false,
      formats: [],
    });
  } catch {}

  return devices;
}

function listMacDevices(): AudioDevice[] {
  // On macOS, just return system default — sox/rec handles device selection
  return [
    {
      name: 'default',
      displayName: 'System Default',
      description: 'Default microphone',
      isDefault: true,
      isHardware: true,
      formats: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// Windows: ffmpeg + DirectShow
// ---------------------------------------------------------------------------

/**
 * Resolve an ffmpeg binary for Windows capture: bundled ffmpeg-static
 * (unpacked from app.asar in the packaged app) → ffmpeg on PATH → error.
 */
export function resolveFfmpegPath(): string {
  const asarSegment = `app.asar${path.sep}`;
  const candidates: string[] = [];
  try {
    // Kept external by scripts/build.mjs so its __dirname-based path is real
    const bundled: string | null = require('ffmpeg-static');
    if (bundled) {
      candidates.push(bundled.replace(asarSegment, `app.asar.unpacked${path.sep}`));
    }
  } catch {}
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  }
  candidates.push(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));

  for (const p of candidates) {
    // Executables can't be spawned from inside app.asar
    if (!p.includes(asarSegment) && fs.existsSync(p)) return p;
  }

  try {
    const out = execFileSync('where.exe', ['ffmpeg'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
    if (found) return found;
  } catch {}

  throw new Error(
    'ffmpeg not found — it is needed for microphone capture on Windows. ' +
    'Reinstall OctoAlly Desktop (it bundles ffmpeg) or install ffmpeg and add it to PATH ' +
    '(e.g. "winget install Gyan.FFmpeg" or "scoop install ffmpeg").',
  );
}

export interface DshowDevice {
  name: string;
  altName?: string;
}

/**
 * Parse `ffmpeg -list_devices true -f dshow -i dummy` output (stderr).
 * Handles the current format (`"Name" (audio)`) and the older one with
 * "DirectShow audio devices" section headers.
 */
export function parseDshowAudioDevices(output: string): DshowDevice[] {
  const devices: DshowDevice[] = [];
  let inAudioSection = false;
  let last: DshowDevice | null = null;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]*\]\s*/, ''); // strip "[dshow @ 0x...]"
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; last = null; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; last = null; continue; }

    const alt = line.match(/^\s*Alternative name\s+"(.+)"\s*$/i);
    if (alt) {
      if (last) last.altName = alt[1];
      continue;
    }

    const m = line.match(/^\s*"(.+)"(?:\s+\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const isAudio = m[2] !== undefined ? /\baudio\b/i.test(m[2]) : inAudioSection;
    if (isAudio) {
      last = { name: m[1] };
      devices.push(last);
    } else {
      last = null;
    }
  }
  return devices;
}

/**
 * List DirectShow audio inputs. `altName` is only kept where the friendly
 * name can't be used in `-i audio=<name>` (contains ':' or is duplicated).
 */
function listDshowAudioDevices(ffmpeg: string): DshowDevice[] {
  // The list is printed on stderr; the exit code varies by ffmpeg version
  // (0 for "Immediate exit requested", non-zero for "dummy" input errors).
  const res = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    console.error(`[STT] ffmpeg device listing failed: ${res.error.message}`);
  }
  const devices = parseDshowAudioDevices(String(res.stderr || '') + String(res.stdout || ''));

  const counts = new Map<string, number>();
  for (const d of devices) counts.set(d.name, (counts.get(d.name) || 0) + 1);
  return devices.map((d) => ({
    name: d.name,
    altName: d.altName && (d.name.includes(':') || (counts.get(d.name) || 0) > 1) ? d.altName : undefined,
  }));
}

function listWindowsDevices(): AudioDevice[] {
  let found: DshowDevice[] = [];
  try {
    found = listDshowAudioDevices(resolveFfmpegPath());
  } catch (e) {
    console.error(`[STT] Could not list audio devices: ${e}`);
  }

  const devices: AudioDevice[] = [
    {
      name: 'default',
      displayName: 'System Default',
      description: found.length > 0
        ? `Recommended — uses the first available microphone (${found[0].name})`
        : 'Default microphone',
      isDefault: true,
      isHardware: true,
      formats: [],
    },
  ];
  for (const d of found) {
    devices.push({
      name: d.altName || d.name,
      displayName: d.name,
      description: 'DirectShow audio input',
      isDefault: false,
      isHardware: true,
      formats: [],
    });
  }
  return devices;
}

/**
 * Audio capture stream. Spawns a system process to capture mic audio
 * and calls onData with 16kHz mono Float32 PCM chunks.
 */
export class AudioCapture {
  private proc: ChildProcess | null = null;
  private stopped = false;
  /** Odd trailing byte from the previous stdout chunk (s16le samples are 2 bytes) */
  private leftover: Buffer | null = null;
  public onExit: ((code: number | null) => void) | null = null;

  constructor(
    private onData: (samples: Float32Array) => void,
    deviceName?: string,
  ) {
    if (process.platform === 'linux') {
      this.startLinux(deviceName);
    } else if (process.platform === 'darwin') {
      this.startMac(deviceName);
    } else if (process.platform === 'win32') {
      this.startWindows(deviceName);
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
  }

  private startLinux(deviceName?: string) {
    // Use pw-record if available (PipeWire), otherwise arecord (ALSA)
    const usePipeWire = deviceName === 'pipewire' || this.hasPwRecord();

    if (usePipeWire && deviceName !== 'default') {
      // PipeWire: pw-record outputs raw PCM to stdout
      const args = [
        '--format', 's16',
        '--rate', String(TARGET_SAMPLE_RATE),
        '--channels', '1',
        '-',
      ];
      console.error(`[STT] Starting pw-record: ${args.join(' ')}`);
      this.proc = spawn('pw-record', args);
    } else {
      // ALSA: arecord outputs raw PCM to stdout
      const args = [
        '-f', 'S16_LE',
        '-r', String(TARGET_SAMPLE_RATE),
        '-c', '1',
        '-t', 'raw',
      ];
      if (deviceName && deviceName !== 'default' && deviceName !== 'pipewire') {
        args.push('-D', deviceName);
      }
      args.push('-');
      console.error(`[STT] Starting arecord: ${args.join(' ')}`);
      this.proc = spawn('arecord', args);
    }

    this.pipeStdout();
  }

  private startMac(_deviceName?: string) {
    // Use sox's rec command for macOS
    const args = [
      '-q',           // quiet
      '-r', String(TARGET_SAMPLE_RATE),
      '-c', '1',      // mono
      '-b', '16',     // 16-bit
      '-e', 'signed', // signed int
      '-t', 'raw',    // raw PCM
      '-',            // stdout
    ];
    console.error(`[STT] Starting rec: ${args.join(' ')}`);
    this.proc = spawn('rec', args);
    this.pipeStdout();
  }

  private startWindows(deviceName?: string) {
    const ffmpeg = resolveFfmpegPath();

    // DirectShow has no "default" alias — use the first audio input
    let device = deviceName && deviceName !== 'default' ? deviceName : '';
    if (!device) {
      const devices = listDshowAudioDevices(ffmpeg);
      if (devices.length === 0) {
        throw new Error(
          'No microphone found. Connect a microphone and check that apps may use it ' +
          '(Windows Settings > Privacy & security > Microphone).',
        );
      }
      device = devices[0].altName || devices[0].name;
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-audio_buffer_size', '50', // ms — the ~500ms default delays VAD
      '-i', `audio=${device}`,
      '-ac', '1',
      '-ar', String(TARGET_SAMPLE_RATE),
      '-f', 's16le',
      '-',
    ];
    console.error(`[STT] Starting ffmpeg: ${args.join(' ')}`);
    // stdin is piped so stop() can send "q" for a clean shutdown
    this.proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin?.on('error', () => {}); // EPIPE if ffmpeg already exited
    this.pipeStdout();
  }

  private pipeStdout() {
    if (!this.proc?.stdout) {
      throw new Error('Failed to start audio capture process');
    }

    // Without a listener a missing binary (ENOENT) would crash the main process
    this.proc.on('error', (err) => {
      console.error(`[STT] Audio capture process error: ${err.message}`);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[STT] Audio process: ${msg}`);
    });

    this.proc.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      // Pipes may split a 2-byte sample across chunks — carry the odd byte over
      let buf = chunk;
      if (this.leftover) {
        buf = Buffer.concat([this.leftover, chunk]);
        this.leftover = null;
      }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) this.leftover = Buffer.from(buf.subarray(usable));
      if (usable === 0) return;

      // Convert S16_LE (signed 16-bit little-endian) to Float32
      const samples = new Float32Array(usable / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buf.readInt16LE(i * 2) / 32768;
      }
      this.onData(samples);
    });

    this.proc.on('close', (code) => {
      console.error(`[STT] Audio capture process exited with code ${code}`);
      this.proc = null;
      if (this.onExit) this.onExit(code);
    });
  }

  private hasPwRecord(): boolean {
    try {
      execSync('which pw-record', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.stopped = true;
    this.leftover = null;
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;

    if (process.platform === 'win32') {
      // Ask ffmpeg to quit cleanly ("q" on stdin); TerminateProcess if it lingers
      const killTimer = setTimeout(() => {
        try { proc.kill(); } catch {}
      }, 1000);
      proc.once('exit', () => clearTimeout(killTimer));
      try {
        proc.stdin?.write('q');
        proc.stdin?.end();
      } catch {
        clearTimeout(killTimer);
        try { proc.kill(); } catch {}
      }
      return;
    }

    proc.kill('SIGTERM');
  }
}

/**
 * Linear resample from sourceRate to targetRate.
 * Port of resample() from audio.rs.
 */
export function resample(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate) return samples;

  const ratio = sourceRate / targetRate;
  const outputLen = Math.ceil(samples.length / ratio);
  const output = new Float32Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;

    if (idx + 1 < samples.length) {
      output[i] = samples[idx] * (1 - frac) + samples[idx + 1] * frac;
    } else if (idx < samples.length) {
      output[i] = samples[idx];
    }
  }

  return output;
}
