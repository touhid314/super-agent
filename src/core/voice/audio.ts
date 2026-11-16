import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpusDecoder } from 'opus-decoder';
import { log } from '../log';
import { Whisper, type Progress } from './whisper';

/** Packets of an Ogg stream (RFC 3533): page segments joined, a 255-byte lacing value continues the packet. */
export function oggPackets(buf: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  let at = 0;
  while (at + 27 <= buf.length) {
    if (buf[at] !== 0x4f || buf[at + 1] !== 0x67 || buf[at + 2] !== 0x67 || buf[at + 3] !== 0x53) throw new Error('Not an Ogg file');
    const segments = buf[at + 26];
    const lacing = buf.subarray(at + 27, at + 27 + segments);
    let body = at + 27 + segments;
    for (const len of lacing) {
      parts.push(buf.subarray(body, body + len));
      body += len;
      if (len < 255) {
        const total = parts.reduce((n, p) => n + p.length, 0);
        const packet = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          packet.set(p, o);
          o += p.length;
        }
        packets.push(packet);
        parts = [];
      }
    }
    at = body;
  }
  return packets;
}

/** A WAV file of 16-bit PCM, mono. */
export function wavFile(samples: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return out;
}

/**
 * An Ogg/Opus recording (what Telegram voice notes are) as a 16 kHz mono WAV, which is what whisper.cpp reads.
 * Decoded in-process (WebAssembly), so no ffmpeg is needed.
 */
export async function oggOpusToWav(buf: Uint8Array): Promise<Buffer> {
  const [head, , ...audio] = oggPackets(buf);
  if (!head || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') throw new Error('Not an Opus recording');
  const channels = head[9];
  const preSkip = head[10] | (head[11] << 8);
  if (channels > 2) throw new Error('Multichannel Opus is not supported');
  const decoder = new OpusDecoder({ sampleRate: 16000, channels, preSkip });
  await decoder.ready;
  try {
    const { channelData, samplesDecoded } = decoder.decodeFrames(audio);
    const mono = new Float32Array(samplesDecoded);
    for (const ch of channelData) for (let i = 0; i < samplesDecoded; i++) mono[i] += ch[i] / channelData.length;
    return wavFile(mono, 16000);
  } finally {
    decoder.free();
  }
}

/** Formats whisper.cpp reads as they are. */
const DIRECT = /\.(wav|mp3|flac)$/i;

/**
 * Speech in an audio message (a Telegram voice note or audio file) to text, on this machine with Whisper. The first
 * use downloads whisper.cpp and the model; `progress` reports that.
 */
export function createTranscriber(dataDir: string, model: () => string) {
  const whisper = new Whisper(dataDir, model);
  let installing: Promise<void> | undefined;
  return {
    /** Needs a one-time download first. */
    needsSetup: () => whisper.missing().length > 0,
    async transcribe(audio: Uint8Array, name: string, prompt: string, progress: Progress = () => undefined): Promise<string> {
      if (whisper.missing().length) {
        installing ??= whisper.install(progress).finally(() => (installing = undefined));
        await installing;
      }
      const ogg = /\.(ogg|oga|opus)$/i.test(name) || (audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53);
      if (!ogg && !DIRECT.test(name)) throw new Error('This audio format is not supported: send a voice note, or an OGG, MP3, WAV or FLAC file.');
      const file = path.join(os.tmpdir(), `super-agent-voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ogg ? '.wav' : path.extname(name)}`);
      try {
        fs.writeFileSync(file, ogg ? await oggOpusToWav(audio) : audio);
        const text = await whisper.transcribe(file, prompt);
        log('voice', `transcribed ${name} (${audio.length} bytes): ${text.length} characters`);
        return text;
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  };
}

export type Transcriber = ReturnType<typeof createTranscriber>;
