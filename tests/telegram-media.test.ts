import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../src/engine/engine';
import type { Thread } from '../src/engine/types';
import { TelegramRelay } from '../src/telegram';
import { MAX_UPLOAD_BYTES, mediaIn } from '../src/telegram-media';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-media-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, content = 'media bytes') => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { dir, write };
}

function relayHarness(text: string, cwd: string, rejection?: (method: string) => { code: number; status?: number } | undefined) {
  const t: Thread = { id: 't', title: 'Create media', cwd, status: 'idle', queue: [], createdAt: 0, updatedAt: 0,
    messages: [{ role: 'agent', text, at: 1 }] };
  const store = new Map<string, unknown>([['telegram.chat', 7], ['telegram.thread', 't'], ['telegram.threads', ['t']]]);
  const uploads: { method: string; body: FormData }[] = [];
  const messages: string[] = [];
  const log = vi.fn();
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    if (method === 'getUpdates') return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    if (init?.body instanceof FormData) {
      uploads.push({ method, body: init.body });
      const failure = rejection?.(method);
      if (failure) return new Response(JSON.stringify({ ok: false, description: 'media rejected', error_code: failure.code }), { status: failure.status ?? failure.code });
    } else if (method === 'sendMessage') messages.push(JSON.parse(String(init?.body)).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof globalThis.fetch;
  const relay = new TelegramRelay({
    engine: { get: () => t, threads: [t] } as unknown as Engine,
    store: { get: <T>(key: string) => store.get(key) as T | undefined, update: (key, value) => { store.set(key, value); } },
    lockFile: path.join(cwd, 'telegram.lock'), cwd: () => cwd, attachmentDir: () => cwd,
    agentName: () => 'Agent', log, onChange: () => undefined, fetch,
    team: { members: () => [], toggle: () => undefined, makeLead: () => undefined, models: async () => [], setModel: () => undefined },
  });
  cleanups.push(() => relay.stop());
  relay.start('123:test-token');
  return { relay, t, store, uploads, messages, log };
}

describe('media references in agent replies', () => {
  it('resolves links, inline code, Unicode/spaces/parentheses and encoded paths, without duplicates', () => {
    const h = workspace();
    const video = h.write('output/lesson (final) 数学.mp4');
    const photo = h.write('output/screen shot.png');
    const bare = h.write('simple.jpg');
    const text = `[Video](<${video.replace(/\\/g, '/')}>)\n![Preview](${pathToFileURL(photo).href})\n` +
      `[Relative](<./output/lesson (final) 数学.mp4>)\n\`${video}\`\n\`${pathToFileURL(photo).href}\`\nHere is simple.jpg.\n`;
    expect(mediaIn(text, h.dir)).toEqual([video, photo, bare].map(f => fs.realpathSync(f)));
  });

  it('does not scan unmentioned files, upload remote media, or process code-block examples', () => {
    const h = workspace();
    h.write('secret.png');
    h.write('example.mp4');
    fs.mkdirSync(path.join(h.dir, 'directory.png'));
    expect(mediaIn('![remote](https://example.com/secret.png)\n[secret.png](https://example.com/secret.png)\nhttps://secret.png\n![network](//example.com/secret.png)\n[missing](missing.mp4)\n`directory.png`\n```md\n[example](example.mp4)\n```', h.dir)).toEqual([]);
  });
});

describe('Telegram outgoing media', () => {
  it('uploads a photo and playable video to the paired chat, with the correct multipart fields and bytes', async () => {
    const h = workspace();
    h.write('preview.png', 'png content');
    h.write('lesson.mp4', 'mp4 content');
    const r = relayHarness('![Preview](preview.png)\n[Lesson](lesson.mp4)', h.dir);
    await r.relay.onFinished(r.t, 'done');
    expect(r.uploads.map(u => u.method)).toEqual(['sendPhoto', 'sendVideo']);
    expect(r.uploads.every(u => u.body.get('chat_id') === '7')).toBe(true);
    const photo = r.uploads[0].body.get('photo') as File;
    const video = r.uploads[1].body.get('video') as File;
    expect([photo.name, photo.type, await photo.text()]).toEqual(['preview.png', 'image/png', 'png content']);
    expect([video.name, video.type, await video.text()]).toEqual(['lesson.mp4', 'video/mp4', 'mp4 content']);
    expect(r.uploads[1].body.get('supports_streaming')).toBe('true');
  });

  it('falls back to the original document when Telegram rejects a media preview, including HTTP-200 API errors', async () => {
    const h = workspace();
    h.write('lesson.mp4');
    const r = relayHarness('[Lesson](lesson.mp4)', h.dir, method => method === 'sendVideo' ? { code: 400, status: 200 } : undefined);
    await r.relay.onFinished(r.t, 'done');
    expect(r.uploads.map(u => u.method)).toEqual(['sendVideo', 'sendDocument']);
    expect((r.uploads[1].body.get('document') as File).name).toBe('lesson.mp4');
    expect(r.messages.some(m => m.includes('Could not send'))).toBe(false);
  });

  it('sends unsupported formats and large photos as original files', async () => {
    const h = workspace();
    h.write('animation.gif');
    const large = h.write('large.png');
    fs.truncateSync(large, 11 * 1024 * 1024);
    const r = relayHarness('`animation.gif` and `large.png`', h.dir);
    await r.relay.onFinished(r.t, 'done');
    expect(r.uploads.map(u => u.method)).toEqual(['sendDocument', 'sendDocument']);
  });

  it('reports oversized, empty, and API-rejected files while continuing with the next attachment', async () => {
    const h = workspace();
    fs.truncateSync(h.write('huge.mp4'), MAX_UPLOAD_BYTES + 1);
    h.write('empty.png', '');
    h.write('good.jpg');
    const r = relayHarness('`huge.mp4` `empty.png` `good.jpg`', h.dir, () => ({ code: 403 }));
    await r.relay.onFinished(r.t, 'done');
    expect(r.uploads.map(u => u.method)).toEqual(['sendPhoto']); // no retry for permissions/auth errors
    expect(r.messages.filter(m => m.startsWith('Could not send'))).toHaveLength(3);
    expect(r.messages.some(m => m.includes('50 MB'))).toBe(true);
  });

  it('sends no media for disabled, untracked, helper, or failed threads', async () => {
    const h = workspace();
    h.write('lesson.mp4');
    const r = relayHarness('`lesson.mp4`', h.dir);
    r.t.helperFile = 'handoff.md';
    await r.relay.onFinished(r.t, 'done');
    r.t.helperFile = undefined;
    r.store.set('telegram.threads', []);
    r.store.set('telegram.thread', 'another');
    await r.relay.onFinished(r.t, 'done');
    r.store.set('telegram.thread', 't');
    await r.relay.onFinished(r.t, 'failed');
    r.relay.stop();
    await r.relay.onFinished(r.t, 'done');
    expect(r.uploads).toHaveLength(0);
  });

  it('limits outgoing attachments without silently hiding additional media', async () => {
    const h = workspace();
    const text = Array.from({ length: 6 }, (_, i) => { h.write(`${i}.jpg`); return `![${i}](${i}.jpg)`; }).join('\n');
    const r = relayHarness(text, h.dir);
    await r.relay.onFinished(r.t, 'done');
    expect(r.uploads).toHaveLength(5);
    expect(r.messages.some(m => m.includes('1 more') && m.includes('/files'))).toBe(true);
  });

  it('does not redirect an in-flight answer to a newly paired chat', async () => {
    const h = workspace();
    h.write('lesson.mp4');
    const r = relayHarness('`lesson.mp4`', h.dir);
    const finishing = r.relay.onFinished(r.t, 'done');
    r.store.set('telegram.chat', 99);
    await finishing;
    expect(r.uploads).toHaveLength(0);
    expect(r.messages).toHaveLength(0);
  });
});
