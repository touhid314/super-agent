import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wav } from '../src/core/voice/recorder';
import { Whisper, cleanTranscript } from '../src/core/voice/whisper';

describe('voice input', () => {
  it('writes 16 kHz mono 16-bit WAV that Whisper reads', () => {
    const buf = wav([Int16Array.from([0, 1000, -1000]), Int16Array.from([32767])], 16000);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.readUInt16LE(34)).toBe(16); // bits
    expect(buf.readUInt32LE(40)).toBe(8); // 4 samples × 2 bytes
    expect([buf.readInt16LE(44), buf.readInt16LE(46), buf.readInt16LE(48), buf.readInt16LE(50)]).toEqual([0, 1000, -1000, 32767]);
  });

  it("keeps what was said, without whisper's silence and sound markers", () => {
    expect(cleanTranscript(' Please refactor the login dialog\n in maingui.py.\n[BLANK_AUDIO]\n(wind blowing)\n')).toBe('Please refactor the login dialog in maingui.py.');
    expect(cleanTranscript('[BLANK_AUDIO]\n')).toBe('');
  });

  it('knows what still has to be downloaded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-voice-'));
    const w = new Whisper(dir, () => 'base.en');
    expect(w.missing()).toEqual(['program', 'model']);
    fs.mkdirSync(path.join(dir, 'whisper', 'bin', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'whisper', 'bin', 'Release', 'whisper-cli.exe'), '');
    fs.writeFileSync(path.join(dir, 'whisper', 'ggml-base.en.bin'), '');
    expect(w.missing()).toEqual([]);
  });
});
