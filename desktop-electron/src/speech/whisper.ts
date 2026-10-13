/**
 * Whisper.cpp inference via subprocess.
 * Writes utterance to temp WAV file, runs whisper-cli, parses output.
 * Auto-downloads and builds whisper.cpp from source on first use
 * (Windows: downloads the prebuilt CPU x64 release zip instead).
 */

import { execFile, execFileSync, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { downloadFile } from './download';

const WHISPER_THREADS = 4;
const WHISPER_VERSION = 'v1.8.3';
const WHISPER_SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_VERSION}.tar.gz`;
// Plain CPU x64 build (whisper-cli.exe + its DLLs) from the GitHub release
const WHISPER_WINDOWS_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const IS_WINDOWS = process.platform === 'win32';

export interface WhisperInstallProgress {
  stage: 'downloading' | 'extracting' | 'building' | 'done' | 'error';
  percent: number;
  message: string;
}

function whisperBinDir(): string {
  return path.join(os.homedir(), '.octoally', 'bin');
}

function whisperBinPath(): string {
  return path.join(whisperBinDir(), 'whisper-cli');
}

/** Windows: whisper-cli.exe lives with its DLLs in ~/.octoally/bin/whisper/ */
function whisperWindowsDir(): string {
  return path.join(whisperBinDir(), 'whisper');
}

function whisperWindowsBinPath(): string {
  return path.join(whisperWindowsDir(), 'whisper-cli.exe');
}

function findWhisperBinaryWindows(): string | null {
  try {
    const out = execFileSync('where.exe', ['whisper-cli'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Only real executables — .cmd/.bat shims can't be run without a shell
    const found = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().endsWith('.exe') && fs.existsSync(l));
    if (found) return found;
  } catch {}

  const installed = whisperWindowsBinPath();
  return fs.existsSync(installed) ? installed : null;
}

/** Find the whisper.cpp binary */
export function findWhisperBinary(): string | null {
  if (IS_WINDOWS) return findWhisperBinaryWindows();

  // Check common names/locations
  const names = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
  const extraPaths = [
    whisperBinDir(),
    '/usr/local/bin',
    '/usr/bin',
  ];

  for (const name of names) {
    // Check PATH
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf-8', timeout: 2000 }).trim();
      if (result) return result;
    } catch {}

    // Check extra paths
    for (const dir of extraPaths) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * Check if build tools (cmake, make, gcc/g++) are available.
 * Returns missing tool names or empty array if all present.
 */
function checkBuildTools(): string[] {
  const missing: string[] = [];
  for (const tool of ['cmake', 'make', 'g++']) {
    try {
      execSync(`which ${tool}`, { timeout: 2000 });
    } catch {
      missing.push(tool);
    }
  }
  return missing;
}

/**
 * Download whisper.cpp source and build from source.
 * Installs the binary to ~/.octoally/bin/whisper-cli.
 */
export async function installWhisperBinary(
  onProgress: (progress: WhisperInstallProgress) => void,
): Promise<string> {
  if (IS_WINDOWS) return installWhisperBinaryWindows(onProgress);

  const destBin = whisperBinPath();

  // Already installed?
  if (fs.existsSync(destBin)) {
    onProgress({ stage: 'done', percent: 100, message: 'Already installed' });
    return destBin;
  }

  // Check build tools
  const missing = checkBuildTools();
  if (missing.length > 0) {
    const msg = `Missing build tools: ${missing.join(', ')}. Install with: sudo apt install ${missing.join(' ')}`;
    onProgress({ stage: 'error', percent: 0, message: msg });
    throw new Error(msg);
  }

  const tmpDir = path.join(os.tmpdir(), `octoally-whisper-build-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const tarball = path.join(tmpDir, 'whisper.cpp.tar.gz');

  try {
    // Stage 1: Download source tarball
    onProgress({ stage: 'downloading', percent: 0, message: 'Downloading whisper.cpp source...' });

    await downloadFile(WHISPER_SOURCE_URL, tarball, (p) => {
      onProgress({
        stage: 'downloading',
        percent: Math.round(p.percent * 0.3), // 0-30%
        message: `Downloading: ${(p.bytesDone / 1048576).toFixed(1)} / ${(p.bytesTotal / 1048576).toFixed(1)} MB`,
      });
    });

    // Stage 2: Extract
    onProgress({ stage: 'extracting', percent: 30, message: 'Extracting source...' });
    execSync(`tar xzf "${tarball}" -C "${tmpDir}"`, { timeout: 30000 });

    // Find extracted directory (whisper.cpp-1.8.3 or similar)
    const entries = fs.readdirSync(tmpDir).filter((e) => e.startsWith('whisper'));
    if (entries.length === 0) {
      throw new Error('Failed to find extracted whisper.cpp directory');
    }
    const srcDir = path.join(tmpDir, entries[0]);

    // Stage 3: Build with cmake
    onProgress({ stage: 'building', percent: 35, message: 'Building whisper.cpp (this takes ~30-60s)...' });

    const buildDir = path.join(srcDir, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    // cmake configure (static link so binary is self-contained)
    await runCommand('cmake', ['..', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF'], { cwd: buildDir });
    onProgress({ stage: 'building', percent: 50, message: 'Compiling...' });

    // cmake build (parallel)
    const cpus = os.cpus().length;
    await runCommand('cmake', ['--build', '.', '--config', 'Release', '-j', String(cpus)], { cwd: buildDir });
    onProgress({ stage: 'building', percent: 90, message: 'Installing binary...' });

    // Find the built binary
    const possibleBins = [
      path.join(buildDir, 'bin', 'whisper-cli'),
      path.join(buildDir, 'bin', 'main'),
      path.join(buildDir, 'whisper-cli'),
      path.join(buildDir, 'main'),
    ];

    let builtBin: string | null = null;
    for (const p of possibleBins) {
      if (fs.existsSync(p)) {
        builtBin = p;
        break;
      }
    }

    if (!builtBin) {
      throw new Error('Build succeeded but could not find whisper-cli binary');
    }

    // Copy to ~/.octoally/bin/
    fs.mkdirSync(whisperBinDir(), { recursive: true });
    fs.copyFileSync(builtBin, destBin);
    fs.chmodSync(destBin, 0o755);

    onProgress({ stage: 'done', percent: 100, message: 'whisper.cpp installed successfully' });
    console.error(`[STT] Installed whisper binary: ${destBin}`);

    return destBin;
  } finally {
    // Clean up build directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/** Recursively find a file by name (case-insensitive) under dir */
function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/** Run `whisper-cli.exe --help` to prove the exe and its DLLs load */
function verifyWhisperBinary(bin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--help'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (/usage:/i.test(output)) {
        resolve();
        return;
      }
      const code = (err as any)?.code;
      // 0xC0000135 STATUS_DLL_NOT_FOUND / 0xC000007B bad image — usually the VC++ runtime
      const hint = code === 3221225781 || code === -1073741515 || code === 3221225595 || code === -1073741701
        ? ' A required DLL is missing — install the Microsoft Visual C++ Redistributable (x64) and retry.'
        : '';
      reject(new Error(`whisper-cli failed to run (${err ? err.message : 'no usage output'}).${hint}`));
    });
  });
}

/**
 * Windows: download the prebuilt whisper.cpp CPU build and unpack it into
 * ~/.octoally/bin/whisper/ (whisper-cli.exe needs the DLLs next to it).
 * Emits the same progress stages as the build-from-source path.
 */
async function installWhisperBinaryWindows(
  onProgress: (progress: WhisperInstallProgress) => void,
): Promise<string> {
  const destDir = whisperWindowsDir();
  const destBin = whisperWindowsBinPath();

  // Already installed?
  if (fs.existsSync(destBin)) {
    onProgress({ stage: 'done', percent: 100, message: 'Already installed' });
    return destBin;
  }

  const tmpDir = path.join(os.tmpdir(), `octoally-whisper-${Date.now()}`);
  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  const zipPath = path.join(tmpDir, 'whisper-bin-x64.zip');

  try {
    // Stage 1: Download prebuilt release
    onProgress({ stage: 'downloading', percent: 0, message: `Downloading whisper.cpp ${WHISPER_VERSION} for Windows...` });
    await downloadFile(WHISPER_WINDOWS_ZIP_URL, zipPath, (p) => {
      onProgress({
        stage: 'downloading',
        percent: Math.round(p.percent * 0.8), // 0-80%
        message: `Downloading: ${(p.bytesDone / 1048576).toFixed(1)} / ${(p.bytesTotal / 1048576).toFixed(1)} MB`,
      });
    });

    // Stage 2: Extract — Windows' bsdtar (System32\tar.exe) reads zip files.
    // Use it explicitly: a GNU tar from Git/MSYS earlier on PATH cannot.
    onProgress({ stage: 'extracting', percent: 80, message: 'Extracting whisper.cpp...' });
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const tarBin = fs.existsSync(systemTar) ? systemTar : 'tar';
    await runCommand(tarBin, ['-xf', zipPath, '-C', extractDir]);

    const extractedBin = findFile(extractDir, 'whisper-cli.exe');
    if (!extractedBin) {
      throw new Error('Downloaded archive does not contain whisper-cli.exe');
    }

    // Copy the exe together with the DLLs beside it (ggml, whisper, SDL2)
    onProgress({ stage: 'extracting', percent: 90, message: 'Installing whisper-cli.exe...' });
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    const srcDir = path.dirname(extractedBin);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      if (entry.isFile() && (lower === 'whisper-cli.exe' || lower.endsWith('.dll'))) {
        fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
      }
    }

    // Stage 3: Verify it actually runs
    onProgress({ stage: 'extracting', percent: 95, message: 'Verifying whisper-cli.exe...' });
    try {
      await verifyWhisperBinary(destBin);
    } catch (e) {
      fs.rmSync(destDir, { recursive: true, force: true });
      throw e;
    }

    onProgress({ stage: 'done', percent: 100, message: 'whisper.cpp installed successfully' });
    console.error(`[STT] Installed whisper binary: ${destBin}`);
    return destBin;
  } catch (e: any) {
    const msg = e?.message || String(e);
    onProgress({ stage: 'error', percent: 0, message: msg });
    throw e instanceof Error ? e : new Error(msg);
  } finally {
    // Clean up download directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/** Run a command as a promise */
function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdout?.on('data', () => {}); // drain

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}\n${stderr}`));
      }
    });

    proc.on('error', (e) => reject(e));
  });
}

/**
 * Create a WAV buffer from Float32 PCM samples (16kHz mono 16-bit).
 */
export function createWavBuffer(samples: Float32Array, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Convert float32 to int16
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 32768 : s * 32767;
    buffer.writeInt16LE(Math.round(val), headerSize + i * 2);
  }

  return buffer;
}

/**
 * Run whisper.cpp inference on an audio utterance.
 * Returns the transcribed text.
 */
export function transcribe(
  whisperBin: string,
  modelPath: string,
  samples: Float32Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write temp WAV file
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `octoally-stt-${Date.now()}.wav`);

    try {
      fs.writeFileSync(tmpFile, createWavBuffer(samples));
    } catch (e) {
      reject(`Failed to write temp WAV: ${e}`);
      return;
    }

    const durationMs = (samples.length / 16000) * 1000;
    console.error(`[STT] Transcribing ${durationMs.toFixed(0)}ms of audio...`);

    const start = Date.now();

    const args = [
      '-m', modelPath,
      '-f', tmpFile,
      '-t', String(WHISPER_THREADS),
      '-l', 'en',
      '--no-timestamps',
      '-np', // no prints
    ];

    execFile(whisperBin, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {}

      if (err) {
        reject(`Whisper inference failed: ${err.message}\n${stderr}`);
        return;
      }

      // Parse output — whisper outputs text lines, strip whitespace
      const text = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('['))
        .join(' ')
        .trim();

      const elapsed = (Date.now() - start) / 1000;
      if (text) {
        console.error(`[STT] Transcription (${elapsed.toFixed(1)}s): "${text}"`);
      } else {
        console.error(`[STT] Empty transcription (noise/silence) (${elapsed.toFixed(1)}s)`);
      }

      resolve(text);
    });
  });
}
