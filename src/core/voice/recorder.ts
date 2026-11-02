import fs from 'node:fs';
import { PvRecorder } from '@picovoice/pvrecorder-node';

/** Longest dictation kept (then it stops by itself). */
const MAX_SECONDS = 5 * 60;

/**
 * Microphone capture in the extension host (VS Code panels can't use the mic): 16 kHz mono 16-bit PCM, which is
 * what Whisper takes. PvRecorder (Picovoice, Apache-2.0) is the same native recorder the Codex extension uses.
 */
export class MicRecorder {
  private rec: PvRecorder | null = null;
  private frames: Int16Array[] = [];
  private loop: Promise<void> | null = null;
  startedAt = 0;

  get recording(): boolean {
    return !!this.rec;
  }

  /** `onLevel`: loudness 0–1 about ten times a second (for the mic animation); `onLimit`: hit the length cap. */
  start(onLevel: (level: number) => void, onLimit: () => void): void {
    if (this.rec) return;
    const rec = new PvRecorder(512); // default input device
    rec.start();
    this.rec = rec;
    this.frames = [];
    this.startedAt = Date.now();
    let sinceLevel = 0;
    this.loop = (async () => {
      while (this.rec === rec) {
        const frame = await rec.read().catch(() => null);
        if (!frame || this.rec !== rec) break;
        this.frames.push(frame);
        sinceLevel += frame.length;
        if (sinceLevel >= rec.sampleRate / 10) {
          sinceLevel = 0;
          onLevel(rms(frame));
        }
        if (this.frames.length * rec.frameLength >= MAX_SECONDS * rec.sampleRate) {
          onLimit();
          break;
        }
      }
    })();
  }

  /** Stops and writes the recording as a WAV file; false if nothing was recorded. */
  async stop(wavFile?: string): Promise<boolean> {
    const rec = this.rec;
    if (!rec) return false;
    this.rec = null;
    await this.loop?.catch(() => undefined);
    const rate = rec.sampleRate;
    rec.stop();
    rec.release();
    const frames = this.frames;
    this.frames = [];
    if (!wavFile || !frames.length) return false;
    fs.writeFileSync(wavFile, wav(frames, rate));
    return true;
  }
}

function rms(frame: Int16Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.min(1, Math.sqrt(sum / frame.length) / 8000);
}

/** 16-bit mono PCM frames as a WAV file. */
export function wav(frames: Int16Array[], sampleRate: number): Buffer {
  const samples = frames.reduce((n, f) => n + f.length, 0);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  let o = 44;
  for (const f of frames) for (const s of f) (buf.writeInt16LE(s, o), (o += 2));
  return buf;
}
