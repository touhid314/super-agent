import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { oggOpusToWav, oggPackets } from '../src/core/voice/audio';

describe('Telegram voice notes to WAV for Whisper', () => {
  it('decodes an Ogg/Opus voice note to 16 kHz mono 16-bit WAV', async () => {
    const wav = await oggOpusToWav(fs.readFileSync('tests/fixtures/voice-note.ogg'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    const seconds = wav.readUInt32LE(40) / 2 / 16000;
    expect(seconds).toBeGreaterThan(2.8);
    expect(seconds).toBeLessThan(3.1);
    // Speech, not silence.
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    expect(peak).toBeGreaterThan(3000);
  });

  it('splits Ogg pages into packets and rejects other data', () => {
    const packets = oggPackets(fs.readFileSync('tests/fixtures/voice-note.ogg'));
    expect(Buffer.from(packets[0].subarray(0, 8)).toString()).toBe('OpusHead');
    expect(Buffer.from(packets[1].subarray(0, 8)).toString()).toBe('OpusTags');
    expect(() => oggPackets(new Uint8Array(64))).toThrow('Not an Ogg file');
  });
});
