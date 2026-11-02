import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { log } from '../log';

const RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15';
const MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
/** whisper.cpp's prebuilt Windows CLI for this machine (the release assets are named by architecture). */
const ASSET = os.arch() === 'arm64' ? /^whisper-bin-win-cpu-arm64\.zip$/ : /^whisper-bin-x64\.zip$/;
const CLI = 'whisper-cli.exe';

export interface Progress {
  (what: string, fraction?: number): void;
}

/**
 * Speech to text on the local machine with whisper.cpp (no audio leaves the machine). The CLI and a model are downloaded
 * once into `<dataDir>/whisper`: the newest whisper.cpp release that ships a Windows build, and the chosen model.
 */
export class Whisper {
  private dir: string;

  constructor(dataDir: string, private model: () => string) {
    this.dir = path.join(dataDir, 'whisper');
  }

  private modelFile(): string {
    return path.join(this.dir, `ggml-${this.model()}.bin`);
  }

  private cli(): string | undefined {
    const find = (d: string): string | undefined => {
      if (!fs.existsSync(d)) return undefined;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name.toLowerCase() === CLI) return p;
        if (e.isDirectory()) {
          const f = find(p);
          if (f) return f;
        }
      }
      return undefined;
    };
    return find(path.join(this.dir, 'bin'));
  }

  /** What still has to be downloaded (empty: ready). */
  missing(): ('program' | 'model')[] {
    return [...(this.cli() ? [] : ['program' as const]), ...(fs.existsSync(this.modelFile()) ? [] : ['model' as const])];
  }

  async install(progress: Progress): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.cli()) {
      progress('Finding the latest whisper.cpp build…');
      const releases = (await (await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } })).json()) as any[];
      const asset = releases.flatMap((r) => r.assets ?? []).find((a: any) => ASSET.test(a.name));
      if (!asset) throw new Error('No whisper.cpp Windows build found on GitHub');
      const zip = path.join(this.dir, asset.name);
      await download(asset.browser_download_url, zip, (f) => progress(`Downloading whisper.cpp (${mb(asset.size)})`, f));
      progress('Unpacking whisper.cpp…');
      fs.rmSync(path.join(this.dir, 'bin'), { recursive: true, force: true });
      fs.mkdirSync(path.join(this.dir, 'bin'));
      // Windows 10+ ships bsdtar, which reads zip (named in full: a Git Bash GNU tar on PATH can't).
      const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await run(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', path.join(this.dir, 'bin')]);
      fs.rmSync(zip, { force: true });
      if (!this.cli()) throw new Error(`${CLI} was not in the whisper.cpp download`);
      log('voice', `whisper.cpp installed from ${asset.browser_download_url}`);
    }
    if (!fs.existsSync(this.modelFile())) {
      const name = path.basename(this.modelFile());
      await download(`${MODELS}/${name}`, this.modelFile(), (f, total) => progress(`Downloading the ${this.model()} model${total ? ` (${mb(total)})` : ''}`, f));
      log('voice', `model ${name} downloaded`);
    }
  }

  /** Text of a 16 kHz mono WAV. `prompt`: words to expect (names, files), which Whisper then spells right. */
  async transcribe(wavFile: string, prompt: string): Promise<string> {
    const cli = this.cli();
    if (!cli) throw new Error('whisper.cpp is not installed');
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 1)));
    const args = ['-m', this.modelFile(), '-f', wavFile, '-nt', '-np', '-t', threads, ...(prompt ? ['--prompt', prompt] : [])];
    return cleanTranscript(await run(cli, args, 120000));
  }
}

/** whisper-cli's text output as one line, without its markers for silence or sounds ("[BLANK_AUDIO]", "(wind)"). */
export function cleanTranscript(out: string): string {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[A-Z_ ]+\]$/.test(l) && !/^\(.*\)$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

async function download(url: string, file: string, progress: (fraction: number | undefined, total?: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || undefined;
  let got = 0;
  let shown = 0;
  const part = `${file}.part`;
  const body = Readable.fromWeb(res.body as any);
  body.on('data', (c: Buffer) => {
    got += c.length;
    if (total && got - shown > total / 50) {
      shown = got;
      progress(got / total, total);
    }
  });
  progress(total ? 0 : undefined, total);
  await pipeline(body, fs.createWriteStream(part));
  fs.renameSync(part, file);
}

function run(cmd: string, args: string[], timeout = 300000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${String(stderr).trim().split(/\r?\n/).pop() || err.message}`)) : resolve(String(stdout)),
    ),
  );
}
