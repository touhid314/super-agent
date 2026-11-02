import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountPool } from '../src/core/agents/pool';
import type { RunRequest } from '../src/core/agents/runner';
import type { Account } from '../src/core/types';
import { Engine } from '../src/engine/engine';
import { chunks, FileStore, TelegramRelay } from '../src/telegram';

const acc = (id: string): Account => ({ id, kind: 'claude', label: id, home: null, role: 'master', createdAt: 0 });

/** A tiny stand-in for the Telegram Bot API. */
function fakeTelegram() {
  const inbox: { update_id: number; message: unknown }[] = [];
  const sent: { chat: number; text: string }[] = [];
  let id = 1;
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getUpdates') {
      if (!inbox.length) await new Promise((r) => setTimeout(r, 10));
      return ok(inbox.splice(0).filter((u) => u.update_id >= (body.offset ?? 0)));
    }
    if (method === 'sendMessage') {
      sent.push({ chat: body.chat_id, text: body.text });
      return ok({ message_id: sent.length });
    }
    return ok(true);
  }) as typeof globalThis.fetch;
  const say = (chat: number, text: string) => inbox.push({ update_id: id++, message: { chat: { id: chat }, text } });
  return { fetch, sent, say };
}

function setup(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-tg-'))) {
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const runs: RunRequest[] = [];
  let relay!: TelegramRelay;
  const engine = new Engine({
    config: { accounts: [acc('a')], settings: { taskTimeoutMin: 5 } } as never,
    pool: new AccountPool(),
    dataDir: dir,
    cliPath: () => 'fake',
    runAgent: async (req) => {
      runs.push(req);
      return { code: 0, finalText: `reply to: ${req.prompt.split('\n').pop()}`, sessionId: 's', rateLimited: false, cancelled: false, timedOut: false };
    },
    cancelRun: () => undefined,
    usageLoad: () => 0,
    usageResetAt: () => undefined,
    autonomy: () => 'standard',
    onChange: () => undefined,
    onOutput: () => undefined,
    onFinished: (t, outcome) => void relay.onFinished(t, outcome),
  });
  const tg = fakeTelegram();
  relay = new TelegramRelay({
    engine,
    store: new FileStore(path.join(dir, 'telegram.json')),
    lockFile: path.join(dir, 'telegram.lock'),
    cwd: () => cwd,
    attachmentDir: () => cwd,
    agentName: () => 'Opus 9',
    team: { members: () => [], toggle: () => undefined, makeLead: () => undefined, models: async () => [], setModel: () => undefined },
    log: () => undefined,
    onChange: () => undefined,
    fetch: tg.fetch,
  });
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { dir, engine, relay, tg, runs, until };
}

describe('Telegram relay', () => {
  it('pairs only with the code, refuses strangers, and relays messages and replies', async () => {
    const h = setup();
    h.relay.start('123:token');
    const code = h.relay.pairCode!;
    expect(code).toMatch(/^\d{6}$/);
    h.tg.say(7, 'hello?');
    await h.until(() => h.tg.sent.length === 1);
    expect(h.tg.sent[0].text).toMatch(/send the 6-digit code/);
    expect(h.runs).toHaveLength(0);

    h.tg.say(7, `/start ${code}`);
    await h.until(() => h.relay.state === 'on');
    expect(h.relay.chatId).toBe(7);

    h.tg.say(99, 'let me in');
    await h.until(() => h.tg.sent.some((s) => s.chat === 99));
    expect(h.tg.sent.find((s) => s.chat === 99)!.text).toBe('This bot is private.');

    h.tg.say(7, 'fix the login bug');
    await h.until(() => h.tg.sent.some((s) => s.text.includes('reply to:')));
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].prompt).toContain('fix the login bug');
    expect(h.tg.sent.at(-1)).toEqual({ chat: 7, text: '<b>Opus 9</b>\n\nreply to: fix the login bug' });

    // The next message continues the same thread (and its CLI session).
    h.tg.say(7, 'now add a test');
    await h.until(() => h.runs.length === 2 && h.engine.threads[0].status === 'idle');
    expect(h.engine.threads).toHaveLength(1);
    expect(h.runs[1].resume).toBe('s');

    h.tg.say(7, '/new');
    h.tg.say(7, 'something else');
    await h.until(() => h.engine.threads.length === 2);
    h.relay.stop();
  });

  it('the code shown in one VS Code window pairs through whichever window answers the bot (typed code works too)', async () => {
    const shown = setup();
    shown.relay.ensurePairCode();
    const code = shown.relay.pairCode!;
    // A second window shares the data folder (and so the store) but is the one polling Telegram.
    const polling = setup(shown.dir);
    polling.relay.start('123:token');
    expect(polling.relay.pairCode).toBe(code); // the shown code is kept, not replaced
    polling.tg.say(5, code);
    await polling.until(() => polling.relay.chatId === 5);
    expect(shown.relay.chatId).toBe(5);
    expect(shown.relay.pairCode).toBeUndefined();
    polling.relay.stop();
  });

  it('turning it off and on again keeps the pairing, and sends nothing while off', async () => {
    const h = setup();
    h.relay.start('123:token');
    h.tg.say(7, `/start ${h.relay.pairCode}`);
    await h.until(() => h.relay.state === 'on');
    h.relay.stop(); // one tap off
    expect(h.relay.state).toBe('off');
    const t = h.engine.send(undefined, 'work while Telegram is off', h.dir);
    await h.until(() => t.status === 'idle' && t.messages.some((m) => m.role === 'agent'));
    const sent = h.tg.sent.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.tg.sent.length).toBe(sent); // nothing streamed to the chat
    h.relay.start('123:token'); // one tap on: no new pairing
    expect(h.relay.state).toBe('on');
    expect(h.relay.chatId).toBe(7);
    expect(h.relay.pairCode).toBeUndefined();
    h.relay.stop();
  });

  it('splits long replies to fit Telegram messages', () => {
    const parts = chunks(`${'a'.repeat(3000)}\n${'b'.repeat(3000)}`);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });
});
